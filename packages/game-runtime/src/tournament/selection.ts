import type { GameModule } from "../runtime/module.ts";

// The engine owns preview, controls and confirmation. The caller owns room identity.
export function selectTournamentCar(
  engine: Pick<GameModule, "ccall">,
  selected: (car: string | null) => void,
): () => void {
  if (!engine.ccall("WebSetTournamentSelection", "number", ["number"], [1]))
    throw new Error("Car selection requires an idle network player.");
  let previous = engine.ccall("WebTournamentSelectionRevision", "number", [], []);
  const timer = setInterval(() => {
    const revision = engine.ccall("WebTournamentSelectionRevision", "number", [], []);
    if (revision !== previous) {
      previous = revision;
      selected(engine.ccall("WebTournamentSelectedCar", "string", [], []) || null);
    }
  }, 100);
  return () => {
    clearInterval(timer);
    engine.ccall("WebSetTournamentSelection", "number", ["number"], [0]);
  };
}
