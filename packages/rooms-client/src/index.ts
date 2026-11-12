import { createResourceClient, type Fetch } from "@tm4/rustymetal-server-client";
import { z } from "zod";

import {
  catalogSchema,
  type CreateRoom,
  createRoomSchema,
  directoryEventSchema,
  directoryResponseSchema,
  joinRoomSchema,
  matchIdSchema,
  type PlayerSelection,
  playerSelectionSchema,
  roomEventSchema,
  roomIdSchema,
  roomResponseSchema,
  type RoomSettings,
  roomSettingsSchema,
  type RoomSnapshot,
  type RoomSummary,
  sessionSchema,
} from "./schemas.ts";
import { subscribe } from "./subscription.ts";
export class RoomsApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RoomsApiError";
  }
}
export interface RoomsClientOptions {
  baseURL: string | URL;
  fetch?: Fetch;
}
export interface WatchOptions<T> {
  update: (value: T) => void;
  status: (live: boolean) => void;
  recover: () => Promise<boolean>;
}
export function createRoomsClient(options: RoomsClientOptions) {
  const base = new URL(options.baseURL);
  base.pathname = base.pathname.replace(/\/?$/, "/");
  const url = (path: string) => new URL(path, base);
  const room = (id: string) => "rooms/" + roomIdSchema.parse(id);
  const match = (id: string, session: string) =>
    room(id) + "/match/" + matchIdSchema.parse(session);
  const request = async <T>(path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await (options.fetch ?? fetch)(
      new Request(url(path).href, {
        cache: "no-store",
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    );
    if (!response.ok) {
      const text = await response.text();
      let message = "Room API: HTTP " + response.status;
      try {
        const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(text));
        if (parsed.success) message = parsed.data.error;
      } catch {
        /* Gateways can return non-JSON errors. */
      }
      throw new RoomsApiError(response.status, message);
    }
    return schema.parse(await response.json());
  };
  const mutate = async (path: string, body: unknown = {}) =>
    (await request(path, roomResponseSchema, body)).room;
  return {
    async session() {
      return request("session", sessionSchema, {});
    },
    async catalog() {
      return request("catalog", catalogSchema);
    },
    async list() {
      return (await request("rooms", directoryResponseSchema)).rooms;
    },
    async get(id: string) {
      return (await request(room(id), roomResponseSchema)).room;
    },
    async create(input: CreateRoom) {
      return mutate("rooms", createRoomSchema.parse(input));
    },
    async join(id: string, playerName: string) {
      return mutate(room(id) + "/join", joinRoomSchema.parse({ playerName }));
    },
    async leave(id: string) {
      return mutate(room(id) + "/leave");
    },
    async settings(id: string, input: RoomSettings) {
      return mutate(room(id) + "/settings", roomSettingsSchema.parse(input));
    },
    async player(id: string, input: PlayerSelection) {
      return mutate(room(id) + "/player", playerSelectionSchema.parse(input));
    },
    async prepare(id: string) {
      return mutate(room(id) + "/prepare");
    },
    async start(id: string) {
      return mutate(room(id) + "/start");
    },
    async cancel(id: string, session: string) {
      return mutate(match(id, session) + "/cancel");
    },
    async journal(id: string, session: string) {
      const response = await (options.fetch ?? fetch)(
        new Request(url(match(id, session) + "/journal"), { cache: "no-store" }),
      );
      if (!response.ok)
        throw new RoomsApiError(
          response.status,
          "Server journal unavailable (HTTP " + response.status + ")",
        );
      return {
        bytes: await response.blob(),
        savedAt: Number(response.headers.get("X-Journal-Saved-At")),
      };
    },
    resources(id: string, session: string) {
      return createResourceClient({ baseURL: url(match(id, session) + "/"), fetch: options.fetch });
    },
    watchDirectory(watch: WatchOptions<RoomSummary[]>) {
      return subscribe(
        url("directory/live"),
        directoryEventSchema,
        (event) => watch.update(event.rooms),
        watch.status,
        watch.recover,
      );
    },
    watchRoom(id: string, watch: WatchOptions<RoomSnapshot>) {
      return subscribe(
        url(room(id) + "/live"),
        roomEventSchema,
        (event) => watch.update(event.room),
        watch.status,
        watch.recover,
      );
    },
  };
}
