interface JournalStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
}
export interface JournalStorage extends JournalStore {
  transaction<T>(operation: (tx: JournalStore) => Promise<T>): Promise<T>;
}

const chunkBytes = 64 * 1024;
export const journalRetentionMs = 24 * 60 * 60 * 1000;
const maxBytes = 16 * 1024 * 1024;
const key = "journal";
type Metadata = { length: number; savedAt: number; expiresAt: number };

/** One server DO owns one match. Only the growing, flushed journal prefix is retained. */
export class ServerJournal {
  constructor(private storage: JournalStorage) {}

  async save(response: Response): Promise<void> {
    if (!response.ok || !response.body) throw new Error("Journal unavailable: " + response.status);
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 8 || length > maxBytes) {
      await response.body.cancel();
      throw new Error("Journal archive exceeds its 16 MiB limit or has no valid length");
    }
    const previous = await this.storage.get<Metadata>(key);
    if (previous && previous.length > length) {
      await response.body.cancel();
      throw new Error("Journal prefix shrank");
    }
    // Bound allocation and validate the entire response before replacing a saved prefix.
    const bytes = new Uint8Array(length);
    const reader = response.body.getReader();
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > length) throw new Error("Journal length mismatch");
        bytes.set(value, offset);
        offset += value.length;
      }
    } finally {
      await reader.cancel();
    }
    if (
      offset !== length ||
      new TextDecoder().decode(bytes.subarray(0, 7)) !== "TM4JRNL" ||
      bytes[7] !== 1
    )
      throw new Error("Invalid journal response");
    // Completed chunks never change; the last partial chunk is rewritten when it grows.
    const first = Math.floor((previous?.length ?? 0) / chunkBytes);
    const savedAt = Date.now();
    await this.storage.transaction(async (tx) => {
      for (let index = first; index * chunkBytes < length; index++)
        await tx.put(key + ":" + index, bytes.slice(index * chunkBytes, (index + 1) * chunkBytes));
      await tx.put(key, { length, savedAt, expiresAt: savedAt + journalRetentionMs });
    });
  }
  async metadata() {
    return this.storage.get<Metadata>(key);
  }
  async expire(now = Date.now()) {
    const meta = await this.metadata();
    if (meta && meta.expiresAt <= now) {
      const keys = [
        key,
        ...Array.from({ length: Math.ceil(meta.length / chunkBytes) }, (_, i) => key + ":" + i),
      ];
      for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    }
  }
  async download(): Promise<Response> {
    const meta = await this.metadata();
    if (!meta || meta.expiresAt <= Date.now())
      return new Response("Journal unavailable or expired", { status: 404 });
    const storage = this.storage;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= meta.length) {
          controller.close();
          return;
        }
        const chunk = await storage.get<Uint8Array>(key + ":" + Math.floor(offset / chunkBytes));
        if (!chunk) {
          controller.error(new Error("Journal chunk missing"));
          return;
        }
        const part = chunk.slice(0, Math.min(chunk.length, meta.length - offset));
        offset += part.length;
        controller.enqueue(part);
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(meta.length),
        "Content-Disposition": 'attachment; filename="server.tm4j"',
        "Cache-Control": "no-store",
        "X-Journal-Saved-At": String(meta.savedAt),
        "X-Journal-Expires-At": String(meta.expiresAt),
      },
    });
  }
}
