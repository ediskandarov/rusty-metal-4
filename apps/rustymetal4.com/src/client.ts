import { createRoomsClient, RoomsApiError as ApiError } from "@tm4/rooms-client";
import { mapLabel, modeLabel, type RoomSummary } from "@tm4/rooms-client/schemas";

import { matchControls } from "./match-controls.ts";
import { createRoomStore, roomConnectionLabel } from "./state/room.ts";

const rooms = createRoomsClient({ baseURL: new URL("/api/", location.href) });

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const errorAt = (id: string, error?: unknown) => {
  const target = element(id);
  target.textContent =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error
          ? "The room service is unavailable."
          : "";
  target.hidden = !error;
};
async function session(): Promise<number> {
  // Two first-visit tabs must not replace each other's freshly issued browser credential.
  const issue = () => rooms.session();
  const result = navigator.locks
    ? await navigator.locks.request("rm4-session", issue)
    : await issue();
  return result.serverTime;
}
function rememberName(form: HTMLFormElement): string {
  const entry = new FormData(form).get("playerName");
  const value = typeof entry === "string" ? entry.trim() : "";
  try {
    localStorage.setItem("rm4.playerName", value);
  } catch {
    /* Name remembering is optional. */
  }
  return value;
}
function fillName(id: string): void {
  try {
    element<HTMLInputElement>(id).value = localStorage.getItem("rm4.playerName") ?? "";
  } catch {
    /* Cookies still carry membership. */
  }
}
function submit(form: HTMLFormElement, errorId: string, action: () => Promise<void>): void {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      if (button.disabled) return;
      button.disabled = true;
      errorAt(errorId);
      try {
        await action();
      } catch (error) {
        errorAt(errorId, error);
      } finally {
        button.disabled = false;
      }
    })();
  });
}
async function directory(): Promise<void> {
  const list = element("rooms");
  const render = (rooms: RoomSummary[]) => {
    element("room-count").textContent = String(rooms.length);
    errorAt("directory-error");
    if (!rooms.length) {
      list.replaceChildren(element<HTMLTemplateElement>("empty-template").content.cloneNode(true));
      element("first-room").onclick = () => element("create-player").focus();
      return;
    }
    list.replaceChildren(
      ...rooms.map((room) => {
        const fragment = element<HTMLTemplateElement>("room-row-template").content.cloneNode(
          true,
        ) as DocumentFragment;
        const set = (selector: string, value: string) => {
          fragment.querySelector(selector)!.textContent = value;
        };
        set(".room-name", room.name);
        set(".room-players", `${room.participantCount} / ${room.capacity}`);
        set(".room-mode", modeLabel(room.modeId));
        set(".room-map", room.mapId ? mapLabel(room.mapId) : "Not selected");
        for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
          link.href = `/rooms/${room.id}`;
        }
        fragment.querySelector(".room-join")!.setAttribute("aria-label", `Join ${room.name}`);
        return fragment;
      }),
    );
  };
  const refresh = async () => {
    render(await rooms.list());
    return true;
  };
  try {
    await refresh();
  } catch (error) {
    errorAt("directory-error", error);
    list.replaceChildren();
  }
  rooms.watchDirectory({
    update: render,
    status: (live) => {
      element("directory-status").textContent = live ? "Live directory" : "Reconnecting…";
    },
    recover: refresh,
  });
  const form = element<HTMLFormElement>("create-form");
  fillName("create-player");
  let requestId: string | null = null;
  try {
    requestId = sessionStorage.getItem("rm4.pendingCreation");
  } catch {
    /* Retries in this tab still share the in-memory ID. */
  }
  submit(form, "create-error", async () => {
    const serverTime = await session();
    requestId ??= `${serverTime}.${crypto.randomUUID()}`;
    try {
      sessionStorage.setItem("rm4.pendingCreation", requestId);
    } catch {
      /* Optional retry persistence. */
    }
    try {
      const room = await rooms.create({
        name: element<HTMLInputElement>("create-name").value,
        playerName: rememberName(form),
        requestId,
      });
      try {
        sessionStorage.removeItem("rm4.pendingCreation");
      } catch {
        /* Optional retry persistence. */
      }
      location.assign(`/rooms/${room.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        requestId = null;
        try {
          sessionStorage.removeItem("rm4.pendingCreation");
        } catch {
          /* Optional retry persistence. */
        }
      }
      throw error;
    }
  });
}

async function room(): Promise<void> {
  const id = /^\/rooms\/([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1];
  if (!id) {
    errorAt("room-error", "This invite link is incomplete. Open a room from the directory.");
    return;
  }
  const store = createRoomStore(id, rooms, session);
  let stop: (() => void) | undefined;
  let recovery: Promise<boolean> | undefined;
  const settingsForm = element<HTMLFormElement>("settings-form");
  const joinForm = element<HTMLFormElement>("join-form");
  const stopWatching = () => {
    const close = stop;
    stop = undefined;
    close?.();
  };
  const render = () => {
    const state = store.getState();
    const { room, operation } = state;
    errorAt("room-error", state.errors.room);
    errorAt("join-error", state.errors.join);
    errorAt("settings-error", state.errors.settings);
    element("settings-status").textContent = state.settingsSaved
      ? "Settings saved for everyone."
      : "";
    element("room-status").textContent = roomConnectionLabel(state);
    element("room-content").hidden = !room || room.closed || state.departed;
    element("room-name").textContent =
      room?.name ??
      (state.connection === "expired"
        ? "Room closed"
        : state.connection === "unavailable"
          ? "Room unavailable"
          : "Opening room…");
    if (!room || !room.you || room.closed || state.departed) stopWatching();
    if (!room || room.closed || state.departed) return;
    document.title = `${room.name} · Rusty Metal 4`;
    element("room-mode").textContent = modeLabel(room.modeId);
    element("room-map").textContent = mapLabel(room.mapId);
    element("room-capacity").textContent = `${room.participantCount} / ${room.capacity} players`;
    element("member-count").textContent = String(room.participantCount);
    element("room-free").textContent =
      `${room.freePlaces} ${room.freePlaces === 1 ? "place" : "places"} free`;
    element("participants").replaceChildren(
      ...room.participants.map((member) => {
        const fragment = element<HTMLTemplateElement>("participant-template").content.cloneNode(
          true,
        ) as DocumentFragment;
        fragment.querySelector(".participant-name")!.textContent =
          member.name + (member.id === room.you ? " (you)" : "");
        fragment.querySelector(".participant-role")!.textContent =
          member.id === room.hostId ? "HOST" : "";
        const presence = fragment.querySelector(".participant-presence")!;
        presence.textContent =
          (member.connected ? "Online" : "Reconnecting…") +
          (member.car ? " · " + member.car : "") +
          (member.ready ? " · Ready" : "");
        presence.classList.toggle("online", member.connected);
        return fragment;
      }),
    );
    const host = room.you !== null && room.you === room.hostId;
    element("settings-panel").hidden = !host || !!room.match;
    element("join-panel").hidden = room.you !== null;
    const leave = element<HTMLButtonElement>("leave-button");
    leave.hidden = !room.you;
    leave.disabled = operation !== null;
    const joinButton = joinForm.querySelector<HTMLButtonElement>("button")!;
    joinButton.disabled = operation !== null || !room.freePlaces;
    joinButton.textContent = room.freePlaces ? "Join room" : "Room full";
    settingsForm.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled =
      operation !== null;
    const settings = state.settingsDraft ?? room;
    for (const key of ["name", "modeId", "mapId"] as const) {
      const field = settingsForm.elements.namedItem(key) as HTMLInputElement;
      if (field.value !== settings[key]) field.value = settings[key];
    }
  };
  store.subscribe(render);
  matchControls(id, store);
  render();
  const refresh = (): Promise<boolean> => {
    if (recovery) return recovery;
    if (
      store.getState().departed ||
      store.getState().connection === "expired" ||
      store.getState().room?.closed
    )
      return Promise.resolve(false);
    recovery = (async () => {
      try {
        await session();
        store.getState().receive(await rooms.get(id));
        watch();
        return Boolean(store.getState().room?.you);
      } catch (error) {
        store.getState().loadFailed(error);
        if (store.getState().connection !== "expired") throw error;
        return false;
      }
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  const watch = () => {
    const state = store.getState();
    if (
      stop ||
      !state.room?.you ||
      state.room.closed ||
      state.departed ||
      state.operation === "leave"
    )
      return;
    stop = rooms.watchRoom(id, {
      update: (room) => store.getState().receive(room),
      status: (live) => store.getState().connectionChanged(live),
      recover: refresh,
    });
  };
  try {
    await refresh();
  } catch {
    /* The store displays the error; polling retries. */
  }
  // The same recovery path handles initial failures and membership found in another tab.
  setInterval(() => {
    const state = store.getState();
    if (!stop && state.operation !== "leave") void refresh().catch(() => {});
  }, 5000);
  fillName("join-player");
  const invite = element<HTMLInputElement>("invite-link");
  invite.value = `${location.origin}/rooms/${id}`;
  element("copy-invite").onclick = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(invite.value);
        element("copy-status").textContent = "Link copied.";
      } catch {
        invite.select();
        element("copy-status").textContent = "Select and copy the invite link above.";
      }
    })();
  };
  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void store
      .getState()
      .join(rememberName(joinForm))
      .then((joined) => {
        if (joined) watch();
      });
  });
  settingsForm.addEventListener("input", () => {
    const field = (name: string) =>
      (settingsForm.elements.namedItem(name) as HTMLInputElement).value;
    store.getState().editSettings({
      name: field("name"),
      modeId: field("modeId"),
      mapId: field("mapId"),
    });
  });
  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void store.getState().saveSettings();
  });
  element<HTMLButtonElement>("leave-button").onclick = () => {
    void store
      .getState()
      .leave()
      .then((left) => {
        if (left) {
          stopWatching();
          location.assign("/");
        }
      });
  };
}
if (document.querySelector('[data-page="directory"]')) void directory();
if (document.querySelector('[data-page="room"]')) void room();
