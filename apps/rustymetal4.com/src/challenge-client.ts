import {
  type ChallengePlayer,
  type ChallengeRelease,
  challengeVersion,
  type ChallengeWin,
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
const pendingWins: { win: ChallengeWin; runId?: string; token: number }[] = [];
let saving = false;
let lastPhase: unknown;
let lastRun: unknown;
let roundToken = 0;
const records = element<HTMLDialogElement>("driver-records");
function showRecords(driver: ChallengePlayer) {
  element("driver-records-title").textContent = driver.name;
  element("driver-records-body").replaceChildren(
    ...driver.completions.map((car) => {
      const row = document.createElement("tr");
      const name = document.createElement("th");
      name.scope = "row";
      name.textContent = car.model;
      row.append(name);
      for (const value of [
        car.bestFrags ?? "—",
        car.bestMap ?? car.map,
        (car.bestDate ?? car.date).slice(0, 10),
      ]) {
        row.insertCell().textContent = String(value);
      }
      return row;
    }),
  );
  records.showModal();
}
function profile(value: ChallengePlayer | null) {
  player = value;
  element("challenge-profile").textContent = value
    ? `${value.name}: ${value.score} ${value.score === 1 ? "car" : "cars"} mastered.`
    : "Save your name to record your wins.";
  if (value) element<HTMLInputElement>("challenge-name").value = value.name;
}
async function board() {
  const { players } = await api<{ players: ChallengePlayer[] }>("leaderboard");
  element("challenge-board-status").textContent = players.length
    ? "Top 100 drivers, ranked by total score, then cars mastered."
    : "No survivors yet. Be the first.";
  element("challenge-board").replaceChildren(
    ...players.map((entry) => {
      const row = document.createElement("tr");
      const name = document.createElement("th");
      name.scope = "row";
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-haspopup", "dialog");
      button.textContent = entry.name;
      button.onclick = () => showRecords(entry);
      name.append(button);
      row.append(name);
      row.insertCell().textContent = String(entry.score);
      row.insertCell().textContent = String(entry.totalScore);
      return row;
    }),
  );
}
async function saveWin() {
  if (!player || saving || !pendingWins.length) return;
  saving = true;
  try {
    while (pendingWins.length) {
      const { win, runId, token } = pendingWins[0]!;
      const { player: updated, gain } = await api<{ player: ChallengePlayer; gain: number }>(
        "completion",
        win,
      );
      pendingWins.shift();
      profile(updated);
      if (roundToken !== token || lastPhase !== "won") continue;
      const best = updated.completions.find((car) => car.model === win.model)?.bestFrags;
      element("challenge-game-status").textContent =
        win.frags === undefined
          ? `You survived in ${win.model}!`
          : `Your frags: ${win.frags}. Personal best: ${best}. Total score: ${updated.totalScore} (+${gain}).`;
      if (runId && best != null)
        frame.contentWindow?.postMessage(
          { type: "tm4:200-challenge-score", runId, best, total: updated.totalScore, gain },
          location.origin,
        );
    }
  } finally {
    saving = false;
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
    if (pendingWins.length) await saveWin();
    else await board();
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
  const repeatedWin = lastPhase === "won" && state.status === "won" && lastRun === state.runId;
  if (lastRun !== state.runId || (lastPhase !== state.status && state.status === "playing"))
    ++roundToken;
  lastRun = state.runId;
  lastPhase = state.status;
  if (state.status === "playing")
    element("challenge-game-status").textContent =
      `${String(state.model)} · ${String(state.map)} · ${String(state.cars)} cars remaining`;
  if (state.status === "lost")
    element("challenge-game-status").textContent =
      state.frags === undefined
        ? "Wrecked. Run not counted."
        : `Your frags: ${state.frags}. Run not counted.`;
  if (state.status === "error") error(state.error ?? "This challenge round could not start.");
  if (state.status === "won" && !repeatedWin) {
    try {
      const win = completion(state);
      pendingWins.push({
        win,
        runId: typeof state.runId === "string" ? state.runId : undefined,
        token: roundToken,
      });
      if (!player)
        element("challenge-game-status").textContent =
          `You survived in ${win.model}! Save your name to record the win.`;
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
