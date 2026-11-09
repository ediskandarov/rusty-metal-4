import { fileKey, trackSource } from "./sources.ts";
import type { CueTrack, DiscReference, DiscSources, DiscTrack, ReadOptions } from "./types.ts";
export const RAW_SECTOR = 2352;
export function parseCue(text: string): CueTrack[] {
  const tracks: CueTrack[] = [];
  let file: string | undefined;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    let match;
    if (!line || /^REM(?:\s|$)/i.test(line)) continue;
    if ((match = /^FILE "([^"]+)" BINARY$/i.exec(line))) {
      fileKey(match[1]!);
      file = match[1]!;
    } else if ((match = /^TRACK (\d+) (AUDIO|MODE2\/2352)$/i.exec(line))) {
      if (!file) throw new Error("CUE TRACK without FILE");
      tracks.push({
        number: Number(match[1]),
        index: -1,
        audio: match[2]!.toUpperCase() === "AUDIO",
        file,
      });
    } else if ((match = /^INDEX (00|01) (\d+):(\d+):(\d+)$/i.exec(line))) {
      if (!tracks.length || Number(match[3]) >= 60 || Number(match[4]) >= 75)
        throw new Error("Invalid CUE INDEX");
      const index = (Number(match[2]) * 60 + Number(match[3])) * 75 + Number(match[4]);
      if (match[1] === "01") tracks.at(-1)!.index = index;
      else tracks.at(-1)!.index0 = index;
    } else if ((match = /^PREGAP (\d+):([0-5]\d):([0-6]\d|7[0-4])$/i.exec(line))) {
      if (!tracks.length) throw new Error("CUE metadata without TRACK");
      tracks.at(-1)!.pregap = (Number(match[1]) * 60 + Number(match[2])) * 75 + Number(match[3]);
    } else if (/^ISRC \S+$/i.test(line)) {
      if (!tracks.length) throw new Error("CUE metadata without TRACK");
    } else throw new Error(`Unsupported CUE directive: ${line}`);
  }
  if (!tracks.length || tracks.length > 99) throw new Error("Invalid CUE track count");
  tracks.forEach((track, i) => {
    if (
      track.number !== i + 1 ||
      track.audio !== i > 0 ||
      !Number.isSafeInteger(track.index) ||
      track.index < 0 ||
      (track.index0 !== undefined &&
        (!Number.isSafeInteger(track.index0) || track.index0 < 0 || track.index0 > track.index)) ||
      (track.pregap !== undefined && (!Number.isSafeInteger(track.pregap) || track.pregap < 0))
    )
      throw new Error("Expected one data track, then consecutive audio tracks with INDEX 01");
  });
  return tracks;
}
export async function discTracks(
  sources: DiscSources,
  reference: DiscReference,
  warn: (message: string) => void,
  options: ReadOptions = {},
) {
  const cues = [...sources.values()].filter((f) => /\.cue$/i.test(f.name));
  if (cues.length > 1) throw new Error("Select only one disc CUE");
  let tracks: CueTrack[];
  if (cues.length) {
    if (cues[0]!.size > 65536) throw new Error("CUE file is too large");
    tracks = parseCue(new TextDecoder().decode(await cues[0]!.read(0, cues[0]!.size, options)));
  } else {
    const bins = [...sources.values()].filter((f) => /\.bin$/i.test(f.name));
    if (bins.length !== 1)
      throw new Error("Select the CUE together with the BIN tracks, or just the data BIN");
    tracks = reference.tracks.map((t, i) => ({ ...t, file: i ? t.file : bins[0]!.name }));
    warn("No CUE selected. Using the original audio layout; missing audio is optional.");
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
      throw new Error(`CUE reopens a BIN out of order: ${track.file}`);
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
