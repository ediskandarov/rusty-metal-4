import type { DiscAssets } from "../loader/types.ts";
import { initializeSettings } from "../ui/settings.ts";
import { requireRuntime } from "./module.ts";

export async function startGame(
  assets: DiscAssets,
  canvas: HTMLCanvasElement,
  resourceMods = 0,
): Promise<void> {
  const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  const fingerprints: string[] = [];
  for (const [path, bytes] of [...assets.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (/\.(MR|IMG|VAB)$/i.test(path) && !/\/MENU\./i.test(path))
      fingerprints.push(path + ":" + (await digest(bytes)));
  }
  const content = await digest(new TextEncoder().encode(fingerprints.join("\n")));
  const build = (await (await fetch("simulation-build.json")).json()) as { sha256: string };

  const parameters = new URLSearchParams(location.search);
  return new Promise((resolve, reject) => {
    globalThis.tm4Assets = assets;
    globalThis.Module = {
      canvas,
      tm4ResourceMods: resourceMods,
      noInitialRun: true,
      print: (text) => console.log(text),
      printErr: (text) => console.error(text),
      setStatus: () => {},
      onAbort: (reason) => reject(new Error(`Game runtime aborted: ${String(reason)}`)),
      onRuntimeInitialized() {
        try {
          const module = globalThis.Module;
          requireRuntime(module);
          module.FS.mkdirTree("/DATA");
          for (const [path, bytes] of assets.files) {
            module.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
            module.FS.writeFile(path, bytes, { canOwn: true });
          }
          assets.files.clear();
          for (const track of assets.tracks) {
            module._WebMusicConfigureTrack(track.number, track.start, track.end, track.toc);
          }
          module._WebMusicConfigureDisc(assets.tracks.length, assets.leadout);
          initializeSettings(module, canvas);
          const diagnostic = "_WebTestRestartNetworkReplay" in module;
          module.tm4LocalCheckpoint = diagnostic && parameters.get("checkpoint") === "1";
          module.callMain(
            parameters.has("match") ||
              parameters.has("authority") ||
              (diagnostic && parameters.has("session"))
              ? ["--session", ...(parameters.has("authority") ? ["--authority"] : [])]
              : [],
          );
          (
            globalThis as typeof globalThis & {
              tm4Port: import("../network/protocol.ts").NetworkPort;
            }
          ).tm4Port.compatibility = { protocol: 6, build: build.sha256, content };
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
    const script = document.createElement("script");
    script.src = "tm4_web.js";
    script.onerror = () => reject(new Error("Could not load the game runtime"));
    document.body.append(script);
  });
}
