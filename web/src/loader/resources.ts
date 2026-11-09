import discReference from "../../../config/disc.json";
import { discTracks, parseCue, RAW_SECTOR } from "./cue.ts";
import { Disc } from "./disc.ts";
import { checkRange, fileKey } from "./sources.ts";
import type { DiscSource, DiscSources } from "./types.ts";
import { sha256 } from "./verify.ts";

export type ResourceStatus =
  "pending" | "checking" | "original" | "modified" | "missing" | "unknown" | "error";
export interface ResourceReference {
  id: string;
  size: number;
  sha256: string;
}
export interface ResourceCandidate {
  id: string;
  size: number;
  read?: (signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
}
export interface ResourceRow {
  id: string;
  size?: number;
  expected?: ResourceReference;
  status: ResourceStatus;
  hash?: string;
  error?: string;
}

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

// Discovery is independent of the executable gate: unsupported discs are still inspectable.
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

export function resourceRows(
  resources: ResourceCandidate[],
  reference: ResourceReference[],
): ResourceRow[] {
  const found = new Map(resources.map((resource) => [resource.id, resource]));
  const expected = new Map(reference.map((resource) => [resource.id, resource]));
  return [...new Set([...found.keys(), ...expected.keys()])]
    .sort((a, b) => (a === "/SCUS_945.60" ? -1 : b === "/SCUS_945.60" ? 1 : a.localeCompare(b)))
    .map((id) => ({
      id,
      size: found.get(id)?.size,
      expected: expected.get(id),
      status: found.has(id) ? "pending" : "missing",
    }));
}

export async function checkResources(
  resources: ResourceCandidate[],
  rows: ResourceRow[],
  signal: AbortSignal,
  changed: (row: ResourceRow) => void,
) {
  const found = new Map(resources.map((resource) => [resource.id, resource]));
  const priority = (row: ResourceRow) =>
    row.id === "/SCUS_945.60" ? 0 : row.id.startsWith("AUDIO/") || row.id.endsWith(".STR") ? 2 : 1;
  for (const row of [...rows].sort((a, b) => priority(a) - priority(b))) {
    if (row.status !== "pending") continue;
    signal.throwIfAborted();
    row.status = "checking";
    changed(row);
    try {
      const resource = found.get(row.id)!;
      if (!resource.read) throw new Error("Resource is not readable");
      const bytes = await resource.read(signal);
      signal.throwIfAborted();
      row.hash = await sha256(bytes);
      signal.throwIfAborted();
      row.status = !row.expected
        ? "unknown"
        : row.hash === row.expected.sha256 && row.size === row.expected.size
          ? "original"
          : "modified";
    } catch (error) {
      if (signal.aborted) {
        row.status = "pending";
        changed(row);
        throw error;
      }
      row.status = "error";
      row.error = error instanceof Error ? error.message : String(error);
    }
    changed(row);
    // Keep controls responsive, including when inspecting many tiny files.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
