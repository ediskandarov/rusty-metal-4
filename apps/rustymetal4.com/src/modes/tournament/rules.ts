import { modeDefinitions } from "@tm4/rooms-client/modes";
import { mapLabel, roomHumanLimit } from "@tm4/rooms-client/schemas";

import { carSelectionRules } from "../car-selection/rules.ts";
import type { ModeRules } from "../rules-types.ts";
export const tournamentRules: ModeRules = {
  minimumPlayers: modeDefinitions.tournament.minimumPlayers,
  allowLateJoin: false,
  playingMessage: "Tournament battle in progress. The two participants can reconnect.",
  readyMessage: "Server ready. Both players must confirm their cars before the host starts.",
  ...carSelectionRules,
  serverOptions(settings) {
    return {
      mode: "tournament",
      players: roomHumanLimit(settings),
      bots: [],
      world: mapLabel(settings.mapId),
    };
  },
};
