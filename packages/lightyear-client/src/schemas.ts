import { z } from "zod";
export const networkProtocolVersion = 13;
const u32 = z.number().int().min(0).max(0xffffffff);
const i32 = z.number().int().min(-0x80000000).max(0x7fffffff);
const byte = z.number().int().min(0).max(255);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const compatibilitySchema = z.object({
  protocol: z.number().int().min(0).max(65535),
  build: sha256Schema,
  content: sha256Schema,
});
export type Compatibility = z.infer<typeof compatibilitySchema>;
export const buildManifestSchema = z.object({ sha256: sha256Schema });
export const inputSchema = z.object({
  buttons: z.number().int().min(0).max(65535),
  axes: u32,
  analog: z.boolean(),
});
export type Input = z.infer<typeof inputSchema>;
export const scoreSchema = z.object({ wins: i32, losses: i32 });
export type Score = z.infer<typeof scoreSchema>;
export const roundStateSchema = z.object({
  remaining: byte,
  winner: z.number().int().min(-128).max(127),
  roundFinished: z.boolean(),
  acceptsContinue: z.boolean(),
  nextMode: i32,
  digest: u32,
  sections: z.tuple([u32, u32, u32, u32, u32]),
  unsupported: z.string().nullable(),
  scores: z.array(scoreSchema).max(8),
});
export type RoundState = z.infer<typeof roundStateSchema>;
export const slotConfigurationSchema = z
  .object({
    capacity: z.number().int().min(2).max(8),
    slots: z.array(z.number().int().min(0).max(7)).min(2).max(8),
  })
  .refine(
    (start) =>
      start.slots.length <= start.capacity &&
      start.slots.every(
        (slot, index) => slot < start.capacity && (index === 0 || slot > start.slots[index - 1]!),
      ),
    "Invalid occupied gameplay slots",
  );
export type SlotConfiguration = z.infer<typeof slotConfigurationSchema>;
export const participantIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((id) => id !== "0000000000000000");
export const startSchema = slotConfigurationSchema
  .safeExtend({
    world: z
      .string()
      .min(1)
      .regex(/^[^\0]+$/),
    cars: z
      .array(
        z
          .string()
          .min(1)
          .regex(/^[^\0\n]+$/),
      )
      .min(2)
      .max(8),
    participants: z.array(participantIdSchema).min(2).max(8),
    seed: u32,
    epoch: u32,
    compatibility: compatibilitySchema,
    portable: z.boolean(),
  })
  .refine(
    (start) =>
      start.cars.length === start.slots.length &&
      start.participants.length === start.slots.length &&
      new Set(start.participants).size === start.participants.length,
    "One mode car is required per occupied slot",
  );
export type Start = z.infer<typeof startSchema>;
export const lobbySchema = z.object({
  cars: z.array(z.string()),
  players: z
    .array(
      z.object({
        slot: z.number().int().min(0).max(7),
        connected: z.boolean(),
        car: z.string().nullable(),
        ready: z.boolean(),
      }),
    )
    .max(8),
});
export type LobbyState = z.infer<typeof lobbySchema>;
export const frameSchema = z.object({
  type: z.literal("frame"),
  tick: u32,
  inputs: z.array(inputSchema).max(8),
  state: roundStateSchema,
});
export type Frame = z.infer<typeof frameSchema>;
// The direct Rust callback runs before the browser client's message normalization.
export const journalAuthorityFrameSchema = z.object({
  frame: frameSchema.omit({ type: true }),
});
export const snapshotBeginSchema = z.object({
  type: z.literal("snapshot_begin"),
  attempt: u32,
  tick: u32.positive(),
  anchor: u32,
  total: u32.max(256 * 1024).positive(),
  checksum: u32,
  state: roundStateSchema,
});
export type SnapshotBegin = z.infer<typeof snapshotBeginSchema>;
export const catchupChunkSchema = z.object({
  type: z.literal("catchup_frames"),
  attempt: u32,
  start: u32,
  head: u32,
  data: z.array(byte).max(64 * (29 + 7 * 8)),
  checksum: u32,
});
export type CatchupChunk = z.infer<typeof catchupChunkSchema>;
export const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prediction_recovery_required"),
    reason: z.enum(["clock_shift", "history_expired"]),
    message: z.string(),
  }),
  lobbySchema.extend({ type: z.literal("lobby") }),
  startSchema.safeExtend({ type: z.literal("prediction_prepare") }),
  startSchema.safeExtend({ type: z.literal("resume_prepare") }),
  z.object({ type: z.literal("resume_credential"), token: sha256Schema }),
  z.object({ type: z.literal("resume_pending") }),
  snapshotBeginSchema,
  z.object({
    type: z.literal("snapshot_chunk"),
    attempt: u32,
    offset: u32,
    data: z.array(byte).min(1).max(8192),
  }),
  z.object({ type: z.literal("resume_catchup"), attempt: u32, start: u32, head: u32, digest: u32 }),
  z.object({ type: z.literal("resume_live"), attempt: u32, anchor: u32, head: u32, sequence: u32 }),
  z.object({ type: z.literal("resume_active"), head: u32 }),
  z.object({ type: z.literal("prediction_offer"), anchor: u32 }),
  z.object({ type: z.literal("prediction_begin"), anchor: u32 }),
  frameSchema,
  catchupChunkSchema,
  z.object({ type: z.literal("welcome"), slot: z.number().int().min(0).max(7) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type Message = z.infer<typeof messageSchema>;
export const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), compatibility: compatibilitySchema }),
  z.object({ type: z.literal("resume"), token: sha256Schema, compatibility: compatibilitySchema }),
  z.object({ type: z.literal("select_car"), car: z.string(), ready: z.boolean() }),
  z.object({
    type: z.literal("ready"),
    epoch: u32,
    digest: u32,
    unsupported: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("progress"), tick: u32 }),
  z.object({ type: z.literal("prediction_clock"), epoch: u32, anchor: u32, tick: u32 }),
  z.object({ type: z.literal("snapshot_received"), attempt: u32, offset: u32 }),
  z.object({ type: z.literal("resume_clock"), attempt: u32, target: u32 }),
  z.object({ type: z.literal("resume_live_ack"), attempt: u32, head: u32 }),
  z.object({ type: z.literal("catchup_applied"), attempt: u32, tick: u32 }),
]);
export type Request = z.infer<typeof requestSchema>;
const count = z.number().finite().nonnegative();
export const diagnosticsSchema = z.object({
  rttMs: count.nullable(),
  jitterMs: count.nullable(),
  queuedPackets: count.nullable(),
  nativeTick: count,
  prediction: z.object({
    head: count,
    confirmed: count,
    rollbacks: count,
    windowWaits: count,
    waitingForInput: z.boolean(),
    acceptedDepth: i32,
    confirmedNativeTick: u32.nullable(),
    resumePreparing: z.boolean(),
    replayed: count,
    maxDepth: count,
    historyBytes: count,
    peakBytes: count,
    buttonEdges: count,
  }),
});
