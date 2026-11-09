import { fileKey } from "./sources.ts";
import type { TrackLayout } from "./types.ts";
export function parseCue(text: string): TrackLayout[] {
  const tracks: TrackLayout[] = [];
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
