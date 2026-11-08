import { fileKey } from "./sources.ts";
import type { CueTrack, DiscReference, DiscSources, DiscTrack } from "./types.ts";
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
      const fileName = file;
      if (tracks.some((t) => t.file.toLowerCase() === fileName.toLowerCase()))
        throw new Error("Use the multi-file CUE/BIN dump (one BIN per track)");
      tracks.push({
        number: Number(match[1]),
        index: -1,
        audio: match[2]!.toUpperCase() === "AUDIO",
        file,
      });
    } else if ((match = /^INDEX (00|01) (\d+):(\d+):(\d+)$/i.exec(line))) {
      if (!tracks.length || Number(match[3]) >= 60 || Number(match[4]) >= 75)
        throw new Error("Invalid CUE INDEX");
      if (match[1] === "01")
        tracks.at(-1)!.index = (Number(match[2]) * 60 + Number(match[3])) * 75 + Number(match[4]);
    } else throw new Error(`Unsupported CUE directive: ${line}`);
  }
  if (!tracks.length || tracks.length > 99) throw new Error("Invalid CUE track count");
  tracks.forEach((track, i) => {
    if (
      track.number !== i + 1 ||
      track.audio !== i > 0 ||
      !Number.isSafeInteger(track.index) ||
      track.index < 0
    )
      throw new Error("Expected one data track, then consecutive audio tracks with INDEX 01");
  });
  return tracks;
}
export async function discTracks(
  sources: DiscSources,
  reference: DiscReference,
  warn: (message: string) => void,
) {
  const cues = [...sources.values()].filter((f) => /\.cue$/i.test(f.name));
  if (cues.length > 1) throw new Error("Select only one disc CUE");
  let tracks: CueTrack[];
  if (cues.length) {
    if (cues[0]!.size > 65536) throw new Error("CUE file is too large");
    tracks = parseCue(new TextDecoder().decode(await cues[0]!.read(0, cues[0]!.size)));
  } else {
    const bins = [...sources.values()].filter((f) => /\.bin$/i.test(f.name));
    if (bins.length !== 1)
      throw new Error("Select the CUE together with the BIN tracks, or just the data BIN");
    tracks = reference.tracks.map((t, i) => ({ ...t, file: i ? t.file : bins[0]!.name }));
    warn("No CUE selected. Using the original audio layout; missing audio is optional.");
  }
  let start = 0;
  const resolved: DiscTrack[] = [];
  for (const track of tracks) {
    const source = sources.get(fileKey(track.file));
    if (!source && !track.audio) throw new Error(`Required data track missing: ${track.file}`);
    const canonical = reference.tracks.find((t) => t.number === track.number);
    const size = source?.size ?? canonical?.size;
    if (
      size === undefined ||
      !Number.isSafeInteger(size) ||
      size % RAW_SECTOR ||
      track.index >= size / RAW_SECTOR
    )
      throw new Error(`Invalid or unknown track length: ${track.file}`);
    if (!source) warn(`Optional audio missing: ${track.file}`);
    resolved.push({
      ...track,
      source,
      start,
      end: start + size / RAW_SECTOR,
      toc: Math.floor((start + track.index + 150) / 75) * 75 - 150,
    });
    start += size / RAW_SECTOR;
  }
  return { tracks: resolved, leadout: Math.floor((start + 150) / 75) * 75 - 150 };
}
