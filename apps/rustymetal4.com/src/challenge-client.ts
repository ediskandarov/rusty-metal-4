import {
  type ChallengePlayer,
  type ChallengeRelease,
  challengeVersion,
  completion,
} from "./challenge.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const frame = element<HTMLIFrameElement>("challenge-player");
const error = (value?: unknown) => {
  const target = element("challenge-error");
  target.hidden = !value;
  target.textContent =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value
          ? "The challenge service is unavailable."
          : "";
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/challenge/${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "The challenge service is unavailable.");
  return value;
}
let player: ChallengePlayer | null = null;
let release: ChallengeRelease | null = null;
const pendingWins = new Map<string, { model: string; map: string; version: string }>();
const submitted = new Set<string>();
function profile(value: ChallengePlayer | null) {
  player = value;
  element("challenge-profile").textContent = value
    ? `${value.name}: ${value.score} models completed.`
    : "Save a display name to keep your completions.";
  if (value) element<HTMLInputElement>("challenge-name").value = value.name;
}
async function board() {
  const { players } = await api<{ players: ChallengePlayer[] }>("leaderboard");
  element("challenge-board-status").textContent = players.length
    ? "Top 100 drivers, ranked by unique models completed."
    : "No completed models yet.";
  element("challenge-board").replaceChildren(
    ...players.map((entry) => {
      const row = document.createElement("tr"),
        name = document.createElement("th"),
        score = document.createElement("td");
      name.scope = "row";
      name.textContent = entry.name;
      score.textContent = String(entry.score);
      score.title = entry.completions
        .map((item) => `${item.model} · ${item.map} · ${item.date.slice(0, 10)}`)
        .join("\n");
      row.append(name, score);
      return row;
    }),
  );
}
async function saveWin() {
  if (!player) return;
  for (const win of pendingWins.values()) {
    if (submitted.has(win.model)) continue;
    const value = await api<{ added: boolean; player: ChallengePlayer }>("completion", win);
    submitted.add(win.model);
    pendingWins.delete(win.model);
    profile(value.player);
    element("challenge-game-status").textContent = value.added
      ? `${win.model} completed! Your score is ${value.player.score}.`
      : `${win.model} was already completed. Your score stays ${value.player.score}.`;
  }
  await board();
}
element<HTMLFormElement>("challenge-name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    error();
    const name = element<HTMLInputElement>("challenge-name").value.trim();
    profile((await api<{ player: ChallengePlayer }>("profile", { name })).player);
    try {
      localStorage.setItem("rm4.playerName", name);
    } catch {
      /* Name remembering is optional. */
    }
    await saveWin();
    await board();
  })().catch(error);
});
element<HTMLButtonElement>("challenge-launch").onclick = () => {
  if (!release) return;
  frame.src = release.playerUrl;
  frame.hidden = false;
  element<HTMLButtonElement>("challenge-launch").hidden = true;
};
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || !release) return;
  const message = event.data as { type?: unknown; challenge?: Record<string, unknown> } | null;
  if (message?.type !== "tm4:200-challenge" || !message.challenge) return;
  const state = message.challenge;
  if (state.version !== challengeVersion) return;
  if (state.status === "playing")
    element("challenge-game-status").textContent =
      `${String(state.model)} · ${String(state.map)} · ${String(state.cars)} cars remaining`;
  if (state.status === "lost")
    element("challenge-game-status").textContent =
      "You were eliminated. Choose another attempt in the game.";
  if (state.status === "error") error(state.error ?? "This challenge round could not start.");
  if (state.status === "won") {
    try {
      const win = completion(state);
      pendingWins.set(win.model, win);
      if (!player)
        element("challenge-game-status").textContent =
          `${win.model} completed! Save your display name to record it.`;
      void saveWin().catch(error);
    } catch (value) {
      error(value);
    }
  }
});
void (async () => {
  try {
    element<HTMLInputElement>("challenge-name").value =
      localStorage.getItem("rm4.playerName") ?? "";
  } catch {
    /* Cookies still carry identity. */
  }
  const issue = () => api("identity", {});
  if (navigator.locks) await navigator.locks.request("rm4-challenge-identity", issue);
  else await issue();
  const [identity, pinned] = await Promise.all([
    api<{ player: ChallengePlayer | null }>("profile"),
    api<{ release: ChallengeRelease | null }>("release"),
  ]);
  profile(identity.player);
  release = pinned.release;
  element("challenge-release").textContent = release
    ? `Pinned build ${release.buildId.slice(0, 12)} · ${release.version}`
    : "The challenge build has not been published yet.";
  element<HTMLButtonElement>("challenge-launch").disabled = !release;
  await board();
})().catch(error);
