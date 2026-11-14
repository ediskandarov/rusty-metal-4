import { expect, test } from "bun:test";

import type { MatchStatus } from "@tm4/game-runtime/network/match";
import type { RoomAction } from "@tm4/room-player-protocol";

import { createRoomSession } from "../../apps/player/src/room/session.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const command = (sessionId: string): Extract<RoomAction, { action: "join" }> => ({
  action: "join",
  sessionId,
  endpoint: "/match/" + sessionId,
  credential: "a".repeat(64),
});
function setup() {
  const joins: {
    id: string;
    signal: AbortSignal;
    status: MatchStatus;
    pending: ReturnType<typeof deferred>;
  }[] = [];
  const uploads: {
    id: string;
    signal: AbortSignal;
    progress: (message: string) => void;
    pending: ReturnType<typeof deferred>;
  }[] = [];
  const statuses: [string, string][] = [];
  const session = createRoomSession({
    join(message, signal, status) {
      const pending = deferred();
      joins.push({ id: message.sessionId, signal, status, pending });
      return pending.promise;
    },
    upload(id, signal, progress) {
      const pending = deferred();
      uploads.push({ id, signal, progress, pending });
      return pending.promise;
    },
    show: (phase, message) => {
      statuses.push([phase, message]);
    },
  });
  return { session, joins, uploads, statuses };
}

test("stop and immediate rejoin of the same match keep the new attempt", async () => {
  const { session, joins, statuses } = setup();
  session.handle(command("one"));
  session.handle(command("one"));
  expect(joins).toHaveLength(1);
  session.handle({ action: "stop" });
  expect(joins[0]!.signal.aborted).toBe(true);
  session.handle(command("one"));
  expect(joins).toHaveLength(2);
  joins[1]!.status("playing", "New connection");
  joins[0]!.status("error", "Old status");
  joins[0]!.pending.reject(new Error("Old rejection"));
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["playing", "New connection"]);
  expect(joins[1]!.signal.aborted).toBe(false);
  session.dispose();
});

test("another match cancels the previous one without waiting for it to connect", async () => {
  const { session, joins, statuses } = setup();
  session.handle(command("one"));
  session.handle(command("two"));
  expect(joins.map(({ id }) => id)).toEqual(["one", "two"]);
  expect(joins[0]!.signal.aborted).toBe(true);
  joins[1]!.status("playing", "Second match");
  joins[0]!.pending.resolve();
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["playing", "Second match"]);
  expect(joins[1]!.signal.aborted).toBe(false);
  session.dispose();
});

test("a current connection failure is visible and allows a deliberate retry", async () => {
  const { session, joins, statuses } = setup();
  session.handle(command("one"));
  joins[0]!.pending.reject(new Error("Could not connect"));
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["error", "Could not connect"]);
  expect(joins[0]!.signal.aborted).toBe(true);
  session.handle(command("one"));
  joins[1]!.status("error", "Prediction failed");
  expect(joins[1]!.signal.aborted).toBe(true);
  expect(statuses.at(-1)).toEqual(["error", "Prediction failed"]);
  session.dispose();
});

test("cancelled upload cannot report progress or completion into its replacement", async () => {
  const { session, uploads, statuses } = setup();
  session.handle({ action: "upload", sessionId: "one" });
  session.handle({ action: "upload", sessionId: "one" });
  expect(uploads).toHaveLength(1);
  session.handle({ action: "stop", message: "Preparation cancelled" });
  session.handle({ action: "upload", sessionId: "two" });
  expect(uploads[0]!.signal.aborted).toBe(true);
  uploads[1]!.progress("Uploading second match");
  uploads[0]!.progress("Old progress");
  uploads[0]!.pending.resolve();
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["lobby", "Uploading second match"]);
  expect(uploads[1]!.signal.aborted).toBe(false);
  session.handle({ action: "status", message: "Server ready" });
  expect(statuses.at(-1)).toEqual(["lobby", "Uploading second match"]);
  uploads[1]!.pending.resolve();
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["lobby", "Server ready"]);
  session.dispose();
});

test("a failed upload releases the operation so the same preparation can retry", async () => {
  const { session, uploads, statuses } = setup();
  session.handle({ action: "upload", sessionId: "one" });
  uploads[0]!.pending.reject(new Error("Upload failed"));
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["error", "Upload failed"]);
  expect(uploads[0]!.signal.aborted).toBe(true);
  session.handle({ action: "upload", sessionId: "one" });
  uploads[1]!.pending.resolve();
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["lobby", "Server upload complete. Waiting for validation…"]);
  session.handle({ action: "status", message: "Validation complete" });
  expect(statuses.at(-1)).toEqual(["lobby", "Validation complete"]);
  session.dispose();
});

test("entering the match supersedes preparation and ignores its late failure", async () => {
  const { session, uploads, joins, statuses } = setup();
  session.handle({ action: "upload", sessionId: "one" });
  session.handle(command("one"));
  expect(uploads[0]!.signal.aborted).toBe(true);
  joins[0]!.status("playing", "Playing");
  session.handle({ action: "upload", sessionId: "one" });
  expect(uploads).toHaveLength(1);
  expect(joins[0]!.signal.aborted).toBe(false);
  uploads[0]!.pending.reject(new Error("Old upload failed"));
  session.handle({ action: "status", message: "Old preparation status" });
  await Promise.resolve();
  expect(statuses.at(-1)).toEqual(["playing", "Playing"]);
  session.dispose();
});

test("disposing the frame cancels its operation and ignores all later commands", async () => {
  const { session, uploads, joins, statuses } = setup();
  session.handle({ action: "upload", sessionId: "one" });
  session.dispose();
  expect(uploads[0]!.signal.aborted).toBe(true);
  uploads[0]!.pending.reject(new Error("Cancelled"));
  session.handle(command("two"));
  session.handle({ action: "upload", sessionId: "two" });
  session.handle({ action: "status", message: "Late status" });
  session.handle({ action: "stop" });
  await Promise.resolve();
  expect(joins).toHaveLength(0);
  expect(uploads).toHaveLength(1);
  expect(statuses).toEqual([]);
});
