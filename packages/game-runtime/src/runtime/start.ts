import { networkProtocolVersion } from "@tm4/lightyear-client/schemas";
import { getBuildManifest, loadBuildModules, prepareModuleResources } from "@tm4/mr-preparation";
import type { DiscAssets } from "@tm4/resources/loader/types";

import type { NetworkPort } from "../network/protocol.ts";
import { type GameModule, requireRuntime } from "./module.ts";

export interface StartOptions {
  resourceMods?: number;
  manifest?: Awaited<ReturnType<typeof getBuildManifest>>;
  approvedModules?: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  session?: boolean;
  beforeMain?(this: void, module: GameModule): void;
}

async function waitForPlatform() {
  const browser = globalThis as typeof globalThis & { tm4Port?: NetworkPort };
  const deadline = performance.now() + 30_000;
  // Loading MAIN may suspend while the browser links resource modules.
  while (!browser.tm4Port?.platformReady) {
    if (performance.now() >= deadline) throw Error("The game platform did not finish starting");
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return browser.tm4Port;
}

// Startup transfers resource files to WasmFS and releases the loader's file map.
export async function startGame(
  assets: DiscAssets,
  canvas: HTMLCanvasElement,
  { resourceMods = 0, session = false, beforeMain, manifest, approvedModules }: StartOptions = {},
): Promise<GameModule> {
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
  const build =
    manifest ?? (await getBuildManifest(new URL("simulation-build.json", document.baseURI)));
  const buildHash = build.sha256;
  let modules: Map<string, Uint8Array<ArrayBuffer>>;
  try {
    modules = await loadBuildModules(build, "browser", async (name) => {
      const response = await fetch(new URL(`modules/${name}`, document.baseURI));
      if (!response.ok)
        throw new Error(`Could not load resource module ${name}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    await prepareModuleResources(assets.files, modules);
  } finally {
    if (!manifest) build.free();
  }
  const parameters = new URLSearchParams(location.search);
  return new Promise((resolve, reject) => {
    globalThis.tm4Assets = assets;
    globalThis.Module = {
      canvas,
      tm4ResourceMods: resourceMods,
      tm4ApproveModule(name, bytes) {
        const approved = modules.get(name) ?? approvedModules?.get(name);
        if (approved?.length === bytes.length && approved.every((value, i) => value === bytes[i]))
          return true;
        const error = Error(`Resource module ${name} is not approved for this build`);
        reject(error);
        console.error(error);
        return false;
      },
      noInitialRun: true,
      print: (text) => console.log(text),
      printErr: (text) => console.error(text),
      setStatus: () => {},
      onAbort: (reason) => reject(new Error(`Game runtime aborted: ${String(reason)}`)),
      onRuntimeInitialized() {
        try {
          const module = globalThis.Module;
          requireRuntime(module);
          if (resourceMods && !module._WebRequireModuleApproval)
            throw Error("This game runtime does not support approved mod modules");
          module._WebRequireModuleApproval?.();
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
          beforeMain?.(module);
          const diagnostic = "_WebTestRestartNetworkReplay" in module;
          module.tm4LocalCheckpoint = diagnostic && parameters.get("checkpoint") === "1";
          module.callMain(
            session ||
              parameters.has("match") ||
              (diagnostic && parameters.has("simulation-reference")) ||
              (diagnostic && parameters.has("session"))
              ? [
                  "--session",
                  ...(diagnostic && parameters.has("simulation-reference")
                    ? ["--simulation-only"]
                    : []),
                ]
              : [],
          );
          void waitForPlatform()
            .then((port) => {
              port.compatibility = { protocol: networkProtocolVersion, build: buildHash, content };
              resolve(module);
            })
            .catch(reject);
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
