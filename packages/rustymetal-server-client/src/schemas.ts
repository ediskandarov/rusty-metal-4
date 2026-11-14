import {
  compatibilitySchema,
  controllerIdentitySchema,
  ffaLimitsSchema,
  matchCompletionSchema,
  scoreSchema,
  sha256Schema,
} from "@tm4/lightyear-client/schemas";
import { z } from "zod";
const count = z.number().int().nonnegative();
export const serverStatusSchema = z.object({
  phase: z.enum([
    "setup",
    "loading",
    "ready",
    "starting",
    "lobby",
    "match",
    "results",
    "failed",
    "closed",
  ]),
  sleeping: z.boolean().optional(),
  sessionId: z.string().nullable(),
  cars: z.array(z.string()),
  compatibility: compatibilitySchema.nullable(),
  message: z.string(),
  players: count.min(2).max(8),
  worlds: z.array(z.string()),
  world: z.string().nullable(),
  connected: count.max(8),
  tick: count,
  endpoint: z.string(),
  uploaded: count,
  required: count,
});
export type ServerStatus = z.infer<typeof serverStatusSchema>;
export const resourceIdSchema = z
  .string()
  .regex(/^\/DATA\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
  .refine(
    (id) => !id.split("/").some((part) => part === "." || part === ".."),
    "Invalid resource path",
  );
export const resourceManifestSchema = z.array(
  z.object({ id: resourceIdSchema, size: count, sha256: sha256Schema }),
);
export type ResourceManifest = z.infer<typeof resourceManifestSchema>;
export const startOptionsSchema = z
  .object({
    limits: ffaLimitsSchema,
    players: count.min(2).max(8),
    world: z.string().min(1),
    sessionId: z.string().uuid().optional(),
    roster: z.array(z.object({ credential: sha256Schema, car: z.string().min(1) })).optional(),
  })
  .refine(
    (value) =>
      (value.sessionId === undefined && value.roster === undefined) ||
      (value.sessionId !== undefined &&
        value.roster !== undefined &&
        value.roster.length >= 2 &&
        value.roster.length <= value.players &&
        new Set(value.roster.map((member) => member.credential)).size === value.roster.length),
    "Invalid initial room roster",
  );
export type StartOptions = z.infer<typeof startOptionsSchema>;
export const measurementSchema = z.object({
  name: z.string().regex(/^rustymetal4_[a-z0-9_]+$/),
  kind: z.enum(["counter", "gauge"]),
  value: z.number().finite().nonnegative(),
  slot: count.max(7).optional(),
  bucket: z.string().optional(),
});
export type Measurement = z.infer<typeof measurementSchema>;
export const measurementKey = (row: Measurement) =>
  row.name + "/" + (row.slot ?? "") + "/" + (row.bucket ?? "");
export const healthSnapshotSchema = z
  .object({
    schema: z.literal(1),
    boot: z.string(),
    uptimeSeconds: z.number().finite().nonnegative(),
    phase: z.string(),
    measurements: z.array(measurementSchema).max(200),
  })
  .refine(
    (snapshot) =>
      new Set(snapshot.measurements.map(measurementKey)).size === snapshot.measurements.length,
    "Duplicate health measurements",
  );
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

export const membershipOptionsSchema = z.object({
  sessionId: z.string().uuid(),
  change: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("admit"),
      credential: sha256Schema,
      car: z
        .string()
        .min(1)
        .max(63)
        .regex(/^[^\0\n]+$/),
    }),
    z.object({ kind: z.literal("depart"), credential: sha256Schema }),
  ]),
});
export type MembershipOptions = z.infer<typeof membershipOptionsSchema>;
export const membershipReplySchema = z.object({
  identity: controllerIdentitySchema.nullable(),
  tick: count.max(0xffffffff).nullable(),
  pending: z.boolean(),
});

export const membershipLookupSchema = z.object({
  sessionId: z.string().uuid(),
  credential: sha256Schema,
});
export type MembershipLookup = z.infer<typeof membershipLookupSchema>;

// Private authority API: credentials bind final identities to room membership, never sent to players.
export const authoritativeResultSchema = z
  .object({
    sessionId: z.string().uuid(),
    completion: matchCompletionSchema.refine((value) => value.reasons > 0),
    participants: z
      .array(
        z.object({
          identity: controllerIdentitySchema,
          credential: sha256Schema.nullable(),
          score: scoreSchema,
        }),
      )
      .max(8),
  })
  .refine((result) => {
    const rows = result.participants;
    const occupied = rows.reduce((mask, row) => mask | (1 << row.identity.slot), 0);
    const best = Math.max(...rows.map((row) => row.score.frags));
    const winners = rows.reduce(
      (mask, row) => mask | (row.score.frags === best ? 1 << row.identity.slot : 0),
      0,
    );
    return (
      new Set(rows.map((row) => row.identity.participant)).size === rows.length &&
      new Set(rows.map((row) => row.identity.slot)).size === rows.length &&
      new Set(rows.map((row) => row.credential).filter((value) => value !== null)).size ===
        rows.filter((row) => row.credential !== null).length &&
      (result.completion.winners & ~occupied) === 0 &&
      result.completion.winners === winners
    );
  }, "Invalid final participant identities or winners");
export type AuthoritativeResult = z.infer<typeof authoritativeResultSchema>;
