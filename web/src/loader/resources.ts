import discReference from "../../../config/disc.json";
import type { ResourceCandidate } from "../compatibility/index.ts";
import { discTracks, parseCue, RAW_SECTOR } from "./cue.ts";
import { Disc } from "./disc.ts";
import { checkRange, fileKey } from "./sources.ts";
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
  const cues = [...sources.values()].filter((source) => /\.cue$/i.test(source.name));
  if (cues.length > 1) throw new Error("Select only one disc CUE");
  let tracks;
  if (cues.length) {
    const cue = cues[0]!;
    if (cue.size > 65536) throw new Error("CUE file is too large");
    tracks = parseCue(new TextDecoder().decode(await cue.read(0, cue.size, { signal })));
    if (new Set(tracks.map((track) => fileKey(track.file))).size !== tracks.length)
      notices.push(
        "Single-BIN disc: resource inspection is available; playback still requires one BIN per track.",
      );
  } else {
    tracks = (await discTracks(sources, discReference, () => {})).tracks;
    notices.push("No CUE: audio track positions use the original disc layout.");
  }
  signal.throwIfAborted();
  const first = tracks[0]!;
  const source = sources.get(fileKey(first.file));
  if (!source) throw new Error(`Required data track missing: ${first.file}`);
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
  for (const [index, track] of tracks.entries()) {
    if (!track.audio) continue;
    const audio = sources.get(fileKey(track.file));
    if (!audio) continue; // Reference entries below distinguish absent tracks from unverified ones.
    const next = tracks[index + 1];
    const end =
      next && fileKey(next.file) === fileKey(track.file)
        ? (next.index0 ?? next.index) * RAW_SECTOR
        : audio.size;
    const offset = track.index * RAW_SECTOR;
    resources.push({
      id: `AUDIO/${String(track.number).padStart(2, "0")}`,
      size: end - offset,
      read: (signal) => readRange(audio, offset, end - offset, signal),
    });
  }
  return { resources, notices };
}
