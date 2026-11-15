import { roomCarChoices, roomMember, roomSelectedCar } from "../../state/room.ts";
import type { RoomMode } from "../types.ts";
import { ffaRules } from "./rules.ts";
import { ffaSettings } from "./settings.ts";
export const ffa: RoomMode = {
  rules: ffaRules,
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
        const { room, disc } = state;
        if (!room) return;
        const match = room.match;
        const status =
          disc && !match?.endpoint
            ? match?.message || room.notice || "Disc loaded. Choose your car in the room."
            : null;
        const signature = status ? JSON.stringify([match?.id ?? null, status]) : null;
        if (signature !== state.ffa.sentStatus) {
          state.ffaStatusSent(signature);
          if (status) send({ action: "status", sessionId: match?.id ?? null, message: status });
        }
      },
      render() {
        const state = store.getState();
        const { room, disc, operation } = state;
        const self = roomMember(state);
        if (!room || !self) return;
        const match = room.match;
        const joining = match?.stage === "playing" && !match.endpoint;
        const locked =
          !!match &&
          ["starting", "connecting", "playing", "stopping"].includes(match.stage) &&
          !joining;
        car.closest("label")!.hidden = false;
        ready.hidden = false;
        document.getElementById("match-help")!.textContent =
          "Each player loads their own disc below. Only the host uploads required resources to the private match server. Start with at least one ready human player; bots use their reserved places.";
        document.getElementById("match-status")!.textContent =
          match?.message || room.notice || "Load your disc, then the host can prepare the server.";
        const choices = roomCarChoices(state);
        if (
          car.options.length !== choices.length ||
          choices.some((name, index) => car.options[index]?.value !== name)
        )
          car.replaceChildren(...choices.map((name) => new Option(name, name)));
        car.value = roomSelectedCar(state) ?? "";
        car.disabled = operation !== null || !disc || locked;
        ready.disabled =
          operation !== null || !disc || (match?.stage !== "ready" && !joining) || !self.car;
        ready.textContent = joining ? "Join match" : self.ready ? "Not ready" : "Ready";
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
