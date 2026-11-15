import { z } from "zod";

import { ffa, ffaCapacity, ffaOptionsSchema } from "./ffa.ts";
import { tournament } from "./tournament.ts";
export { ffaCapacity };
export const modeDefinitions = { ffa, tournament };
export const modes = [ffa, tournament].map(({ id, label }) => ({ id, label }));
export const modeIdSchema = z.enum(["ffa", "tournament"]);
export const roomModeCapacity = (mode: string) =>
  modeDefinitions[modeIdSchema.parse(mode)].capacity;
export const modeOptionsSchema = z.object({ ffa: ffaOptionsSchema }).strict();
type Settings = { modeId: string; modeOptions?: z.infer<typeof modeOptionsSchema> };
export const roomBots = (settings: Settings) =>
  modeDefinitions[modeIdSchema.parse(settings.modeId)].bots(settings.modeOptions);
export const roomHumanLimit = (settings: Settings) =>
  modeDefinitions[modeIdSchema.parse(settings.modeId)].humanLimit(settings.modeOptions);
