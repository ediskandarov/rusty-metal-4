import { fileKey } from "./sources.ts";
import type { TrackLayout } from "./types.ts";

type Section = Map<string, string>;

function sections(text: string) {
  const result = new Map<string, Section>();
  let current: Section | undefined;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const name = header[1]!.trim().toUpperCase();
      if (result.has(name)) throw new Error(`Duplicate CCD section: ${name}`);
      current = new Map();
      result.set(name, current);
      continue;
    }
    const field = /^([^=]+)=(.*)$/.exec(line);
    if (!current || !field) throw new Error(`Invalid CCD line: ${line}`);
    const key = field[1]!.trim().toUpperCase();
    if (current.has(key)) throw new Error(`Duplicate CCD field: ${key}`);
    current.set(key, field[2]!.trim());
  }
  return result;
}

function integer(section: Section | undefined, key: string) {
  const value = section?.get(key);
  if (value === undefined || !/^(?:-?\d+|0x[\da-f]+)$/i.test(value))
    throw new Error(`Missing or invalid CCD ${key}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid CCD ${key}`);
  return number;
}

export function parseCcd(text: string, filename: string) {
  fileKey(filename);
  const data = sections(text);
  if (integer(data.get("CLONECD"), "VERSION") !== 3)
    throw new Error("Only CloneCD version 3 is supported");
  const disc = data.get("DISC");
  if (integer(disc, "SESSIONS") !== 1) throw new Error("Multisession CloneCD is not supported");
  if (integer(disc, "DATATRACKSSCRAMBLED") !== 0)
    throw new Error("Scrambled CloneCD data tracks are not supported");
  const file = filename.replace(/\.ccd$/i, ".img");
  const trackSections = [...data.entries()].filter(([name]) => /^TRACK \d+$/.test(name));
  trackSections.sort(([a], [b]) => Number(a.slice(6)) - Number(b.slice(6)));
  if (!trackSections.length || trackSections.length > 99)
    throw new Error("Invalid CCD track count");
  const tracks: TrackLayout[] = trackSections.map(([name, section], i) => {
    const number = Number(name.slice(6));
    const index = integer(section, "INDEX 1");
    const index0 = section.has("INDEX 0") ? integer(section, "INDEX 0") : undefined;
    if (number !== i + 1 || integer(section, "MODE") !== (i === 0 ? 2 : 0))
      throw new Error("CCD must contain one MODE2 data track, then consecutive audio tracks");
    if (index < 0 || (index0 !== undefined && (index0 < 0 || index0 > index)))
      throw new Error(`Invalid CCD index in track ${number}`);
    return { number, audio: i > 0, file, index, ...(index0 === undefined ? {} : { index0 }) };
  });
  const entries = [...data.entries()].filter(([name]) => /^ENTRY \d+$/.test(name));
  if (entries.length !== integer(disc, "TOCENTRIES"))
    throw new Error("CCD TOC entry count mismatch");
  const toc = new Map<number, Section>();
  for (const [, entry] of entries) {
    const point = integer(entry, "POINT");
    if (integer(entry, "SESSION") !== 1 || toc.has(point)) throw new Error("Invalid CCD TOC");
    toc.set(point, entry);
  }
  if (integer(toc.get(0xa0), "PMIN") !== 1 || integer(toc.get(0xa1), "PMIN") !== tracks.length)
    throw new Error("CCD TOC track count mismatch");
  for (const track of tracks) {
    const entry = toc.get(track.number);
    if (integer(entry, "PLBA") !== track.index || !!(integer(entry, "CONTROL") & 4) === track.audio)
      throw new Error(`CCD TOC disagrees with track ${track.number}`);
  }
  const sectors = integer(toc.get(0xa2), "PLBA");
  if (sectors <= tracks.at(-1)!.index) throw new Error("Invalid CCD lead-out");
  return { tracks, sectors };
}
