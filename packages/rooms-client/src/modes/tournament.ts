export const tournament = {
  id: "tournament",
  label: "Tournament",
  capacity: 4,
  capacityError: "Tournament has four player places.",
  minimumPlayers: 2,
  firstMap: "construction-yard",
  bots(_options?: unknown): string[] {
    return [];
  },
  humanLimit(_options?: unknown) {
    return tournament.capacity;
  },
  validSettings(settings: { mapId: string; modeOptions?: unknown }) {
    return !settings.modeOptions && settings.mapId === tournament.firstMap;
  },
} as const;
