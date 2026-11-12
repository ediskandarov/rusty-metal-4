import { maps, modes, type RoomSettings, type RoomSnapshot, type RoomSummary } from "./protocol.ts";

export const reconnectGrace = 45_000;
export const emptyGrace = 30_000;
export const directoryLease = 180_000;
export const directoryRefresh = 60_000;

export class RoomError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RoomError(400, "A JSON object is required.");
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new RoomError(400, `${label} is required.`);
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > max ||
    [...trimmed].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new RoomError(400, `${label} must contain 1–${max} printable characters.`);
  return trimmed;
}
export function settings(value: unknown, members = 0): RoomSettings {
  const input = object(value);
  const name = text(input.name, "Room name", 48);
  const mode = modes.find((entry) => entry.id === input.modeId);
  const map = maps.find((entry) => entry.id === input.mapId);
  if (!mode) throw new RoomError(400, "Choose a supported game mode.");
  if (!map) throw new RoomError(400, "Choose a supported map.");
  if (!Number.isInteger(input.capacity) || Number(input.capacity) < 2 || Number(input.capacity) > 8)
    throw new RoomError(400, "Capacity must be a whole number from 2 to 8.");
  if (Number(input.capacity) < members)
    throw new RoomError(409, "Capacity cannot be lower than the number of participants.");
  return { name, modeId: mode.id, mapId: map.id, capacity: Number(input.capacity) };
}
export interface Member {
  id: string;
  key: string;
  name: string;
  connections: string[];
  disconnectedUntil: number | null;
}
export interface RoomState {
  id: string;
  creatorKey: string;
  settings: RoomSettings;
  members: Member[];
  hostId: string | null;
  emptyUntil: number | null;
  closed: boolean;
  version: number;
  publishAt: number;
  directoryRegistered: boolean;
}
export function createState(id: string, key: string, value: unknown, now: number): RoomState {
  const input = object(value);
  const member = {
    id: crypto.randomUUID(),
    key,
    name: text(input.playerName, "Player name", 24),
    connections: [],
    disconnectedUntil: now + reconnectGrace,
  };
  return {
    id,
    creatorKey: key,
    settings: {
      name: text(input.name, "Room name", 48),
      modeId: "deathmatch",
      mapId: "construction-yard",
      capacity: 8,
    },
    members: [member],
    hostId: member.id,
    emptyUntil: null,
    closed: false,
    version: 0,
    publishAt: now,
    directoryRegistered: false,
  };
}
export function memberFor(state: RoomState, key: string): Member | undefined {
  return state.members.find((member) => member.key === key);
}
export function join(state: RoomState, key: string, name: unknown, now: number): Member {
  if (state.closed) throw new RoomError(410, "This room has closed. Find another room.");
  const existing = memberFor(state, key);
  if (existing) return existing;
  if (state.members.length >= state.settings.capacity)
    throw new RoomError(409, "This room is full.");
  const member: Member = {
    id: crypto.randomUUID(),
    key,
    name: text(name, "Player name", 24),
    connections: [],
    disconnectedUntil: now + reconnectGrace,
  };
  state.members.push(member);
  state.emptyUntil = null;
  state.hostId ??= member.id;
  return member;
}
export function removeMember(state: RoomState, id: string, now: number): void {
  state.members = state.members.filter((member) => member.id !== id);
  if (state.hostId === id) state.hostId = state.members[0]?.id ?? null;
  if (!state.members.length && state.emptyUntil === null) state.emptyUntil = now + emptyGrace;
}
export function prune(state: RoomState, now: number): boolean {
  let changed = false;
  for (const member of [...state.members]) {
    if (member.disconnectedUntil !== null && member.disconnectedUntil <= now) {
      removeMember(state, member.id, now);
      changed = true;
    }
  }
  if (
    !state.members.length &&
    state.emptyUntil !== null &&
    state.emptyUntil <= now &&
    !state.closed
  ) {
    state.closed = true;
    changed = true;
  }
  return changed;
}
export function connect(state: RoomState, key: string, connection: string): Member {
  const member = memberFor(state, key);
  if (!member || state.closed) throw new RoomError(403, "Join this room before connecting.");
  if (member.connections.length >= 4)
    throw new RoomError(429, "This room is open in too many tabs.");
  member.connections.push(connection);
  member.disconnectedUntil = null;
  return member;
}
export function disconnect(
  state: RoomState,
  memberId: string,
  connection: string,
  now: number,
): boolean {
  const member = state.members.find((entry) => entry.id === memberId);
  if (!member?.connections.includes(connection)) return false;
  member.connections = member.connections.filter((id) => id !== connection);
  if (!member.connections.length) member.disconnectedUntil = now + reconnectGrace;
  return true;
}
export function edit(state: RoomState, key: string, value: unknown): void {
  if (memberFor(state, key)?.id !== state.hostId || !state.hostId)
    throw new RoomError(403, "Only the host can change room settings.");
  state.settings = settings(value, state.members.length);
}
export function summary(state: RoomState): RoomSummary {
  return {
    ...state.settings,
    id: state.id,
    host: state.members.find((member) => member.id === state.hostId)?.name ?? "Waiting for a host",
    participantCount: state.members.length,
    freePlaces: state.settings.capacity - state.members.length,
  };
}
export function snapshot(state: RoomState, key: string): RoomSnapshot {
  return {
    ...summary(state),
    version: state.version,
    hostId: state.hostId,
    you: memberFor(state, key)?.id ?? null,
    participants: state.members.map((member) => ({
      id: member.id,
      name: member.name,
      connected: member.connections.length > 0,
    })),
    emptyUntil: state.emptyUntil,
    closed: state.closed,
  };
}
export function nextDeadline(state: RoomState): number | null {
  if (state.closed) return state.publishAt > 0 ? state.publishAt : null;
  const deadlines = [
    state.publishAt,
    state.emptyUntil,
    ...state.members.map((member) => member.disconnectedUntil),
  ].filter((value): value is number => value !== null && value > 0);
  return deadlines.length ? Math.min(...deadlines) : null;
}
