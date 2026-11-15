import { clientJournal } from "@tm4/game-runtime/network/journal";

import { diagnosticArchive } from "../diagnostics/archive.ts";
import { captureFrame } from "../diagnostics/frame.ts";
import { downloadServerJournal } from "../diagnostics/server.ts";
import { element } from "./dom.ts";

export function initializeTroubleshoot() {
  const button = element("download-diagnostics", HTMLButtonElement);
  const status = element("journal-status", HTMLElement);
  let downloading = false;
  const refresh = () => {
    button.disabled = downloading || !clientJournal();
    if (!downloading)
      status.textContent = clientJournal()
        ? "Diagnostics available for download."
        : "No network session recorded yet.";
  };
  globalThis.addEventListener("rm4-journal", refresh);
  async function download() {
    const journal = clientJournal();
    if (!journal || downloading) return;
    downloading = true;
    button.disabled = true;
    status.textContent = "Collecting journals and game frame…";
    try {
      const client = journal.export();
      const archive = await diagnosticArchive({
        client,
        commit: import.meta.env.PUBLIC_BUILD_COMMIT,
        frame: captureFrame(globalThis.Module),
        server: downloadServerJournal(client),
      });
      const url = URL.createObjectURL(archive.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = archive.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = archive.missing.length
        ? `ZIP downloaded without: ${archive.missing.join(", ")}. See report.json for details.`
        : "Diagnostic ZIP downloaded.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      downloading = false;
      button.disabled = !clientJournal();
    }
  }
  button.addEventListener("click", () => {
    void download();
  });
  refresh();
}
