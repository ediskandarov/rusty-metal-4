import { loadDisc } from "@tm4/resources/loader/loader";
import { directorySources } from "@tm4/resources/loader/sources";

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing ${id}`);
  return node;
}
const form = element("provision", HTMLFormElement);
const secret = element("secret", HTMLInputElement);
const disc = element("disc", HTMLInputElement);
const prepare = element("prepare", HTMLButtonElement);
const progress = element("progress", HTMLParagraphElement);
const status = element("status", HTMLParagraphElement);
const players = element("players", HTMLParagraphElement);
const join = element("join", HTMLAnchorElement);
const setup = element("setup", HTMLDetailsElement);
let busy = false;

interface Status {
  phase: string;
  message: string;
  players: number;
  connected: number;
  tick: number;
  endpoint: string;
  uploaded: number;
  required: number;
}
interface Resource {
  id: string;
  size: number;
  sha256: string;
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...init.headers, Authorization: `Bearer ${secret.value}` },
  });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = (await response.json()) as Status;
    status.textContent = state.message;
    players.textContent =
      state.phase === "setup" || state.phase === "failed"
        ? `${state.uploaded}/${state.required} server resources prepared · ${state.players} player slots`
        : `${state.connected}/${state.players} players connected${state.tick ? ` · Tick ${state.tick}` : ""}`;
    join.hidden = state.phase !== "lobby" && state.phase !== "match";
    const url = new URL("play/", location.href);
    url.searchParams.set("match", state.endpoint);
    join.href = url.href;
    join.textContent = state.phase === "match" ? "Reconnect existing player" : "Open player";
    prepare.disabled = busy || (state.phase !== "setup" && state.phase !== "failed");
    if (state.phase === "setup" && !busy) setup.open = true;
  } catch (error) {
    status.textContent = `Cannot reach the native server. ${String(error)}`;
    join.hidden = true;
    prepare.disabled = true;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  void provision();
});

async function provision() {
  busy = true;
  prepare.disabled = true;
  disc.disabled = true;
  secret.disabled = true;
  try {
    const resources = (await (await api("/api/resources")).json()) as Resource[];
    const assets = await loadDisc(directorySources(disc.files ?? []), {
      progress: (message) => {
        progress.textContent = message;
      },
    });
    const required = [...resources.map((resource) => resource.id), "/DATA/files.tsv"];
    for (const [i, id] of required.entries()) {
      const bytes = assets.files.get(id);
      if (!bytes) throw new Error(`Required server resource missing: ${id}`);
      progress.textContent = `Uploading validated server resources (${i + 1}/${required.length})…`;
      await api(`/api/resources${id}`, { method: "PUT", body: bytes });
    }
    await api("/api/start", { method: "POST" });
    progress.textContent =
      "Upload complete. The native server is validating and preparing the match.";
    secret.value = "";
    disc.value = "";
  } catch (error) {
    progress.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    disc.disabled = false;
    secret.disabled = false;
    await refresh();
  }
}

await refresh();
setInterval(() => {
  void refresh();
}, 1500);
