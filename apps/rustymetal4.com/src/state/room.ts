import type { TournamentStatus } from "@tm4/room-player-protocol";
import { type createRoomsClient, RoomsApiError } from "@tm4/rooms-client";
import {
  type Compatibility,
  roomModeCapacity,
  roomSettingsSchema,
  type RoomSnapshot,
} from "@tm4/rooms-client/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

type RoomsClient = ReturnType<typeof createRoomsClient>;
type Operation = "join" | "settings" | "leave" | "player" | "prepare" | "cancel" | "start";
type ErrorTarget = "room" | "join" | "settings" | "player";
type Connection = "loading" | "live" | "reconnecting" | "viewing" | "unavailable" | "expired";
interface SettingsDraft {
  name: string;
  modeId: string;
  mapId: string;
  modeOptions?: { ffa: { bots: string[]; humanLimit: number } };
}
interface Disc {
  compatibility: Compatibility;
  cars: readonly string[];
}
interface RoomState {
  room: RoomSnapshot | null;
  connection: Connection;
  departed: boolean;
  operation: Operation | null;
  errors: Record<ErrorTarget, string | null>;
  settingsDraft: SettingsDraft | null;
  settingsSaved: boolean;
  runtime: "checking" | "available" | "unavailable";
  disc: Disc | null;
  carDraft: string | undefined;
  tournamentChoice: { car: string | null } | null;
  playerNeedsSync: boolean;
  playerStatus: string;
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
  selectCar: (car: string) => Promise<void>;
  toggleReady: () => Promise<void>;
  engineCarSelected: (car: string | null) => Promise<void>;
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
export function roomSelectedCar(state: RoomState): string | null {
  const cars = roomCarChoices(state);
  if (state.room?.modeId === "tournament" && state.tournamentChoice)
    return state.tournamentChoice.car;
  const selected = state.carDraft ?? roomMember(state)?.car;
  return selected && cars.includes(selected)
    ? selected
    : state.room?.modeId === "tournament"
      ? null
      : (cars[0] ?? null);
}
export function roomTournamentStatus(state: RoomState): TournamentStatus {
  if (state.connection !== "live")
    return {
      phase: "reconnecting",
      title: "Reconnecting to the room…",
      message: "Waiting for the server to confirm the players' readiness.",
    };
  if (state.errors.player)
    return {
      phase: "error",
      title: "Your choice was not confirmed",
      message: state.errors.player + " Press Done to retry, or Back to choose again.",
    };
  if (state.operation === "player" || state.playerNeedsSync)
    return {
      phase: "confirming",
      title: "Confirming your choice…",
      message: "Waiting for the room server.",
    };
  const self = roomMember(state);
  if (!self?.ready)
    return {
      phase: "choosing",
      title: "Choose your car",
      message: "Use the game controls below. Done confirms your choice; Back cancels it.",
    };
  const other = state.room?.participants.find((member) => member.id !== self.id);
  const back = "Use Back to change your choice.";
  if (!other)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: "Waiting for a second player to join. " + back,
    };
  if (!other.connected)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: `Waiting for ${other.name} to reconnect. ` + back,
    };
  if (!other.ready)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: `Waiting for ${other.name} to choose a car. ` + back,
    };
  return {
    phase: "ready",
    title: "Both cars confirmed",
    message: "Car selection is complete. Tournament battles are not available yet. " + back,
  };
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
  const store: StoreApi<RoomState> = createStore<RoomState>()((set, get) => ({
    room: null,
    connection: "loading",
    departed: false,
    operation: null,
    errors: { room: null, join: null, settings: null, player: null },
    settingsDraft: null,
    settingsSaved: false,
    runtime: "checking",
    disc: null,
    carDraft: undefined,
    tournamentChoice: null,
    playerNeedsSync: false,
    playerStatus: "",
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
        connection: !room.you ? "viewing" : state.connection === "live" ? "live" : "reconnecting",
        errors: reset
          ? { room: roomError, join: null, settings: null, player: null }
          : { ...state.errors, room: roomError },
        ...(!canEdit ? { settingsDraft: null, settingsSaved: false } : {}),
        ...(reset
          ? {
              disc: null,
              carDraft: undefined,
              tournamentChoice: null,
              playerNeedsSync: false,
              playerStatus: "",
            }
          : {}),
        ...(modeChanged ? { carDraft: undefined, tournamentChoice: null } : {}),
        ...(room.match?.endpoint ? { playerNeedsSync: false } : {}),
        ...(retainedDiscNeedsSync
          ? {
              playerNeedsSync: true,
              carDraft: modeChanged
                ? undefined
                : (state.carDraft ?? previousMember?.car ?? undefined),
            }
          : {}),
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
              carDraft: undefined,
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
      set({ departed: true, disc: null, playerNeedsSync: false });
      return true;
    },
    runtimeChecked(available) {
      set({ runtime: available ? "available" : "unavailable" });
    },
    playerLoaded(disc) {
      if (!get().room?.you || get().room?.closed || get().departed) return;
      set({
        disc,
        carDraft: undefined,
        tournamentChoice: null,
        playerNeedsSync: !get().room?.match?.endpoint,
      });
      void syncPlayer();
    },
    playerReported(playerStatus) {
      if (playerStatus !== get().playerStatus) set({ playerStatus });
    },
    async selectCar(car) {
      if (get().operation || !get().disc || !roomCarChoices(get()).includes(car)) return;
      set({ carDraft: car });
      await syncPlayer();
    },
    async engineCarSelected(car) {
      const state = get();
      if (
        state.room?.modeId !== "tournament" ||
        !state.disc ||
        (car !== null && !roomCarChoices(state).includes(car))
      )
        return;
      set({ tournamentChoice: { car }, playerNeedsSync: true });
      await syncPlayer();
    },
    async toggleReady() {
      await syncPlayer(!roomMember(get())?.ready);
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
        (operation !== "join" && before.room?.you !== state.room?.you)
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
        before.room?.you === state.room?.you
      )
        store.setState({ errors: { ...state.errors, [target]: errorMessage(error) } });
      return null;
    } finally {
      store.setState({
        operation: null,
        ...(operation === "player" ? { carDraft: undefined } : {}),
      });
      if (store.getState().playerNeedsSync) void syncPlayer();
    }
  }
  async function syncPlayer(ready?: boolean) {
    const state = store.getState();
    if (
      state.operation ||
      !state.room?.you ||
      state.room.match?.endpoint ||
      state.room.closed ||
      state.departed
    )
      return;
    store.setState({ playerNeedsSync: false });
    await perform("player", "player", () =>
      rooms.player(id, {
        car: roomSelectedCar(state),
        compatibility: state.disc?.compatibility ?? null,
        ready: ready ?? (state.room?.modeId === "tournament" && !!state.tournamentChoice?.car),
      }),
    );
  }
  return store;
}
export type RoomStore = ReturnType<typeof createRoomStore>;
