import { clientJournal } from "@tm4/game-runtime/network/journal";

import { element } from "./dom.ts";

export function initializeTroubleshoot() {
  const button = element("download-client-journal", HTMLButtonElement);
  const status = element("journal-status", HTMLElement);
  const refresh = () => {
    button.disabled = !clientJournal();
    status.textContent = clientJournal()
      ? "Client journal available for download."
      : "No network session recorded yet.";
  };
  globalThis.addEventListener("rm4-journal", refresh);
  button.addEventListener("click", () => {
    const journal = clientJournal();
    if (!journal) return;
    const data = journal.export();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "rustymetal4-client-" + data.createdAt.replace(/[:.]/g, "-") + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  refresh();
}
