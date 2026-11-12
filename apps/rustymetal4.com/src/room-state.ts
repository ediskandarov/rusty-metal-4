import {
  type Compatibility,
  maps,
  type MatchSnapshot,
  modes,
  type RoomSettings,
  type RoomSnapshot,
  type RoomSummary,
} from "./protocol.ts";

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
export const preparationLimit = 5 * 60_000;
export const emptyMatchGrace = 120_000;
// Shorter than the capacity lease; monitoring outages cannot retain a server indefinitely.
export const monitoringGrace = 30_000;
export const monitoringTimeout = 5000;
export interface RoomMatch {
  id: string;
  ownerId: string;
  stage: MatchSnapshot["stage"];
  deadline: number;
  pollAt: number;
  monitoringUnavailableUntil: number | null;
  emptyUntil: number | null;
  cars: string[];
  compatibility: Compatibility | null;
  roster: { id: string; credential: string; car: string }[];
  message: string;
}
export interface Member {
  id: string;
  key: string;
  name: string;
  car: string | null;
  compatibility: Compatibility | null;
  ready: boolean;
  connections: string[];
  disconnectedUntil: number | null;
}
export interface RoomState {
  id: string;
  match: RoomMatch | null;
  notice: string;
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
    car: null,
    compatibility: null,
    ready: false,
    connections: [],
    disconnectedUntil: now + reconnectGrace,
  };
  return {
    id,
    creatorKey: key,
    match: null,
    notice: "",
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
  if (state.match?.roster.length)
    throw new RoomError(409, "A match is in progress. Wait for it to finish.");
  if (state.members.length >= state.settings.capacity)
    throw new RoomError(409, "This room is full.");
  const member: Member = {
    id: crypto.randomUUID(),
    key,
    name: text(name, "Player name", 24),
    car: null,
    compatibility: null,
    ready: false,
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
    if (
      !state.match?.roster.some((entry) => entry.id === member.id) &&
      member.disconnectedUntil !== null &&
      member.disconnectedUntil <= now
    ) {
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
  if (!member.connections.length) {
    member.disconnectedUntil = now + reconnectGrace;
    member.ready = false;
  }
  return true;
}
export function edit(state: RoomState, key: string, value: unknown): void {
  if (memberFor(state, key)?.id !== state.hostId || !state.hostId)
    throw new RoomError(403, "Only the host can change room settings.");
  if (state.match)
    throw new RoomError(409, "Cancel preparation or finish the match before changing settings.");
  state.settings = settings(value, state.members.length);
  invalidateReady(state);
}
export function summary(state: RoomState): RoomSummary {
  return {
    ...state.settings,
    id: state.id,
    host: state.members.find((member) => member.id === state.hostId)?.name ?? "Waiting for a host",
    participantCount: state.members.length,
    freePlaces: state.match?.roster.length ? 0 : state.settings.capacity - state.members.length,
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
      car: member.car,
      ready: member.ready,
      loaded: member.compatibility !== null,
    })),
    match: state.match
      ? {
          id: state.match.id,
          stage: state.match.stage,
          deadline: state.match.deadline,
          cars: state.match.cars,
          message: state.match.message,
          endpoint:
            state.match.roster.some((entry) => entry.id === memberFor(state, key)?.id) &&
            ["connecting", "playing"].includes(state.match.stage)
              ? "/api/rooms/" + state.id + "/match/" + state.match.id + "/socket"
              : null,
          credential:
            state.match.roster.find((entry) => entry.id === memberFor(state, key)?.id)
              ?.credential ?? null,
        }
      : null,
    notice: state.notice,
    emptyUntil: state.emptyUntil,
    closed: state.closed,
  };
}
export function nextDeadline(state: RoomState): number | null {
  if (state.closed) return state.publishAt > 0 ? state.publishAt : null;
  const deadlines = [
    state.publishAt,
    state.match?.pollAt ?? null,
    state.emptyUntil,
    ...state.members
      .filter((member) => !state.match?.roster.some((entry) => entry.id === member.id))
      .map((member) => member.disconnectedUntil),
  ].filter((value): value is number => value !== null && value > 0);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function invalidateReady(state: RoomState): void {
  for (const member of state.members) member.ready = false;
}
export function requireHost(state: RoomState, key: string): Member {
  const member = memberFor(state, key);
  if (!member || member.id !== state.hostId)
    throw new RoomError(403, "Only the host can prepare or start a match.");
  return member;
}
export function sameCompatibility(a: Compatibility | null, b: Compatibility | null): boolean {
  return !!a && !!b && a.protocol === b.protocol && a.build === b.build && a.content === b.content;
}
export function updatePlayer(state: RoomState, key: string, value: unknown): void {
  const member = memberFor(state, key);
  if (!member) throw new RoomError(403, "Join this room first.");
  if (state.match?.roster.length) throw new RoomError(409, "The match roster is locked.");
  const input = object(value);
  const car = input.car === null ? null : text(input.car, "Car", 48);
  const raw = input.compatibility === null ? null : object(input.compatibility);
  let compatibility: Compatibility | null = null;
  if (raw) {
    if (
      raw.protocol !== 9 ||
      typeof raw.build !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.build) ||
      typeof raw.content !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.content)
    )
      throw new RoomError(400, "Load the current game build and your local disc.");
    compatibility = { protocol: raw.protocol, build: raw.build, content: raw.content };
  }
  if (typeof input.ready !== "boolean") throw new RoomError(400, "Choose a readiness state.");
  const changed = car !== member.car || !sameCompatibility(compatibility, member.compatibility);
  if (
    input.ready &&
    (changed ||
      !car ||
      !state.match ||
      state.match.stage !== "ready" ||
      !state.match.cars.includes(car) ||
      !sameCompatibility(compatibility, state.match.compatibility))
  )
    throw new RoomError(
      409,
      "Select a car, load matching resources and wait for server preparation before readying.",
    );
  member.car = car;
  member.compatibility = compatibility;
  member.ready = input.ready;
}
export function beginPreparation(state: RoomState, key: string, now: number): RoomMatch {
  const host = requireHost(state, key);
  if (state.match) throw new RoomError(409, "Preparation is already in progress.");
  if (!host.compatibility) throw new RoomError(409, "Load your disc before preparing the server.");
  invalidateReady(state);
  state.notice = "";
  return (state.match = {
    id: crypto.randomUUID(),
    ownerId: host.id,
    stage: "uploading",
    deadline: now + preparationLimit,
    pollAt: now + 2000,
    monitoringUnavailableUntil: null,
    emptyUntil: null,
    cars: [],
    compatibility: null,
    roster: [],
    message: "Host: upload your disc resources to the private server.",
  });
}
export function freezeRoster(state: RoomState, key: string, now: number): RoomMatch {
  requireHost(state, key);
  const match = state.match;
  if (!match || match.stage !== "ready")
    throw new RoomError(409, "Prepare server resources first.");
  if (
    state.members.length < 2 ||
    state.members.some(
      (member) =>
        !member.ready ||
        !member.connections.length ||
        !member.car ||
        !sameCompatibility(member.compatibility, match.compatibility),
    )
  )
    throw new RoomError(409, "At least two players must be present, with every participant ready.");
  match.roster = state.members.map((member) => ({
    id: member.id,
    car: member.car!,
    credential: (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", ""),
  }));
  match.stage = "starting";
  match.deadline = now + preparationLimit;
  match.message = "Connecting the fixed match roster…";
  return match;
}
export function resetMatch(state: RoomState, message: string, now: number): void {
  state.match = null;
  state.notice = message;
  invalidateReady(state);
  for (const member of state.members)
    if (!member.connections.length) member.disconnectedUntil = now + reconnectGrace;
}
