export const journalTicks = 300;
const maxBytes = 2 * 1024 * 1024;
const maxEvents = 8192;
type Entry = { sequence: number; ms: number; tick: number | null; kind: string; data: unknown };

/** Event order is retained: replaying a tick must not erase its first execution. */
export class ClientJournal {
  private entries: { entry: Entry; bytes: number }[] = [];
  private bytes = 0;
  private sequence = 0;
  private head = 0;
  private started = performance.now();
  private metadata: Record<string, unknown> = {};
  private stopped: string | null = null;
  private dropped = 0;
  readonly createdAt = new Date().toISOString();

  identify(metadata: Record<string, unknown>) {
    if (!this.stopped) Object.assign(this.metadata, structuredClone(metadata));
  }
  record(kind: string, tick: number | null, data: unknown) {
    if (this.stopped) return;
    const entry: Entry = {
      sequence: this.sequence++,
      ms: performance.now() - this.started,
      tick,
      kind,
      data: structuredClone(data),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    this.head = Math.max(this.head, tick ?? 0);
    this.entries.push({ entry, bytes });
    this.bytes += bytes;
    const cutoff = Math.max(0, this.head - journalTicks + 1);
    this.entries = this.entries.filter((row) => {
      if (row.entry.tick === null || row.entry.tick >= cutoff) return true;
      this.bytes -= row.bytes;
      this.dropped++;
      return false;
    });
    while (this.bytes > maxBytes || this.entries.length > maxEvents) {
      this.bytes -= this.entries.shift()!.bytes;
      this.dropped++;
    }
  }
  freeze(reason: string, diagnostics: unknown) {
    if (this.stopped) return;
    this.record("stop", this.head, { reason, diagnostics });
    this.stopped = reason;
  }
  export() {
    return {
      format: "rustymetal4-client-journal",
      version: 1,
      createdAt: this.createdAt,
      exportedAt: new Date().toISOString(),
      windowTicks: journalTicks,
      maxBytes,
      head: this.head,
      droppedEvents: this.dropped,
      stopped: this.stopped,
      metadata: structuredClone(this.metadata),
      events: this.entries.map(({ entry }) => structuredClone(entry)),
    };
  }
}

let current: ClientJournal | undefined;
export function startClientJournal() {
  current = new ClientJournal();
  globalThis.dispatchEvent?.(new Event("rm4-journal"));
  return current;
}
export function clientJournal() {
  return current;
}
