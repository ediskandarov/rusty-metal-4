import type { PlayerEvent } from "@tm4/room-player-protocol";
import { type createRoomsClient, RoomsApiError } from "@tm4/rooms-client";
import {
  type Compatibility,
  roomModeCapacity,
  type RoomSettings,
  roomSettingsSchema,
  type RoomSnapshot,
} from "@tm4/rooms-client/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  type CarSelectionSlice,
  createCarSelectionSlice,
  initialCarSelection,
  playerChoice,
} from "../modes/car-selection/state.ts";

type RoomsClient = ReturnType<typeof createRoomsClient>;
type Operation = "join" | "settings" | "leave" | "player" | "prepare" | "cancel" | "start";
type ErrorTarget = "room" | "join" | "settings" | "player";
type Connection = "loading" | "live" | "reconnecting" | "viewing" | "unavailable" | "expired";
type SettingsDraft = Omit<RoomSettings, "capacity">;
interface Disc {
  compatibility: Compatibility;
  cars: readonly string[];
}
export interface RoomState extends CarSelectionSlice {
  room: RoomSnapshot | null;
  connection: Connection;
  departed: boolean;
  operation: Operation | null;
  errors: Record<ErrorTarget, string | null>;
  settingsDraft: SettingsDraft | null;
  settingsSaved: boolean;
  runtime: "checking" | "available" | "unavailable";
  disc: Disc | null;
  playerNeedsSync: boolean;
  playerStatus: string;
  uploadReport: Extract<PlayerEvent, { event: "upload" }> | null;
  uploadReported: (report: Extract<PlayerEvent, { event: "upload" }>) => void;
  returnedResult: string | null;
  returnToRoom: () => void;
  journal: { downloading: boolean; message: string };
  receive: (room: RoomSnapshot) => void;
  connectionChanged: (live: boolean) => void;
  loadFailed: (error: unknown) => void;
  editSettings: (draft: SettingsDraft) => void;
  join: (name: string) => Promise<boolean>;
  saveSettings: () => Promise<void>;
  leave: () => Promise<boolean>;
  runtimeChecked: (available: boolean) => void;
  playerLoaded: (disc: Disc | null) => void;
  playerReported: (message: string) => void;
  prepare: () => Promise<string | null>;
  cancel: () => Promise<void>;
  start: () => Promise<void>;
  downloadJournal: () => Promise<
    ({ matchId: string } & Awaited<ReturnType<RoomsClient["journal"]>>) | null
  >;
}

