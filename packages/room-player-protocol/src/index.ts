import { compatibilitySchema, sha256Schema } from "@tm4/lightyear-client/schemas";
import { matchIdSchema, roomIdSchema } from "@tm4/rooms-client/schemas";
import { z } from "zod";

export const tournamentStatusSchema = z.object({
  phase: z.enum(["choosing", "confirming", "waiting", "ready", "reconnecting", "error"]),
  title: z.string(),
  message: z.string(),
});
export type TournamentStatus = z.infer<typeof tournamentStatusSchema>;

const roomEnvelope = z.strictObject({ type: z.literal("rm4-room"), roomId: roomIdSchema });
export const roomCommandSchema = z.discriminatedUnion("action", [
  roomEnvelope.extend({
    action: z.literal("car-selection-status"),
    requestId: z.string().uuid(),
    status: tournamentStatusSchema,
  }),
  roomEnvelope.extend({
    action: z.literal("car-selection"),
    requestId: z.string().uuid(),
    enabled: z.boolean(),
  }),
  roomEnvelope.extend({
    action: z.literal("stop"),
    sessionId: matchIdSchema.nullable(),
  }),
  roomEnvelope.extend({ action: z.literal("upload"), sessionId: matchIdSchema }),
  roomEnvelope
    .extend({
      action: z.literal("join"),
      sessionId: matchIdSchema,
      endpoint: z.string(),
      credential: sha256Schema,
    })
    .refine(
      (command) =>
        command.endpoint === `/api/rooms/${command.roomId}/match/${command.sessionId}/socket`,
      { path: ["endpoint"], message: "The socket must belong to this room and match" },
    ),
]);

const playerEnvelope = z.strictObject({ type: z.literal("rm4-player"), roomId: roomIdSchema });
export const playerMessageSchema = z.discriminatedUnion("event", [
  playerEnvelope.extend({
    event: z.literal("car-selection"),
    requestId: z.string().uuid(),
    car: z.string().min(1).max(48).nullable(),
  }),
  playerEnvelope.extend({
    event: z.literal("status"),
    sessionId: matchIdSchema.nullable(),
    message: z.string(),
  }),
  playerEnvelope.extend({
    event: z.literal("upload"),
    sessionId: matchIdSchema,
    phase: z.enum(["progress", "complete", "error"]),
    message: z.string(),
  }),
  playerEnvelope.extend({ event: z.literal("unloaded") }),
  playerEnvelope.extend({
    event: z.literal("loaded"),
    compatibility: compatibilitySchema,
    cars: z.array(z.string().min(1)),
  }),
]);

export type RoomCommand = z.infer<typeof roomCommandSchema>;
export type PlayerMessage = z.infer<typeof playerMessageSchema>;
type Body<T> = T extends unknown ? Omit<T, "type" | "roomId"> : never;
export type RoomAction = Body<RoomCommand>;
export type PlayerEvent = Body<PlayerMessage>;
