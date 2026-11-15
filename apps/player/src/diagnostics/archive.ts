import type { ClientJournal } from "@tm4/game-runtime/network/journal";
import { type AsyncZippable, strToU8, zip } from "fflate";

export type JournalExport = ReturnType<ClientJournal["export"]>;
export interface ServerJournalDownload {
  bytes: Blob;
  savedAt: number | null;
}
export interface FrameCapture {
  bytes: Blob;
  width: number;
  height: number;
}

// Snapshot the client and frame before waiting on the server. A failed artifact
// must not prevent collecting the evidence still available in this browser.
export async function diagnosticArchive(options: {
  client: JournalExport;
  commit: string;
  frame: Promise<FrameCapture>;
  server: Promise<ServerJournalDownload>;
}) {
  const { client, commit } = options;
  const files: AsyncZippable = { "client.json": strToU8(JSON.stringify(client, null, 2)) };
  const artifacts: Record<string, unknown> = { client: { file: "client.json", head: client.head } };
  const missing: string[] = [];
  const results = await Promise.allSettled([options.frame, options.server]);
  for (const [index, name] of ["frame", "server"].entries()) {
    const result = results[index]!;
    if (result.status === "rejected") {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      artifacts[name] = { error };
      missing.push(name);
    } else {
      const artifact = result.value;
      const file = name === "frame" ? "frame.png" : "server.tm4j";
      const bytes = new Uint8Array(await artifact.bytes.arrayBuffer());
      files[file] = [bytes, { level: name === "frame" ? 0 : 6 }];
      artifacts[name] = {
        file,
        bytes: bytes.length,
        ...("width" in artifact
          ? { width: artifact.width, height: artifact.height }
          : { savedAt: artifact.savedAt }),
      };
    }
  }
  files["report.json"] = strToU8(
    JSON.stringify(
      {
        format: "rustymetal4-diagnostics",
        version: 1,
        capturedAt: client.exportedAt,
        packagedAt: new Date().toISOString(),
        build: { commit, url: `https://github.com/ediskandarov/rusty-metal-4/commit/${commit}` },
        match: client.metadata,
        stopped: client.stopped,
        artifacts,
      },
      null,
      2,
    ),
  );
  const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
  return {
    blob: new Blob([bytes], { type: "application/zip" }),
    filename: `rustymetal4-diagnostics-${client.exportedAt.replace(/[:.]/g, "-")}.zip`,
    missing,
  };
}
