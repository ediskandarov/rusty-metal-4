import { ffaDefaultLimits } from "@tm4/lightyear-client/schemas";
import { modeDefinitions } from "@tm4/rooms-client/modes";
import { mapLabel, roomBots, roomHumanLimit } from "@tm4/rooms-client/schemas";

import { sameCompatibility } from "../../compatibility.ts";
import type { ModeRules } from "../rules-types.ts";
const clearReady: ModeRules["preparationStarted"] = (state) => {
  for (const member of state.members) member.ready = false;
};
export const ffaRules: ModeRules = {
  minimumPlayers: modeDefinitions.ffa.minimumPlayers,
  allowLateJoin: true,
  playingMessage:
    "Match in progress. New players can join with a prepared car; existing players can reconnect.",
  readyMessage:
    "Server ready. Choose cars and ready every participant; the host can start with 1–8 players.",
  choiceError(state, member, choice) {
    const changed =
      choice.car !== member.car || !sameCompatibility(choice.compatibility, member.compatibility);
    return choice.ready &&
      (changed ||
        !choice.car ||
        !state.match ||
        !["ready", "playing"].includes(state.match.stage) ||
        !state.match.cars.includes(choice.car) ||
        !sameCompatibility(choice.compatibility, state.match.compatibility))
      ? "Select a car, load matching resources and wait for server preparation before readying."
      : null;
  },
  choiceInvalidatesReady() {
    return false;
  },
  preparationStarted: clearReady,
  serverPrepared: clearReady,
  serverOptions(settings) {
    return {
      mode: "ffa",
      players: roomHumanLimit(settings),
      bots: roomBots(settings),
      world: mapLabel(settings.mapId),
      limits: ffaDefaultLimits,
    };
  },
};
