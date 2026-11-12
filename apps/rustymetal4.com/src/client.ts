import { createRoomsClient, RoomsApiError as ApiError } from "@tm4/rooms-client";
import {
  mapLabel,
  modeLabel,
  type RoomSettings,
  roomSettingsSchema,
  type RoomSnapshot,
  type RoomSummary,
} from "@tm4/rooms-client/schemas";

import { matchControls } from "./match-controls.ts";

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
function formSettings(form: HTMLFormElement): RoomSettings {
  const data = new FormData(form);
  const field = (name: string) => {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  };
  return roomSettingsSchema.parse({
    name: field("name"),
    modeId: field("modeId"),
    mapId: field("mapId"),
    capacity: Number(field("capacity")),
  });
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
        const fragment = element<HTMLTemplateElement>("room-card-template").content.cloneNode(
          true,
        ) as DocumentFragment;
        const set = (selector: string, value: string) => {
          fragment.querySelector(selector)!.textContent = value;
        };
        set(".card-mode", modeLabel(room.modeId));
        set(".card-name", room.name);
        set(".card-host", `Hosted by ${room.host}`);
        set(".card-map", mapLabel(room.mapId));
        set(".card-count", `${room.participantCount} / ${room.capacity} players`);
        set(
          ".availability",
          room.freePlaces
            ? `${room.freePlaces} ${room.freePlaces === 1 ? "place" : "places"} free`
            : "Full",
        );
        fragment.querySelector(".availability")!.classList.toggle("full", !room.freePlaces);
        const link = fragment.querySelector<HTMLAnchorElement>("a")!;
        link.href = `/rooms/${room.id}`;
        if (!room.freePlaces) link.textContent = "View room";
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
  let current: RoomSnapshot | undefined;
  let stop: (() => void) | undefined;
  let editing = false;
  let leaving = false;
  let expired = false;
  let recovery: Promise<boolean> | undefined;
  const settingsForm = element<HTMLFormElement>("settings-form");
  const renderMatch = matchControls(id, (room) => render(room));
  const render = (room: RoomSnapshot) => {
    if (current && room.version < current.version) return;
    current = room;
    renderMatch(room);
    errorAt("room-error");
    element("room-content").hidden = room.closed;
    element("room-name").textContent = room.name;
    document.title = `${room.name} · Rusty Metal 4`;
    if (room.closed) {
      errorAt("room-error", "This room has closed. Find another room in the directory.");
      stop?.();
      return;
    }
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
    element("leave-button").hidden = !room.you;
    const joinButton =
      element<HTMLFormElement>("join-form").querySelector<HTMLButtonElement>("button")!;
    joinButton.disabled = !room.freePlaces;
    joinButton.textContent = room.freePlaces ? "Join room" : "Room full";
    if (!editing)
      for (const key of ["name", "modeId", "mapId", "capacity"] as const)
        (settingsForm.elements.namedItem(key) as HTMLInputElement).value = String(room[key]);
    for (const option of element<HTMLSelectElement>("edit-capacity").options)
      option.disabled = Number(option.value) < room.participantCount;
    if (!room.you) element("room-status").textContent = "Viewing room";
    if (!room.you && stop) {
      const close = stop;
      stop = undefined;
      close();
    }
  };
  const refresh = (): Promise<boolean> => {
    if (recovery) return recovery;
    recovery = (async () => {
      try {
        await session();
        const result = await rooms.get(id);
        render(result);
        if (!result.you) element("room-status").textContent = "Viewing room";
        watch();
        return Boolean(result.you);
      } catch (error) {
        if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 410)) {
          element("room-status").textContent = current ? "Reconnecting…" : "Unavailable";
          errorAt("room-error", error);
          throw error;
        }
        expired = true;
        current = undefined;
        stop?.();
        stop = undefined;
        element("room-content").hidden = true;
        element("room-name").textContent = "Room closed";
        element("room-status").textContent = "Expired";
        errorAt("room-error", error);
        return false;
      }
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  const watch = () => {
    if (stop || !current?.you || leaving) return;
    stop = rooms.watchRoom(id, {
      update: render,
      status: (live) => {
        element("room-status").textContent = live
          ? "Live room"
          : current?.you
            ? "Reconnecting…"
            : "Viewing room";
      },
      recover: refresh,
    });
  };
  try {
    await refresh();
  } catch (error) {
    element("room-name").textContent = "Room unavailable";
    element("room-status").textContent = "Unavailable";
    errorAt("room-error", error);
  }
  // The same recovery path handles initial failures and membership found in another tab.
  setInterval(() => {
    void (async () => {
      if (stop || leaving || expired) return;
      try {
        await refresh();
      } catch (error) {
        errorAt("room-error", error);
      }
    })();
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
  submit(element<HTMLFormElement>("join-form"), "join-error", async () => {
    const form = element<HTMLFormElement>("join-form");
    await session();
    render(await rooms.join(id, rememberName(form)));
    watch();
  });
  settingsForm.addEventListener("input", () => {
    editing = true;
    element("settings-status").textContent = "";
  });
  submit(settingsForm, "settings-error", async () => {
    const result = await rooms.settings(id, formSettings(settingsForm));
    editing = false;
    render(result);
    element("settings-status").textContent = "Settings saved for everyone.";
  });
  element<HTMLButtonElement>("leave-button").onclick = () => {
    void (async () => {
      const button = element<HTMLButtonElement>("leave-button");
      button.disabled = true;
      try {
        await rooms.leave(id);
        leaving = true;
        stop?.();
        location.assign("/");
      } catch (error) {
        errorAt("room-error", error);
        button.disabled = false;
      }
    })();
  };
}
if (document.querySelector('[data-page="directory"]')) void directory();
if (document.querySelector('[data-page="room"]')) void room();
