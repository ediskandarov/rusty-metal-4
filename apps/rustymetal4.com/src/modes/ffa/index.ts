import type { RoomMode } from "../types.ts";
import { ffaControls } from "./selectors.ts";
import { ffaSettings } from "./settings.ts";
export const ffa: RoomMode = {
  settings: ffaSettings,
  createControls(store, send) {
    const car = document.getElementById("room-car") as HTMLSelectElement;
    const ready = document.getElementById("room-ready") as HTMLButtonElement;
    car.onchange = () => {
      void store.getState().selectCar(car.value);
    };
    ready.onclick = () => {
      void store.getState().toggleReady();
    };
    return {
      reset() {
        store.getState().ffaStatusSent(null);
        car.onchange = null;
        ready.onclick = null;
      },
      sync() {
        const state = store.getState();
        const view = ffaControls(state);
        if (!view) return;
        const match = state.room?.match;
        const status = view.playerStatus;
        const signature = status ? JSON.stringify([match?.id ?? null, status]) : null;
        if (signature !== state.ffa.sentStatus) {
          state.ffaStatusSent(signature);
          if (status) send({ action: "status", sessionId: match?.id ?? null, message: status });
        }
      },
      render() {
        const state = store.getState();
        const view = ffaControls(state);
        if (!view) return;
        car.closest("label")!.hidden = false;
        ready.hidden = false;
        document.getElementById("match-help")!.textContent =
          "Each player loads their own disc below. Only the host uploads required resources to the private match server. Start with at least one ready human player; bots use their reserved places.";
        document.getElementById("match-status")!.textContent = view.matchStatus;
        const choices = view.choices;
        if (
          car.options.length !== choices.length ||
          choices.some((name, index) => car.options[index]?.value !== name)
        )
          car.replaceChildren(...choices.map((name) => new Option(name, name)));
        car.value = view.selectedCar ?? "";
        car.disabled = view.carDisabled;
        ready.disabled = view.readyDisabled;
        ready.textContent = view.readyLabel;
      },
    };
  },
  results(result) {
    const winners = result.participants.filter((row) => row.winner);
    const reason =
      result.completion.reasons === 3
        ? "Time and frag limits reached"
        : result.completion.reasons === 2
          ? "Frag limit reached"
          : "Time limit reached";
    return {
      summary:
        reason +
        " · " +
        (winners.length > 1
          ? "Tied winners: "
          : winners.length
            ? "Winner: "
            : "No remaining participants") +
        winners.map((row) => row.name).join(", "),
      rows: [...result.participants]
        .sort((a, b) => b.score.frags - a.score.frags || a.identity.slot - b.identity.slot)
        .map((participant) => ({
          participant,
          outcome: participant.winner ? (winners.length > 1 ? "Tied winner" : "Winner") : "",
        })),
    };
  },
};
