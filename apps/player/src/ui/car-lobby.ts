import type { LobbyView } from "@tm4/game-runtime/network/match";

import { element } from "./dom.ts";

export function carLobby(): LobbyView {
  const panel = element("car-lobby", HTMLElement);
  const form = element("car-lobby-form", HTMLFormElement);
  const choice = element("car-choice", HTMLSelectElement);
  const button = element("car-ready", HTMLButtonElement);
  const playerLabel = element("car-lobby-player", HTMLElement);
  const roster = element("car-lobby-roster", HTMLOListElement);
  let current: Parameters<LobbyView>[0] = null;
  let pending: { car: string; ready: boolean } | null = null;

  function select(ready: boolean) {
    if (!current || pending) return;
    pending = { car: choice.value, ready };
    choice.disabled = button.disabled = true;
    current.select(choice.value, ready);
  }
  choice.addEventListener("change", () => select(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    select(!current?.players.find((player) => player.slot === current?.slot)?.ready);
  });
  // Keep menu controls out of SDL's keyboard input without blocking their defaults.
  for (const name of ["keydown", "keyup"])
    panel.addEventListener(name, (event) => event.stopPropagation());

  return (state) => {
    const wasVisible = !panel.hidden;
    current = state;
    panel.hidden = !state;
    if (!state) {
      pending = null;
      if (wasVisible) element("canvas", HTMLCanvasElement).focus();
      return;
    }
    const opening = choice.options.length === 0;
    if (
      choice.options.length !== state.cars.length ||
      state.cars.some((car, index) => choice.options[index]?.value !== car)
    )
      choice.replaceChildren(...state.cars.map((car) => new Option(car, car)));
    const local = state.players.find((player) => player.slot === state.slot);
    if (pending?.car === local?.car && pending?.ready === local?.ready) pending = null;
    choice.value = pending?.car ?? local?.car ?? state.cars[0] ?? "";
    choice.disabled = button.disabled = pending !== null;
    button.textContent = local?.ready ? "Not ready" : "Ready";
    playerLabel.textContent = "Player " + (state.slot + 1);
    roster.replaceChildren(
      ...state.players.map((player) => {
        const slot = player.slot;
        const row = document.createElement("li");
        row.textContent =
          "Player " +
          (slot + 1) +
          (slot === state.slot ? " (you)" : "") +
          " · " +
          (player.connected
            ? (player.car ?? "Choosing…") + " · " + (player.ready ? "Ready" : "Choosing")
            : "Waiting to join");
        return row;
      }),
    );
    if (opening) choice.focus();
  };
}
