import reference from "../../../config/disc.json";
import { checkResource, requireResources, resourceReference } from "../compatibility/index.ts";
import { Disc } from "./disc.ts";
import { discTracks } from "./tracks.ts";
import type { DiscAssets, DiscSources, LoaderProgress } from "./types.ts";
export async function loadDisc(
  sources: DiscSources,
  { progress = () => {}, warn = () => {} }: LoaderProgress = {},
): Promise<DiscAssets> {
  progress("Reading disc directory…");
  const { tracks, leadout } = await discTracks(sources, reference, warn);
  const first = tracks[0];
  if (!first?.source) throw new Error("Required data track missing");
  const disc = new Disc(first.source, first.index);
  const entries = await disc.entries();
  const candidates = entries
    .filter(
      (entry) =>
        entry.path.toUpperCase() === "/SCUS_945.60" || /\.(MR|IMG|TIM|VAB|STR)$/i.test(entry.path),
    )
    .map((entry) => ({ id: entry.path.toUpperCase(), size: entry.size }));
  requireResources(candidates, resourceReference);
  const available = new Set(candidates.map((entry) => entry.id));
  const expected = new Map(resourceReference.map((entry) => [entry.id, entry]));
  const data = entries.filter(
    (e) =>
      e.path.toUpperCase() === "/SCUS_945.60" || /^\/DATA\/.+\.(MR|IMG|TIM|VAB)$/i.test(e.path),
  );
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const manifest = [];
  for (const [i, entry] of data.entries()) {
    progress(`Reading ${entry.path} (${i + 1}/${data.length})…`);
    if (entry.path.toUpperCase() === "/SCUS_945.60" && entry.size > 4 * 1024 * 1024)
      throw new Error("Main EXE is too large");
    const bytes = await disc.read(entry.lba, entry.size);
    const result = await checkResource({
      id: entry.path.toUpperCase(),
      bytes,
      available,
      reference: expected.get(entry.path.toUpperCase()),
    });
    if (result.status === "uncompatible") throw new Error(`${entry.path}: ${result.message}`);
    if (result.status === "warning") warn(`${entry.path}: ${result.message}`);
    if (entry.path.toUpperCase() === "/SCUS_945.60") continue;
    files.set(entry.path.toUpperCase(), bytes);
    manifest.push(`${entry.lba}\t${entry.size}\t${entry.path}`);
  }
  files.set("/DATA/files.tsv", new TextEncoder().encode(manifest.join("\n") + "\n"));
  const movies = new Map(
    entries
      .filter((e) => /\.STR$/i.test(e.path))
      .map((e) => [e.path.split("/").at(-1)!.toUpperCase(), e]),
  );
  return {
    files,
    tracks,
    leadout,
    async readAudio(number) {
      const track = tracks.find((t) => t.number === number && t.audio);
      if (!track?.source) throw new Error(`Audio track ${number} is unavailable`);
      return track.source.read(0, track.source.size);
    },
    async readMovie(name, options) {
      const entry = movies.get(`${name.toUpperCase()}.STR`);
      if (!entry) throw new Error(`Optional movie ${name} is unavailable`);
      return disc.raw(entry.lba, entry.size, options);
    },
  };
}
