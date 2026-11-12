import { compatibilitySchema, sha256Schema } from "@tm4/lightyear-client/schemas";
import { z } from "zod";
export { compatibilitySchema };
export type { Compatibility } from "@tm4/lightyear-client/schemas";
export const modes = [{ id: "deathmatch", label: "Deathmatch" }] as const;

// Names come from the native GameGetWorldName catalog; IDs remain stable if labels change.
export const maps = [
  { id: "construction-yard", label: "Construction Yard" },
  { id: "neon-city", label: "Neon City" },
  { id: "road-rage", label: "Road Rage" },
  { id: "the-bedroom", label: "The Bedroom" },
  { id: "amazonia", label: "Amazonia 3000 B.C." },
  { id: "the-oil-rig", label: "The Oil Rig" },
  { id: "minions-maze", label: "Minion's Maze" },
  { id: "the-carnival", label: "The Carnival" },
  { id: "the-pits", label: "The Pits" },
  { id: "the-citadel", label: "The Citadel" },
  { id: "nowhere-to-hide", label: "Nowhere To Hide" },
  { id: "octa-gone", label: "Octa-Gone" },
  { id: "king-of-the-kill", label: "King Of The Kill" },
  { id: "tic-tac-toast", label: "Tic-Tac-Toast" },
  { id: "the-islands", label: "The Islands" },
  { id: "son-of-a-ditch", label: "Son Of A Ditch" },
] as const;

export const roomIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const matchIdSchema = z.string().uuid();
const count = z.number().int().nonnegative();
const text = (length: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(length)
    .refine(
      (value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Control characters are not allowed",
    );
export const roomSettingsSchema = z.object({
  name: text(48),
  modeId: z.enum(["deathmatch"]),
  mapId: z.enum(maps.map((map) => map.id)),
  capacity: count.min(2).max(8),
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;
export const roomSummarySchema = roomSettingsSchema.extend({
  id: roomIdSchema,
  host: z.string(),
  participantCount: count.max(8),
  freePlaces: count.max(8),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export const matchSnapshotSchema = z.object({
  id: matchIdSchema,
  stage: z.enum([
    "uploading",
    "validating",
    "ready",
    "starting",
    "connecting",
    "playing",
    "stopping",
  ]),
  deadline: count,
  cars: z.array(z.string()),
  message: z.string(),
  endpoint: z.string().nullable(),
  credential: sha256Schema.nullable(),
});
export type MatchSnapshot = z.infer<typeof matchSnapshotSchema>;
export const roomSnapshotSchema = roomSummarySchema.extend({
  version: count,
  hostId: z.string().uuid().nullable(),
  you: z.string().uuid().nullable(),
  participants: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        connected: z.boolean(),
        car: z.string().nullable(),
        ready: z.boolean(),
        loaded: z.boolean(),
      }),
    )
    .max(8),
  match: matchSnapshotSchema.nullable(),
  notice: z.string(),
  emptyUntil: count.nullable(),
  closed: z.boolean(),
});
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
export const roomResponseSchema = z.object({ room: roomSnapshotSchema });
export const directoryResponseSchema = z.object({ rooms: z.array(roomSummarySchema) });
export const roomEventSchema = roomResponseSchema.extend({ type: z.literal("room") });
export const directoryEventSchema = directoryResponseSchema.extend({
  type: z.literal("directory"),
});
export type RoomEvent = z.infer<typeof roomEventSchema>;
export type DirectoryEvent = z.infer<typeof directoryEventSchema>;
export const sessionSchema = z.object({ ok: z.literal(true), serverTime: count });
export const catalogSchema = z.object({
  maps: z.array(z.object({ id: z.string(), label: z.string() })),
  modes: z.array(z.object({ id: z.string(), label: z.string() })),
});
export const createRoomSchema = z.object({
  name: text(48),
  playerName: text(24),
  requestId: z.string().regex(/^\d{13}\.[a-f0-9-]{36}$/),
});
export type CreateRoom = z.infer<typeof createRoomSchema>;
export const playerSelectionSchema = z.object({
  car: text(48).nullable(),
  compatibility: compatibilitySchema.nullable(),
  ready: z.boolean(),
});
export type PlayerSelection = z.infer<typeof playerSelectionSchema>;
export const joinRoomSchema = z.object({ playerName: text(24) });
export const mapLabel = (id: string) => maps.find((map) => map.id === id)?.label ?? id;
export const modeLabel = (id: string) => modes.find((mode) => mode.id === id)?.label ?? id;
