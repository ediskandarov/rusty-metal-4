import { modeDefinitions } from "@tm4/rooms-client/modes";

import type { ModeSettings } from "../types.ts";
export const tournamentSettings: ModeSettings = {
  render(form) {
    (form.elements.namedItem("mapId") as HTMLSelectElement).disabled = true;
  },
  read() {
    return { mapId: modeDefinitions.tournament.firstMap, modeOptions: undefined };
  },
};
