export const modes = [{ id: "deathmatch", label: "Deathmatch" }] as const;

// Names come from the native GameGetWorldName catalog; IDs remain stable if labels change.
export const maps = [
  { id: "construction-yard", label: "Construction Yard" },
  { id: "neon-city", label: "Neon City" },
  { id: "road-rage", label: "Road Rage" },
  { id: "the-bedroom", label: "The Bedroom" },
  { id: "amazonia", label: "Amazonia 3000 B.C." },
  { id: "the-oil-rig", label: "The Oil Rig" },
  { id: "minions-maze", label: "Minion's Maze" },
  { id: "the-carnival", label: "The Carnival" },
  { id: "the-pits", label: "The Pits" },
  { id: "the-citadel", label: "The Citadel" },
  { id: "nowhere-to-hide", label: "Nowhere To Hide" },
  { id: "octa-gone", label: "Octa-Gone" },
  { id: "king-of-the-kill", label: "King Of The Kill" },
  { id: "tic-tac-toast", label: "Tic-Tac-Toast" },
  { id: "the-islands", label: "The Islands" },
  { id: "son-of-a-ditch", label: "Son Of A Ditch" },
] as const;

export interface RoomSettings {
  name: string;
  modeId: (typeof modes)[number]["id"];
  mapId: (typeof maps)[number]["id"];
  capacity: number;
}
export interface RoomSummary extends RoomSettings {
  id: string;
  host: string;
  participantCount: number;
  freePlaces: number;
}
export interface RoomSnapshot extends RoomSummary {
  version: number;
  hostId: string | null;
  you: string | null;
  participants: { id: string; name: string; connected: boolean }[];
  emptyUntil: number | null;
  closed: boolean;
}
export type RoomEvent = { type: "room"; room: RoomSnapshot };
export type DirectoryEvent = { type: "directory"; rooms: RoomSummary[] };
export const mapLabel = (id: string) => maps.find((map) => map.id === id)?.label ?? id;
export const modeLabel = (id: string) => modes.find((mode) => mode.id === id)?.label ?? id;
