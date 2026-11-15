import { createRoomsClient } from "@tm4/rooms-client";
import { matchIdSchema, roomIdSchema } from "@tm4/rooms-client/schemas";

import type { JournalExport, ServerJournalDownload } from "./archive.ts";

export async function downloadServerJournal(client: JournalExport): Promise<ServerJournalDownload> {
  const room = roomIdSchema.safeParse(client.metadata.roomId);
  const match = matchIdSchema.safeParse(client.metadata.matchId);
  if (!room.success || !match.success)
    throw new Error("This client journal has no room and match identifier.");
  const rooms = createRoomsClient({ baseURL: new URL("/api/", location.href) });
  // Use the identity frozen in the client journal, never the room's newest match.
  const result = await rooms.journal(room.data, match.data, AbortSignal.timeout(30_000));
  return { ...result, savedAt: result.savedAt > 0 ? result.savedAt : null };
}