export function roomMember(state: RoomState) {
  return state.room?.participants.find((member) => member.id === state.room?.you);
}
export function roomCarChoices(state: RoomState): readonly string[] {
  const cars = state.disc?.cars ?? [];
  const match = state.room?.match;
  return match?.stage === "playing" && !match.endpoint
    ? cars.filter((car) => match.cars.includes(car))
    : cars;
}
export function roomConnectionLabel(state: RoomState) {
  if (state.room?.closed) return "Room closed";
  return {
    loading: "Connecting…",
    live: "Live room",
    reconnecting: "Reconnecting…",
    viewing: "Viewing room",
    unavailable: "Unavailable",
    expired: "Expired",
  }[state.connection];
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createRoomStore(id: string, rooms: RoomsClient, session: () => Promise<unknown>) {
  const store: StoreApi<RoomState> = createStore<RoomState>()((set, get, api) => ({
    ...createCarSelectionSlice(syncPlayer)(set, get, api),
    room: null,
    connection: "loading",
    departed: false,
    operation: null,
    errors: { room: null, join: null, settings: null, player: null },
    settingsDraft: null,
    settingsSaved: false,
    runtime: "checking",
    disc: null,
    playerNeedsSync: false,
    playerStatus: "",
    uploadReport: null,
    returnedResult: null,
    returnToRoom() {
      set({ returnedResult: get().room?.result?.matchId ?? null });
    },
    journal: { downloading: false, message: "" },
    receive(room) {
      const state = get();
      if (
        state.departed ||
        state.connection === "expired" ||
        state.room?.closed ||
        room.id !== id ||
        (state.room && room.version < state.room.version)
      )
        return;
      const memberChanged = state.room?.you !== room.you;
      const modeChanged = state.room?.modeId !== room.modeId;
      const previousMember = roomMember(state);
      const incomingMember = room.participants.find((member) => member.id === room.you);
      // A fresh room tab has no loaded disc; it must not strand another tab's retained resources.
      const retainedDiscNeedsSync =
        !memberChanged &&
        !!state.disc &&
        (modeChanged || (!!previousMember?.loaded && !incomingMember?.loaded)) &&
        !room.match?.endpoint;

      const reset = memberChanged || room.closed;
      const roomError = room.closed
        ? "This room has closed. Find another room in the directory."
        : null;
      const canEdit = room.you !== null && room.you === room.hostId && !room.match && !room.closed;
      set({
        room,
        uploadReport:
          !reset &&
          room.match?.id === state.uploadReport?.sessionId &&
          room.match?.stage === "uploading"
            ? state.uploadReport
            : null,
        connection: !room.you ? "viewing" : state.connection === "live" ? "live" : "reconnecting",
        errors: reset
          ? { room: roomError, join: null, settings: null, player: null }
          : { ...state.errors, room: roomError },
        ...(!canEdit ? { settingsDraft: null, settingsSaved: false } : {}),
        ...(reset
          ? {
              disc: null,
              playerNeedsSync: false,
              playerStatus: "",
            }
          : {}),
        ...(reset ||
        modeChanged ||
        (state.room?.match &&
          state.room.match.id !== room.match?.id &&
          ["starting", "connecting", "playing", "stopping"].includes(state.room.match.stage))
          ? { carSelection: initialCarSelection() }
          : {}),
        ...(room.match?.endpoint ? { playerNeedsSync: false } : {}),
        ...(retainedDiscNeedsSync ? { playerNeedsSync: true } : {}),
      });
      if (retainedDiscNeedsSync && !get().operation) void syncPlayer();
    },
    connectionChanged(live) {
      if (get().departed || get().connection === "expired" || get().room?.closed) return;
      set({ connection: get().room?.you ? (live ? "live" : "reconnecting") : "viewing" });
    },
    loadFailed(error) {
      if (get().departed || get().connection === "expired" || get().room?.closed) return;
      const expired =
        error instanceof RoomsApiError && (error.status === 404 || error.status === 410);
      set({
        connection: expired ? "expired" : get().room ? "reconnecting" : "unavailable",
        errors: { ...get().errors, room: errorMessage(error) },
        ...(expired
          ? {
              room: null,
              disc: null,
              carSelection: initialCarSelection(),
              playerNeedsSync: false,
              settingsDraft: null,
            }
          : {}),
      });
    },
    editSettings(settingsDraft) {
      set({ settingsDraft, settingsSaved: false, errors: { ...get().errors, settings: null } });
    },
    async join(name) {
      return !!(await perform("join", "join", async () => {
        await session();
        return rooms.join(id, name);
      }));
    },
    async saveSettings() {
      const draft = get().settingsDraft;
      const room = get().room;
      if (!room) return;
      const result = await perform("settings", "settings", () =>
        rooms.settings(
          id,
          roomSettingsSchema.parse({
            ...(draft ?? room),
            capacity: roomModeCapacity((draft ?? room).modeId),
          }),
        ),
      );
      if (result && get().settingsDraft === draft)
        set({ settingsDraft: null, settingsSaved: true });
    },
    async leave() {
      const result = await perform("leave", "room", () => rooms.leave(id));
      if (!result) return false;
      set({
        departed: true,
        disc: null,
        playerNeedsSync: false,
        carSelection: initialCarSelection(),
      });
      return true;
    },
    runtimeChecked(available) {
      set({ runtime: available ? "available" : "unavailable" });
    },
    playerLoaded(disc) {
      if (!get().room?.you || get().room?.closed || get().departed) return;
      set({
        disc,
        uploadReport: null,
        carSelection: initialCarSelection(),
        playerNeedsSync: !get().room?.match?.endpoint,
      });
      void syncPlayer();
    },
    uploadReported(report) {
      const state = get();
      if (
        state.departed ||
        state.room?.closed ||
        state.room?.match?.id !== report.sessionId ||
        state.room.match.stage !== "uploading"
      )
        return;
      set({ uploadReport: report.phase === "complete" ? null : report });
    },
    playerReported(playerStatus) {
      if (playerStatus !== get().playerStatus) set({ playerStatus });
    },
    async prepare() {
      const room = get().room;
      if (!room || get().operation) return null;
      const result = room.match
        ? room
        : await perform("prepare", "player", () => rooms.prepare(id));
      return result?.match?.id ?? null;
    },
    async cancel() {
      const match = get().room?.match;
      if (match) await perform("cancel", "player", () => rooms.cancel(id, match.id));
    },
    async start() {
      await perform("start", "player", () => rooms.start(id));
    },
    async downloadJournal() {
      const state = get();
      const matchId = state.room?.match?.id ?? state.room?.journal?.matchId;
      if (!matchId || state.journal.downloading) return null;
      set({ journal: { downloading: true, message: "Downloading server journal…" } });
      try {
        const result = await rooms.journal(id, matchId);
        set({
          journal: {
            downloading: false,
            message:
              "Journal saved through " +
              new Date(result.savedAt).toLocaleTimeString() +
              ". Archives remain available for 24 hours while this room exists.",
          },
        });
        return { ...result, matchId };
      } catch (error) {
        set({ journal: { downloading: false, message: errorMessage(error) } });
        return null;
      }
    },
  }));

  async function perform(
    operation: Operation,
    target: ErrorTarget,
    request: () => Promise<RoomSnapshot>,
  ): Promise<RoomSnapshot | null> {
    const before = store.getState();
    if (
      before.operation ||
      before.departed ||
      before.connection === "expired" ||
      before.room?.closed
    )
      return null;
    store.setState({ operation, errors: { ...before.errors, [target]: null } });
    try {
      const result = await request();
      const state = store.getState();
      if (
        operation === "leave" &&
        !result.you &&
        (!state.room?.you || state.room.you === before.room?.you)
      ) {
        state.receive(result);
        return result;
      }
      // A response to a previous membership must not reopen its player or restore its selection.
      if (
        state.departed ||
        state.connection === "expired" ||
        state.room?.closed ||
        (operation !== "join" && before.room?.you !== state.room?.you) ||
        (operation === "player" &&
          (before.room?.modeId !== state.room?.modeId || before.disc !== state.disc))
      )
        return null;
      state.receive(result);
      return store.getState().room;
    } catch (error) {
      const state = store.getState();
      if (
        !state.departed &&
        state.connection !== "expired" &&
        !state.room?.closed &&
        before.room?.you === state.room?.you &&
        (operation !== "player" ||
          (before.room?.modeId === state.room?.modeId && before.disc === state.disc))
      )
        store.setState({ errors: { ...state.errors, [target]: errorMessage(error) } });
      return null;
    } finally {
      store.setState({
        operation: null,
      });
      if (store.getState().playerNeedsSync) void syncPlayer();
    }
  }
  async function syncPlayer() {
    const state = store.getState();
    if (
      state.operation ||
      !state.room?.you ||
      state.room.match?.endpoint ||
      state.room.closed ||
      state.departed
    )
      return;
    const choice = playerChoice(state);
    store.setState({ playerNeedsSync: false });
    await perform("player", "player", () =>
      rooms.player(id, {
        car: choice.car,
        compatibility: state.disc?.compatibility ?? null,
        ready: choice.ready,
      }),
    );
  }
  return store;
}
export type RoomStore = ReturnType<typeof createRoomStore>;
