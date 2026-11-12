import { RoomError } from "./room-state.ts";

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function failure(error: unknown): Response {
  if (error instanceof RoomError) return json({ error: error.message }, error.status);
  console.error("Room operation failed", error instanceof Error ? error.name : "Unknown error");
  return json({ error: "The room service is unavailable. Please try again." }, 503);
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new RoomError(415, "Send JSON with this request.");
  const reader = request.body?.getReader();
  if (!reader) throw new RoomError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      length += value.byteLength;
      if (length > 2048) {
        await reader.cancel();
        throw new RoomError(413, "This request is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new RoomError(400, "Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}
export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
