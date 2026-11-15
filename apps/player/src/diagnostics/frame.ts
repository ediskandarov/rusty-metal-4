import type { PendingModule } from "@tm4/game-runtime/runtime/module";

import type { FrameCapture } from "./archive.ts";

export async function captureFrame(module: PendingModule | undefined): Promise<FrameCapture> {
  if (!module?._WebCaptureFrame) throw new Error("Frame capture is unavailable in this runtime.");
  let frame: ImageData | undefined;
  let failure: Error | undefined;
  const previous = module.onCapturedFrame;
  module.onCapturedFrame = (width, height, rgb) => {
    // Copy while the SDK owns the RGB buffer; C frees it when this callback returns.
    try {
      frame = new ImageData(width, height);
      for (let pixel = 0; pixel < width * height; pixel++) {
        frame.data[pixel * 4] = rgb[pixel * 3]!;
        frame.data[pixel * 4 + 1] = rgb[pixel * 3 + 1]!;
        frame.data[pixel * 4 + 2] = rgb[pixel * 3 + 2]!;
        frame.data[pixel * 4 + 3] = 255;
      }
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("Could not copy the game frame.", { cause: error });
    }
  };
  try {
    if (!module._WebCaptureFrame()) throw new Error("No game frame is available yet.");
  } finally {
    module.onCapturedFrame = previous;
  }
  if (failure) throw failure;
  if (!frame) throw new Error("The renderer did not return a frame.");
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not encode the game frame.");
  context.putImageData(frame, 0, 0);
  const bytes = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))),
      "image/png",
    );
  });
  return { bytes, width: frame.width, height: frame.height };
}
