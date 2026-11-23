import type { GameModule } from "../runtime/module.ts";

// The engine owns preview, controls and confirmation. The caller owns room identity.
export function selectNetworkCar(
  engine: Pick<GameModule, "ccall">,
  selected: (car: string | null) => void,
): () => void {
  if (!engine.ccall("WebSetCarSelection", "number", ["number"], [1]))
    throw new Error("Car selection requires an idle network player.");
  let previous = engine.ccall("WebCarSelectionRevision", "number", [], []);
  const timer = setInterval(() => {
    const revision = engine.ccall("WebCarSelectionRevision", "number", [], []);
    if (revision !== previous) {
      previous = revision;
      selected(engine.ccall("WebSelectedCar", "string", [], []) || null);
    }
  }, 100);
  return () => {
    clearInterval(timer);
    engine.ccall("WebSetCarSelection", "number", ["number"], [0]);
  };
}
