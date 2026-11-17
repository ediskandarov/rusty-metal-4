import { RoomError } from "./room-state.ts";

export const challengeVersion = "200-v1";
// MAIN.MR Root/worlds: the eight tournament worlds have no unlockAt field.
export const challengeMaps = [
  "Construction Yard",
  "Neon City",
  "Road Rage",
  "The Bedroom",
  "Amazonia 3000 B.C.",
  "The Oil Rig",
  "Minion's Maze",
  "The Carnival",
] as const;
// MAIN.MR Root/objects/car/characters entries with a filename, in original order.
export const challengeModels = [
  "Orbital",
  "Pizza Boy",
  "Capt. Grimm",
  "Calypso",
  "Quatro",
  "Goggle Eyes",
  "Meter Maid",
  "Gen. Warthog",
  "Microblast",
  "Trash Man",
  "The Joneses",
  "Drag Queen",
  "Mr. Zombie",
  "Sweet Tooth",
  "Crusher",
  "Moon Buggy",
  "RC Car",
  "Super Auger",
  "Super Axel",
  "Minion",
  "Super Thumper",
  "Super Slamm",
] as const;
export interface ChallengeCompletion {
  model: string;
  map: string;
  date: string;
  version: string;
}
export interface ChallengePlayer {
  id: string;
  name: string;
  score: number;
  completions: ChallengeCompletion[];
}
export interface ChallengeRelease {
  buildId: string;
  version: string;
  playerUrl: string;
}
export function completion(input: unknown): Omit<ChallengeCompletion, "date"> {
  if (!input || typeof input !== "object") throw new RoomError(400, "A completion is required.");
  const { model, map, version } = input as Record<string, unknown>;
  if (typeof model !== "string" || !challengeModels.some((name) => name === model))
    throw new RoomError(400, "Choose an original car model.");
  if (typeof map !== "string" || !challengeMaps.some((name) => name === map))
    throw new RoomError(400, "Choose a tournament map.");
  if (version !== challengeVersion) throw new RoomError(400, "Unknown challenge version.");
  return { model, map, version };
}
export function releasePath(buildId: string): string {
  if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Invalid challenge build ID");
  return `/challenge-releases/${buildId}/`;
}
