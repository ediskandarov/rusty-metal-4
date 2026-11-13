import { canSelectDisc, type StartupPhase, type StartupStore } from "../state/startup.ts";
import { element } from "./dom.ts";

function progressMessage(phase: StartupPhase) {
  switch (phase.kind) {
    case "preparing-browser":
      return "Preparing browser support… The page will reload automatically if needed.";
    case "ready":
    case "running":
      return "";
    case "connecting-disc":
      return "Connecting to local disc server…";
    case "loading-disc":
      return phase.message;
    case "installing-mods":
      return "Preparing mods…";
    case "starting-runtime":
      return "Starting game…";
    case "failed":
      return phase.source === "runtime"
        ? `${phase.message}\nReload the page to try again.`
        : phase.message;
  }
}

export function initializeStartup(
  store: StartupStore,
  resources: { show(): void },
  popups: { close(): void },
) {
  const startup = element("startup", HTMLElement);
  const progress = element("startup-progress", HTMLElement);
  const warnings = element("startup-warnings", HTMLElement);
  const picker = element("disc-folder", HTMLInputElement);
  function render(state: ReturnType<StartupStore["getState"]>, previous?: typeof state) {
    const { phase } = state;
    // SDL must see the final viewport before it initializes the canvas.
    startup.hidden = phase.kind === "starting-runtime" || phase.kind === "running";
    picker.disabled = !canSelectDisc(phase);
    progress.textContent = progressMessage(phase);
    if (state.warnings !== previous?.warnings) {
      warnings.replaceChildren(
        ...state.warnings.map((message) => {
          const line = document.createElement("li");
          line.textContent = message;
          return line;
        }),
      );
    }
    if (phase.kind === previous?.phase.kind) return;
    if (phase.kind === "loading-disc" || (phase.kind === "failed" && phase.source !== "browser"))
      resources.show();
    else if (phase.kind === "running") popups.close();
  }
  render(store.getState());
  return store.subscribe(render);
}
