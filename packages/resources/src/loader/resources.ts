import discReference from "../../../../config/disc.json";
import type { ResourceCandidate } from "../compatibility/index.ts";
import { Disc } from "./disc.ts";
import { checkRange } from "./sources.ts";
import { discTracks, RAW_SECTOR } from "./tracks.ts";
import type { DiscSource, DiscSources } from "./types.ts";

const maxResourceBytes = 128 * 1024 * 1024;

async function readRange(source: DiscSource, offset: number, size: number, signal: AbortSignal) {
  checkRange(source.size, offset, size);
  if (size > maxResourceBytes) throw new Error("Resource exceeds the 128 MiB inspection limit");
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 1024 * 1024) {
    signal.throwIfAborted();
    const count = Math.min(1024 * 1024, size - at);
    const chunk = await source.read(offset + at, count, { signal });
    if (chunk.length !== count) throw new Error("Truncated resource");
    bytes.set(chunk, at);
  }
  return bytes;
}

// Disc layout support is independent of resource compatibility.
export async function discoverResources(sources: DiscSources, signal: AbortSignal) {
  const notices: string[] = [];
  const { tracks } = await discTracks(sources, discReference, (notice) => notices.push(notice), {
    signal,
  });
  signal.throwIfAborted();
  const first = tracks[0]!;
  const source = first.source!;
  const disc = new Disc(source, first.index);
  const entries = await disc.entries();
  signal.throwIfAborted();
  const resources: ResourceCandidate[] = entries
    .filter(
      (entry) =>
        entry.path.toUpperCase() === "/SCUS_945.60" || /\.(MR|IMG|TIM|VAB|STR)$/i.test(entry.path),
    )
    .map((entry) => {
      const raw = /\.STR$/i.test(entry.path);
      return {
        id: entry.path.toUpperCase(),
        size: entry.size,
        async read(signal: AbortSignal) {
          if (entry.size > maxResourceBytes)
            throw new Error("Resource exceeds the 128 MiB inspection limit");
          return raw
            ? readRange(
                source,
                (first.index + entry.lba) * RAW_SECTOR,
                Math.ceil(entry.size / 2048) * RAW_SECTOR,
                signal,
              )
            : disc.read(entry.lba, entry.size, { signal });
        },
      };
    });
  for (const track of tracks) {
    if (!track.audio) continue;
    const audio = track.source;
    if (!audio) continue;
    const end = audio.size;
    const offset = track.index * RAW_SECTOR;
    resources.push({
      id: `AUDIO/${String(track.number).padStart(2, "0")}`,
      size: end - offset,
      read: (signal) => readRange(audio, offset, end - offset, signal),
    });
  }
  return { resources, notices };
}
