import { parseCcd } from "./ccd.ts";
import { parseCue } from "./cue.ts";
import { fileKey, trackSource } from "./sources.ts";
import type { DiscReference, DiscSources, DiscTrack, ReadOptions, TrackLayout } from "./types.ts";

export const RAW_SECTOR = 2352;

export async function discTracks(
  sources: DiscSources,
  reference: DiscReference,
  warn: (message: string) => void,
  options: ReadOptions = {},
) {
  const descriptors = [...sources.values()].filter((source) => /\.(cue|ccd)$/i.test(source.name));
  if (descriptors.length > 1) throw new Error("Select only one disc CUE or CCD");
  let tracks: TrackLayout[];
  const descriptor = descriptors[0];
  if (descriptor) {
    if (descriptor.size > 65536) throw new Error("Disc descriptor is too large");
    const text = new TextDecoder().decode(await descriptor.read(0, descriptor.size, options));
    if (/\.ccd$/i.test(descriptor.name)) {
      const ccd = parseCcd(text, descriptor.name);
      const image = sources.get(fileKey(ccd.tracks[0]!.file));
      if (!image) throw new Error(`Required CloneCD image missing: ${ccd.tracks[0]!.file}`);
      if (image.size !== ccd.sectors * RAW_SECTOR)
        throw new Error("IMG length disagrees with CCD lead-out");
      tracks = ccd.tracks;
    } else tracks = parseCue(text);
  } else {
    const bins = [...sources.values()].filter((f) => /\.(bin|img)$/i.test(f.name));
    if (bins.length !== 1)
      throw new Error("Select CUE + BIN or CCD + IMG, or just one raw data image");
    tracks = reference.tracks.map((t, i) => ({ ...t, file: i ? t.file : bins[0]!.name }));
    warn("No CUE or CCD selected. Select the descriptor for music; missing audio is optional.");
  }
  let start = 0;
  const resolved: DiscTrack[] = [];
  const visitedFiles = new Set<string>();
  for (const [i, track] of tracks.entries()) {
    const key = fileKey(track.file);
    const previous = tracks[i - 1];
    const next = tracks[i + 1];
    const sharesPrevious = previous !== undefined && fileKey(previous.file) === key;
    const sharesNext = next !== undefined && fileKey(next.file) === key;
    if (!sharesPrevious && visitedFiles.has(key))
      throw new Error(`Disc descriptor reopens an image out of order: ${track.file}`);
    visitedFiles.add(key);
    const source = sources.get(key);
    if (!source && !track.audio) throw new Error(`Required data track missing: ${track.file}`);
    const canonical = reference.tracks.find((t) => t.number === track.number);
    const begin = sharesPrevious ? (track.index0 ?? track.index) : 0;
    const fallbackEnd =
      canonical === undefined
        ? undefined
        : sharesPrevious
          ? track.index + canonical.size / RAW_SECTOR - canonical.index
          : canonical.size / RAW_SECTOR;
    const end = sharesNext
      ? (next.index0 ?? next.index)
      : source
        ? source.size / RAW_SECTOR
        : fallbackEnd;
    if (
      (source && (!Number.isSafeInteger(source.size) || source.size % RAW_SECTOR !== 0)) ||
      end === undefined ||
      !Number.isSafeInteger(end) ||
      end <= begin ||
      track.index < begin ||
      track.index >= end ||
      (source && end > source.size / RAW_SECTOR)
    )
      throw new Error(`Invalid or unknown track boundaries: ${track.file}, track ${track.number}`);
    const pregap = track.pregap ?? 0;
    const index = pregap + track.index - begin;
    const sectors = pregap + end - begin;
    if (!Number.isSafeInteger(start + sectors)) throw new Error("Disc is too large");
    if (!source) warn(`Optional audio missing: ${track.file}`);
    resolved.push({
      ...track,
      index,
      ...(track.index0 === undefined ? {} : { index0: pregap + track.index0 - begin }),
      source: source
        ? trackSource(source, begin * RAW_SECTOR, (end - begin) * RAW_SECTOR, pregap * RAW_SECTOR)
        : undefined,
      start,
      end: start + sectors,
      toc: Math.floor((start + index + 150) / 75) * 75 - 150,
    });
    start += sectors;
  }
  return { tracks: resolved, leadout: Math.floor((start + 150) / 75) * 75 - 150 };
}
