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
// Display names from the TM3 converter. The prefix keeps the two games' car records distinct.
const tm3Cars = [
  "Auger",
  "Axel",
  "Club Kid",
  "Darkside",
  "Firestarter",
  "Flower Power",
  "Mr. Grimm",
  "Hammerhead",
  "Minion",
  "Outlaw",
  "Primeval",
  "Roadkill",
  "Spectre",
  "Sweet Tooth",
  "Thumper",
  "Warthog",
].map((name) => "TM3 " + name);
const tm3Arenas = [
  "Hollywood",
  "Washington",
  "Hangar 18",
  "North Pole",
  "London",
  "Tokyo",
  "Egypt",
  "Blimp",
  "Warehouse",
  "Club Kid's House",
];
const supportedCars = new Set<string>([...challengeModels, ...tm3Cars]);
const supportedArenas = new Set<string>([...challengeMaps, ...tm3Arenas]);

export interface ChallengeWin {
  frags?: number;
  model: string;
  map: string;
  version: string;
}
export interface ChallengeCompletion extends Omit<ChallengeWin, "frags"> {
  date: string;
  bestFrags: number | null;
  bestMap: string | null;
  bestDate: string | null;
}
export interface ChallengePlayer {
  id: string;
  name: string;
  score: number;
  totalScore: number;
  completions: ChallengeCompletion[];
}
export interface ChallengeRelease {
  buildId: string;
  version: string;
  playerUrl: string;
}
export function completion(input: unknown): ChallengeWin {
  if (!input || typeof input !== "object") throw new RoomError(400, "A completion is required.");
  const { model, map, version, frags } = input as Record<string, unknown>;
  if (typeof model !== "string" || !supportedCars.has(model))
    throw new RoomError(400, "Choose a challenge car.");
  if (typeof map !== "string" || !supportedArenas.has(map))
    throw new RoomError(400, "Choose a challenge arena.");
  if (version !== challengeVersion) throw new RoomError(400, "Unknown challenge version.");
  if (frags === undefined) return { model, map, version }; // Previously published players omit frags.
  if (typeof frags !== "number" || !Number.isInteger(frags) || frags < 0 || frags > 200)
    throw new RoomError(400, "Frags must be a whole number from 0 to 200.");
  return { model, map, version, frags };
}
export function releasePath(buildId: string): string {
  if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Invalid challenge build ID");
  return `/challenge-releases/${buildId}/`;
}
