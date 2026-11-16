import { text } from "./fields.ts";
import {
  ffaCapacity,
  modeDefinitions,
  modeIdSchema,
  modeOptionsSchema,
  modes,
  roomModeCapacity,
} from "./modes/index.ts";
export {
  ffaCapacity,
  modes,
  roomModeCapacity,
  modeOptionsSchema,
  roomBots,
  roomHumanLimit,
} from "./modes/index.ts";
import {
  compatibilitySchema,
  controllerIdentitySchema,
  matchCompletionSchema,
  scoreSchema,
  sha256Schema,
} from "@tm4/lightyear-client/schemas";
import { serverLocationSchema } from "@tm4/rustymetal-server-client/schemas";
import { z } from "zod";
export { compatibilitySchema };
export type { Compatibility } from "@tm4/lightyear-client/schemas";
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
export const roomSettingsSchema = z
  .object({
    name: text(48),
    modeOptions: modeOptionsSchema.optional(),
    modeId: modeIdSchema,
    mapId: z.enum(maps.map((map) => map.id)),
    capacity: z.union([z.literal(ffaCapacity), z.literal(2)]),
  })
  .refine((settings) => settings.capacity === roomModeCapacity(settings.modeId), {
    message: "Capacity must match the game mode",
    path: ["capacity"],
  })
  .refine((settings) => modeDefinitions[settings.modeId].validSettings(settings), {
    message: "Settings do not match the selected game mode",
  });
export type RoomSettings = z.infer<typeof roomSettingsSchema>;
export const roomSummarySchema = roomSettingsSchema.safeExtend({
  id: roomIdSchema,
  host: z.string(),
  participantCount: count.max(ffaCapacity),
  freePlaces: count.max(ffaCapacity),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export const matchSnapshotSchema = z.object({
  world: z.string().nullable().default(null),
  location: serverLocationSchema.nullable().default(null),
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
export const roomResultSchema = z.object({
  modeId: modeIdSchema,
  matchId: matchIdSchema,
  completion: matchCompletionSchema.refine((value) => value.reasons > 0),
  participants: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        name: text(24),
        identity: controllerIdentitySchema,
        score: scoreSchema,
        winner: z.boolean(),
      }),
    )
    .max(8),
});
export type RoomResult = z.infer<typeof roomResultSchema>;
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
    .max(ffaCapacity),
  match: matchSnapshotSchema.nullable(),
  result: roomResultSchema.nullable().optional(),
  journal: z.object({ matchId: matchIdSchema, expiresAt: count }).nullable().optional(),
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
