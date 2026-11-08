import type { DiscAssets } from "../loader/types.ts";
import { initializeSettings } from "../ui/settings.ts";
import { requireRuntime } from "./module.ts";

export function startGame(assets: DiscAssets, canvas: HTMLCanvasElement): Promise<void> {
  return new Promise((resolve, reject) => {
    globalThis.tm4Assets = assets;
    globalThis.Module = {
      canvas,
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
          for (const [path, bytes] of assets.files)
            module.FS.writeFile(path, bytes, { canOwn: true });
          assets.files.clear();
          for (const track of assets.tracks) {
            module._WebMusicConfigureTrack(track.number, track.start, track.end, track.toc);
          }
          module._WebMusicConfigureDisc(assets.tracks.length, assets.leadout);
          initializeSettings(module, canvas);
          module.callMain([]);
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
