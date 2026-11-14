import { loadDisc } from "@tm4/resources/loader/loader";
import type { DiscSources } from "@tm4/resources/loader/types";
import type { createRoomsClient } from "@tm4/rooms-client";

type Resources = ReturnType<ReturnType<typeof createRoomsClient>["resources"]>;

export async function uploadRoomResources(
  sources: DiscSources,
  resources: Resources,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  signal.throwIfAborted();
  const required = await resources.resources(signal);
  signal.throwIfAborted();
  const assets = await loadDisc(sources, { signal, progress });
  try {
    const ids = [...required.map((entry) => entry.id), "/DATA/files.tsv"];
    for (const [index, id] of ids.entries()) {
      signal.throwIfAborted();
      const bytes = assets.files.get(id);
      if (!bytes) throw new Error("Missing required server resource: " + id);
      progress(`Uploading private server resources (${index + 1}/${ids.length})…`);
      await resources.upload(id, bytes, signal);
    }
    signal.throwIfAborted();
    await resources.prepare(signal);
  } finally {
    assets.files.clear();
  }
}
