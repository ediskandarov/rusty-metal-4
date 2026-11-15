import { ffaCapacity } from "@tm4/rooms-client/modes";
import { roomSettingsSchema } from "@tm4/rooms-client/schemas";

import type { ModeSettings } from "../types.ts";
export const ffaSettings: ModeSettings = {
  render(form, state) {
    const { operation } = state;
    const settings = state.settingsDraft ?? state.room!;
    const bots = form.elements.namedItem("bots") as HTMLSelectElement;
    const selected = settings.modeOptions?.ffa.bots ?? [];
    const humanLimit = form.elements.namedItem("humanLimit") as HTMLInputElement;
    humanLimit.max = String(ffaCapacity - selected.length);
    humanLimit.value = String(settings.modeOptions?.ffa.humanLimit ?? ffaCapacity);
    humanLimit.disabled = operation !== null;
    (form.elements.namedItem("mapId") as HTMLSelectElement).disabled = false;
    const choices = [...new Set([...(state.disc?.cars ?? []), ...selected])];
    if (JSON.stringify(Array.from(bots.options, (o) => o.value)) !== JSON.stringify(choices))
      bots.replaceChildren(...choices.map((name) => new Option(name, name)));
    for (const option of bots.options) option.selected = selected.includes(option.value);
    bots.disabled = operation !== null || !state.disc;
    const botHelp = form.querySelector<HTMLElement>("[id$='-bots-help']")!;
    botHelp.textContent = state.disc
      ? selected.length + " bots · " + humanLimit.value + " human places"
      : "Load your disc to choose bots.";
  },
  read(form, target) {
    const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    const mapId = roomSettingsSchema.shape.mapId.parse(field("mapId"));
    if (target === form.elements.namedItem("modeId")) return { mapId, modeOptions: undefined };
    const bots = Array.from(
      (form.elements.namedItem("bots") as HTMLSelectElement).selectedOptions,
      (option) => option.value,
    );
    const humanLimit = Number(field("humanLimit"));
    return {
      mapId,
      modeOptions: {
        ffa: {
          bots,
          humanLimit:
            target === form.elements.namedItem("bots")
              ? Math.min(humanLimit, ffaCapacity - bots.length)
              : humanLimit,
        },
      },
    };
  },
};
