import { expect, test } from "bun:test";

import { parseCcd } from "@tm4/resources/loader/ccd";
import { directorySources, localSources } from "@tm4/resources/loader/sources";
import { discTracks } from "@tm4/resources/loader/tracks";

import reference from "../../config/disc.json";

const ccd = `[CloneCD]
Version=3
[Disc]
Sessions=1
DataTracksScrambled=0
TocEntries=5
[Entry 0]
Session=1
Point=0xa0
PMin=1
[Entry 1]
Session=1
Point=0xa1
PMin=2
[Entry 2]
Session=1
Point=0xa2
PLBA=5
[Entry 3]
Session=1
Point=0x01
Control=0x04
PLBA=0
[Entry 4]
Session=1
Point=0x02
Control=0x00
PLBA=3
[TRACK 1]
MODE=2
INDEX 1=0
[TRACK 2]
MODE=0
INDEX 0=2
INDEX 1=3
`;

function disc(text = ccd, size = 5 * 2352) {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at++) bytes[at] = Math.floor(at / 2352);
  return [new File([text], "disc.CCD"), new File([bytes], "DISC.IMG")];
}

test("CloneCD parses sector indexes, TOC and paired image name", () => {
  const result = parseCcd("\uFEFF" + ccd.replaceAll("\n", "\r\n"), "disc.CCD");
  expect(result.sectors).toBe(5);
  expect(result.tracks).toEqual([
    { number: 1, audio: false, file: "disc.img", index: 0 },
    { number: 2, audio: true, file: "disc.img", index0: 2, index: 3 },
  ]);
});

test("CloneCD shares track slicing with CUE; SUB is optional and never read", async () => {
  const sources = directorySources([
    ...disc(),
    new File(["unused"], "disc.sub"),
    new File([], "cover.jpg"),
  ]);
  sources.get("disc.sub")!.read = () => {
    throw new Error("SUB must not be read");
  };
  const clone = await discTracks(sources, reference, () => {});
  sources.delete("disc.ccd");
  const cue =
    'FILE "DISC.IMG" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 00 00:00:02\nINDEX 01 00:00:03';
  sources.set("disc.cue", localSources([new File([cue], "disc.cue")]).get("disc.cue")!);
  const other = await discTracks(sources, reference, () => {});
  expect(clone.leadout).toBe(other.leadout);
  for (const [i, track] of clone.tracks.entries()) {
    const b = other.tracks[i]!;
    expect([track.start, track.end, track.index, track.toc]).toEqual([
      b.start,
      b.end,
      b.index,
      b.toc,
    ]);
    expect(await track.source!.read(0, track.source!.size)).toEqual(
      await b.source!.read(0, b.source!.size),
    );
  }
  const withoutSub = await discTracks(localSources(disc()), reference, () => {});
  expect(withoutSub.tracks).toHaveLength(2);
});

test("CloneCD rejects contradictory or unsupported descriptors", () => {
  for (const text of [
    ccd.replace("Sessions=1", "Sessions=2"),
    ccd.replace("DataTracksScrambled=0", "DataTracksScrambled=1"),
    ccd.replace("Version=3", "Version=4"),
    ccd.replace("MODE=2", "MODE=1"),
    ccd.replace("INDEX 0=2", "INDEX 0=4"),
    ccd.replace("INDEX 1=3", "INDEX 1=3oops"),
    ccd.replace("PLBA=3", "PLBA=4"),
    ccd.replace("TocEntries=5", "TocEntries=4"),
    ccd.replace("PMin=2", "PMin=3"),
    ccd.replace("PLBA=5", "PLBA=3"),
    ccd.replace("[TRACK 2]", "[TRACK 3]"),
    ccd.replace("Point=0x02", "Point=0x01"),
    ccd.replace("Control=0x00", "Control=0x04"),
    ccd + "[TRACK 2]\nMODE=0\n",
    ccd + "INDEX 1=3\n",
    ccd.replace("INDEX 1=3", "INDEX 1=9007199254740992"),
  ])
    expect(() => parseCcd(text, "disc.ccd")).toThrow();
});

test("CloneCD validates IMG presence, complete sector length and ambiguous descriptors", async () => {
  await expect(discTracks(localSources(disc().slice(0, 1)), reference, () => {})).rejects.toThrow(
    "image missing",
  );
  for (const size of [4 * 2352, 5 * 2352 + 1, 6 * 2352]) {
    await expect(discTracks(localSources(disc(ccd, size)), reference, () => {})).rejects.toThrow(
      "lead-out",
    );
  }
  await expect(
    discTracks(localSources([...disc(), new File([], "disc.cue")]), reference, () => {}),
  ).rejects.toThrow("only one");
});
