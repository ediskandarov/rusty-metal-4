import { expect, test } from "bun:test";

import {
  type PlayerMessage,
  playerMessageSchema,
  type RoomCommand,
  roomCommandSchema,
} from "@tm4/room-player-protocol";

const roomId = "a".repeat(32);
const sessionId = "c24baad1-69d9-4cc8-b74c-e56de97502e4";
const room = { type: "rm4-room", roomId } as const;
const player = { type: "rm4-player", roomId } as const;
const compatibility = { protocol: 16, build: "b".repeat(64), content: "c".repeat(64) };
const join = {
  ...room,
  action: "join",
  sessionId,
  endpoint: `/api/rooms/${roomId}/match/${sessionId}/socket`,
  credential: "d".repeat(64),
} satisfies RoomCommand;

test("each room command has its own required fields", () => {
  for (const command of [
    { ...room, action: "stop" },
    { ...room, action: "stop", message: "Back in the room" },
    { ...room, action: "status", message: "Preparing" },
    { ...room, action: "upload", sessionId },
    join,
  ] satisfies RoomCommand[])
    expect(roomCommandSchema.parse(command)).toEqual(command);
  for (const command of [
    null,
    [],
    {},
    { ...room, action: "status" },
    { ...room, action: "upload" },
    { ...room, action: "join", sessionId },
    { ...room, action: "unknown" },
    { ...room, action: "stop", message: {} },
    { ...join, credential: "" },
    { ...join, credential: 123 },
    { ...room, action: "upload", sessionId: "-".repeat(36) },
    { ...join, type: "rm4-player" },
    { ...join, roomId: "not-a-room" },
    { ...join, action: "stop" },
  ])
    expect(roomCommandSchema.safeParse(command).success).toBe(false);
});

test("a join command cannot redirect the player to another room, match, or origin", () => {
  for (const endpoint of [
    "https://other.test" + join.endpoint,
    "//other.test" + join.endpoint,
    "http://[invalid",
    join.endpoint.replace(roomId, "e".repeat(32)),
    join.endpoint.replace(sessionId, "82badf8b-54f7-4f23-9d7b-bc8a2fbe55dd"),
    join.endpoint + "?credential=other",
    join.endpoint + "/../socket",
    "javascript:alert(1)",
  ])
    expect(roomCommandSchema.safeParse({ ...join, endpoint }).success).toBe(false);
});

test("loaded, unloaded and status events cannot be mixed or omit loaded resource metadata", () => {
  for (const event of [
    { ...player, event: "unloaded" },
    { ...player, event: "status", message: "Uploading" },
    { ...player, event: "loaded", compatibility, cars: ["Orbital", "Pizza Boy"] },
    { ...player, event: "loaded", compatibility, cars: [] },
  ] satisfies PlayerMessage[])
    expect(playerMessageSchema.parse(event)).toEqual(event);
  for (const event of [
    null,
    "loaded",
    {},
    { ...player, loaded: true, compatibility, cars: [] },
    { ...player, event: "status" },
    { ...player, event: "loaded", cars: [] },
    { ...player, event: "loaded", compatibility },
    { ...player, event: "loaded", compatibility, cars: {} },
    { ...player, event: "loaded", compatibility, cars: [1] },
    { ...player, event: "loaded", compatibility: { ...compatibility, build: "bad" }, cars: [] },
    { ...player, event: "unloaded", compatibility, cars: [] },
    { ...player, event: "status", message: "Loaded", cars: [] },
    { ...player, event: "loaded", compatibility, cars: [], roomId: null },
    { ...player, event: "status", message: "Wrong direction", type: "rm4-room" },
  ])
    expect(playerMessageSchema.safeParse(event).success).toBe(false);
});
