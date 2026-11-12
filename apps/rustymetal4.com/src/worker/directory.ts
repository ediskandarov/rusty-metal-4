import { DurableObject } from "cloudflare:workers";

import { json } from "../http.ts";
import type { RoomSummary } from "../protocol.ts";
import { directoryLease } from "../room-state.ts";
import type { Env } from "./index.ts";

interface Listing {
  summary: RoomSummary;
  expiresAt: number;
}

export class RoomDirectory extends DurableObject<Env> {
  protected listings = new Map<string, Listing>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.listings = await ctx.storage.list<Listing>({ prefix: "room:" });
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private summaries(): RoomSummary[] {
    return [...this.listings.values()]
      .map((entry) => entry.summary)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private broadcast(): void {
    const message = JSON.stringify({ type: "directory", rooms: this.summaries() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Reconnect to the directory");
      }
    }
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.listings) {
      if (entry.expiresAt > now) continue;
      this.listings.delete(key);
      await this.ctx.storage.delete(key);
      changed = true;
    }
    if (changed) this.broadcast();
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const deadlines = [...this.listings.values()].map((entry) => entry.expiresAt);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }

  // Only a bound room object can call this RPC. Public requests never supply summaries.
  async publish(id: string, summary: RoomSummary | null): Promise<boolean> {
    return this.locked(async () => {
      await this.expire();
      const key = `room:${id}`;
      if (summary) {
        if (!this.listings.has(key) && this.listings.size >= 200) return false;
        const entry = { summary, expiresAt: Date.now() + directoryLease };
        const previous = this.listings.get(key);
        await this.ctx.storage.put(key, entry);
        this.listings.set(key, entry);
        if (JSON.stringify(previous?.summary) !== JSON.stringify(summary)) this.broadcast();
      } else {
        await this.ctx.storage.delete(key);
        if (this.listings.delete(key)) this.broadcast();
      }
      await this.schedule();
      return true;
    });
  }

  // Reservations are private RPCs; leases recover capacity after an object/process loss.
  async reserveMatch(room: string, session: string): Promise<boolean> {
    return this.locked(async () => {
      const now = Date.now();
      const reservations = await this.ctx.storage.list<{ session: string; until: number }>({
        prefix: "match:",
      });
      await Promise.all(
        [...reservations].map(async ([key, lease]) => {
          if (lease.until > now) return;
          try {
            const response = await this.env.SERVER.getByName(
              key.slice(6) + ":" + lease.session,
            ).fetch("https://server/_server/stop", {
              method: "POST",
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) return;
            await this.ctx.storage.delete(key);
            reservations.delete(key);
          } catch {
            /* Keep capacity reserved until its server is confirmed stopped. */
          }
        }),
      );
      const previous = reservations.get("match:" + room);
      if (previous && previous.session !== session) return false;
      if (!previous && reservations.size >= 10) return false;
      await this.ctx.storage.put("match:" + room, { session, until: now + 60_000 });
      return true;
    });
  }
  async releaseMatch(room: string, session: string): Promise<void> {
    await this.locked(async () => {
      const key = "match:" + room;
      if ((await this.ctx.storage.get<{ session: string }>(key))?.session === session)
        await this.ctx.storage.delete(key);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return this.locked(async () => {
      await this.expire();
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (this.ctx.getWebSockets().length >= 128)
          return json({ error: "Live directory is busy. Refreshing periodically instead." }, 429);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({ type: "directory", rooms: this.summaries() }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return json({ rooms: this.summaries() });
    });
  }

  override async alarm(): Promise<void> {
    await this.locked(() => this.expire());
  }
  override webSocketMessage(socket: WebSocket): void {
    socket.close(1008, "Only heartbeat messages are supported");
  }
  override webSocketClose(socket: WebSocket, _code: number): void {
    socket.close(1000, "Closed");
  }
  override webSocketError(socket: WebSocket): void {
    socket.close(1011, "Connection lost");
  }
}
