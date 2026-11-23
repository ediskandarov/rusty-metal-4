import { ffaDefaultLimits } from "@tm4/lightyear-client/schemas";
import { modeDefinitions } from "@tm4/rooms-client/modes";
import { mapLabel, roomBots, roomHumanLimit } from "@tm4/rooms-client/schemas";

import { sameCompatibility } from "../../compatibility.ts";
import { carSelectionRules } from "../car-selection/rules.ts";
import type { ModeRules } from "../rules-types.ts";
export const ffaRules: ModeRules = {
  minimumPlayers: modeDefinitions.ffa.minimumPlayers,
  allowLateJoin: true,
  playingMessage:
    "Match in progress. New players can join with a prepared car; existing players can reconnect.",
  readyMessage:
    "Server ready. Confirm cars with Done in the game; the host can start with 1–8 players.",
  ...carSelectionRules,
  choiceError(state, member, choice) {
    const match = state.match;
    if (match && ["ready", "playing"].includes(match.stage))
      return choice.ready &&
        (!choice.car ||
          !match.cars.includes(choice.car) ||
          !sameCompatibility(choice.compatibility, match.compatibility))
        ? "Choose a car available on the prepared server with matching resources."
        : null;
    return carSelectionRules.choiceError(state, member, choice);
  },
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
