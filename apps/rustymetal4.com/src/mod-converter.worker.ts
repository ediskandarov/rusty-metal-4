import { packMod } from "@tm4/mods";
import type { ConverterReply, ConverterRequest, DiscModConverter } from "@tm4/mods/recipe";

const worker = self as unknown as {
  onmessage: (event: MessageEvent<ConverterRequest>) => void;
  postMessage(message: ConverterReply, transfers?: Transferable[]): void;
};

worker.onmessage = ({ data }) => {
  void (async () => {
    const converter = (await import(/* @vite-ignore */ data.converter)) as DiscModConverter;
    const draft = await converter.build({
      modDisc: data.modDisc,
      baseDisc: data.baseDisc,
      progress: (message) => worker.postMessage({ type: "progress", message }),
    });
    if (
      draft.plan.id !== "tm3" ||
      draft.plan.runtime !== data.runtime ||
      draft.plan.version !== data.version
    )
      throw Error("The converter produced a package for a different release");
    worker.postMessage({ type: "progress", message: "Packaging resources…" });
    const bytes = await packMod(draft);
    worker.postMessage({ type: "built", bytes: bytes.buffer }, [bytes.buffer]);
  })().catch((error: unknown) => {
    worker.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
