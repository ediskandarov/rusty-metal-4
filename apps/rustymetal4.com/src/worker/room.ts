import { DurableObject } from "cloudflare:workers";

import { failure, json, readJson } from "../http.ts";
import {
  connect,
  createState,
  directoryRefresh,
  disconnect,
  edit,
  join,
  memberFor,
  nextDeadline,
  object,
  prune,
  reconnectGrace,
  removeMember,
  RoomError,
  type RoomState,
  snapshot,
  summary,
} from "../room-state.ts";
import type { Env } from "./index.ts";

interface Attachment {
  memberId: string;
  connectionId: string;
  connectedAt: number;
}
export const creationWindow = 20_000;
const heartbeatTimeout = 70_000;

export class Room extends DurableObject<Env> {
  private state: RoomState | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<RoomState>("room");
      if (!this.state) return;
      // Hibernating sockets survive eviction. Lost sockets must not leave immortal members.
      const live = new Set(
        ctx
          .getWebSockets()
          .map((socket) => (socket.deserializeAttachment() as Attachment).connectionId),
      );
      let changed = false;
      for (const member of this.state.members) {
        const connections = member.connections.filter((id) => live.has(id));
        if (connections.length === member.connections.length) continue;
        member.connections = connections;
        if (!connections.length) member.disconnectedUntil = Date.now() + reconnectGrace;
        changed = true;
      }
      if (changed) await this.commit();
    });
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async schedule(): Promise<void> {
    if (!this.state) return;
    let deadline = nextDeadline(this.state);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (
        !this.state.members.some((member) => member.connections.includes(attachment.connectionId))
      )
        continue;
      const lastSeen =
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.connectedAt;
      deadline = Math.min(deadline ?? Infinity, lastSeen + heartbeatTimeout);
    }
    if (deadline !== null) await this.ctx.storage.setAlarm(deadline);
    else await this.ctx.storage.deleteAlarm();
  }

  private reapSilentSockets(now: number): boolean {
    if (!this.state) return false;
    let changed = false;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      const lastSeen =
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.connectedAt;
      if (now - lastSeen < heartbeatTimeout) continue;
      if (disconnect(this.state, attachment.memberId, attachment.connectionId, now)) {
        changed = true;
        socket.close(1001, "Heartbeat timed out; reconnect to keep your place");
      }
    }
    return changed;
  }

  private broadcast(): void {
    const state = this.state;
    if (!state) return;
    for (const socket of this.ctx.getWebSockets()) {
      const { memberId } = socket.deserializeAttachment() as Attachment;
      const key = state.members.find((member) => member.id === memberId)?.key ?? "";
      try {
        socket.send(JSON.stringify({ type: "room", room: snapshot(state, key) }));
      } catch {
        socket.close(1011, "Reconnect to the room");
      }
    }
  }

  private async publish(): Promise<void> {
    const state = this.state;
    if (!state) return;
    try {
      const accepted = await this.env.DIRECTORY.getByName("public").publish(
        state.id,
        state.closed ? null : summary(state),
      );
      if (!accepted && state.directoryRegistered) throw new Error("Directory temporarily full");
      if (!accepted) {
        state.closed = true;
        state.members = [];
        state.hostId = null;
        await this.ctx.storage.put("room", state);
        // A rejected new listing has no directory entry to remove.
      }
      if (state.closed) {
        for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Room closed");
        await this.ctx.storage.deleteAll();
        this.state = undefined;
        return;
      }
      state.directoryRegistered = true;
      state.publishAt = Date.now() + directoryRefresh;
      await this.ctx.storage.put("room", state);
    } catch {
      // The persisted retry deadline also covers eviction between saving and publication.
      state.publishAt = Date.now() + 5000;
      await this.ctx.storage.put("room", state);
    }
    await this.schedule();
  }

  private async commit(): Promise<void> {
    if (!this.state) return;
    this.state.version++;
    this.state.publishAt = Date.now() + 5000;
    await this.ctx.storage.put("room", this.state);
    await this.schedule();
    this.broadcast();
    await this.publish();
  }

  override async fetch(request: Request): Promise<Response> {
    return this.locked(async () => {
      try {
        const path = new URL(request.url).pathname;
        const key = request.headers.get("x-room-session") ?? "";
        const now = Date.now();
        const silent = this.reapSilentSockets(now);
        if (this.state && (prune(this.state, now) || silent)) await this.commit();
        if (path === "/create" && request.method === "POST") {
          const input = object(await readJson(request));
          const id = request.headers.get("x-room-id")!;
          if (!this.state) {
            const createdAt = Number(String(input.requestId).split(".")[0]);
            // Cleanup leaves no tombstone. Expired create tickets cannot resurrect deleted objects.
            if (
              !Number.isFinite(createdAt) ||
              createdAt > now + 5000 ||
              now - createdAt > creationWindow
            )
              throw new RoomError(410, "This creation request expired. Please create a new room.");
            this.state = createState(id, key, input, now);
            await this.commit();
          } else if (this.state.creatorKey !== key || !memberFor(this.state, key)) {
            throw new RoomError(409, "This creation request has already been used.");
          }
          if (!this.state)
            throw new RoomError(503, "The room directory is full. Please try later.");
          return json({ room: snapshot(this.state, key) });
        }
        const state = this.state;
        if (!state || state.closed)
          throw new RoomError(404, "This room has expired or no longer exists.");
        if (path === "/" && request.method === "GET") return json({ room: snapshot(state, key) });
        if (path === "/join" && request.method === "POST") {
          const input = object(await readJson(request));
          join(state, key, input.playerName, now);
          await this.commit();
        } else if (path === "/settings" && request.method === "POST") {
          edit(state, key, await readJson(request));
          await this.commit();
        } else if (path === "/leave" && request.method === "POST") {
          const member = memberFor(state, key);
          if (member) {
            removeMember(state, member.id, now);
            await this.commit();
            for (const socket of this.ctx.getWebSockets()) {
              if ((socket.deserializeAttachment() as Attachment).memberId === member.id)
                socket.close(1000, "You left the room");
            }
          }
        } else if (path === "/live" && request.method === "GET") {
          if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
            throw new RoomError(426, "A WebSocket connection is required.");
          const connectionId = crypto.randomUUID();
          const member = connect(state, key, connectionId);
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1]);
          pair[1].serializeAttachment({
            memberId: member.id,
            connectionId,
            connectedAt: now,
          } satisfies Attachment);
          await this.commit();
          return new Response(null, { status: 101, webSocket: pair[0] });
        } else {
          throw new RoomError(404, "Unknown room endpoint.");
        }
        return json({ room: snapshot(state, key) });
      } catch (error) {
        return failure(error);
      }
    });
  }

  override async alarm(): Promise<void> {
    await this.locked(async () => {
      if (!this.state) return;
      const now = Date.now();
      const silent = this.reapSilentSockets(now);
      if (prune(this.state, now) || silent) await this.commit();
      else if (this.state.publishAt <= Date.now()) await this.publish();
      else await this.schedule();
    });
  }

  private async lost(socket: WebSocket): Promise<void> {
    await this.locked(async () => {
      if (!this.state) return;
      const attachment = socket.deserializeAttachment() as Attachment;
      if (disconnect(this.state, attachment.memberId, attachment.connectionId, Date.now()))
        await this.commit();
    });
  }
  override webSocketMessage(socket: WebSocket): void {
    socket.close(1008, "Only heartbeat messages are supported");
  }
  override async webSocketClose(socket: WebSocket, _code: number): Promise<void> {
    socket.close(1000, "Closed");
    await this.lost(socket);
  }
  override async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "Connection lost");
    await this.lost(socket);
  }
}
