import { mapLabel } from "@tm4/rooms-client/schemas";
import { createServerClient } from "@tm4/rustymetal-server-client";
import { DurableObject } from "cloudflare:workers";

import { failure, json, readJson } from "../http.ts";
import {
  beginPreparation,
  connect,
  createState,
  directoryRefresh,
  disconnect,
  edit,
  emptyMatchGrace,
  freezeRoster,
  invalidateReady,
  join,
  memberFor,
  monitoringGrace,
  monitoringTimeout,
  nextDeadline,
  object,
  prune,
  reconnectGrace,
  removeMember,
  requireHost,
  resetMatch,
  RoomError,
  type RoomState,
  snapshot,
  summary,
  updatePlayer,
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
  protected state: RoomState | undefined;
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
        if (state.match) {
          await this.stopMatch("Room closed.");
          if (state.match) return;
        }
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

  private server(path: string, init?: RequestInit): Promise<Response> {
    const state = this.state!;
    const match = state.match!;
    return this.env.SERVER.getByName(state.id + ":" + match.id).fetch(
      new Request("https://server" + path, {
        ...init,
        signal:
          path === "/match"
            ? undefined
            : AbortSignal.timeout(path === "/api/status" ? monitoringTimeout : 30_000),
      }),
    );
  }

  private api() {
    return createServerClient({
      baseURL: "https://server/api/",
      fetch: (request) =>
        this.server(new URL(request.url).pathname, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
    });
  }

  private async stopMatch(message: string): Promise<void> {
    const state = this.state!;
    const match = state.match;
    if (!match) return;
    match.stage = "stopping";
    match.message = message;
    match.pollAt = Date.now() + 2000;
    await this.ctx.storage.put("room", state);
    await this.schedule();
    try {
      const response = await this.server("/_server/stop", { method: "POST" });
      if (!response.ok) throw new Error("Container stop failed");
      await this.env.DIRECTORY.getByName("public").releaseMatch(state.id, match.id);
      const expiresAt = Number(response.headers.get("X-Journal-Expires-At"));
      if (expiresAt > Date.now()) state.journal = { matchId: match.id, expiresAt };
      resetMatch(state, message, Date.now());
      await this.commit();
    } catch {
      // Keep the session identity and retry destruction before allowing another allocation.
      await this.schedule();
      this.broadcast();
    }
  }

  private async monitorMatch(now: number): Promise<void> {
    const state = this.state!;
    const match = state.match;
    if (!match) return;
    if (match.stage === "stopping") {
      await this.stopMatch(match.message);
      return;
    }
    if (!state.members.some((member) => member.connections.length))
      match.emptyUntil ??= now + emptyMatchGrace;
    else match.emptyUntil = null;
    if (
      (match.emptyUntil !== null && match.emptyUntil <= now) ||
      (match.stage !== "playing" && match.deadline <= now) ||
      (!match.roster.length && state.hostId !== match.ownerId)
    ) {
      await this.stopMatch(
        "Preparation or reconnect time expired. Prepare a new match when everyone is here.",
      );
      return;
    }
    if (match.monitoringUnavailableUntil != null && match.monitoringUnavailableUntil <= now) {
      await this.stopMatch("The match service remained unavailable. Prepare a new match.");
      return;
    }
    match.pollAt = now + 2000;
    try {
      // A timed-out renewal may still finish remotely. Its lease remains capacity-counted
      // and Directory confirms destruction before reclaiming any expired reservation.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reserved: boolean;
      try {
        reserved = await Promise.race([
          this.env.DIRECTORY.getByName("public").reserveMatch(state.id, match.id),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Reservation check timed out")),
              monitoringTimeout,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!reserved) {
        await this.stopMatch("The server reservation expired. Prepare a new match.");
        return;
      }
      const status = await this.api().status();
      if (status.sleeping || ["failed", "closed"].includes(status.phase)) {
        await this.stopMatch(
          status.sleeping
            ? "The match server stopped. Prepare a new match."
            : status.message || "The match server stopped. Prepare a new match.",
        );
        return;
      }
      if (match.roster.length && status.sessionId !== match.id) {
        await this.stopMatch("The match server session changed.");
        return;
      }
      const inspections = [];
      if (status.phase === "match" && match.stage === "playing") {
        for (const entry of match.roster) {
          if (!entry.pending) continue;
          // Query the simulation thread after reservation, rather than infer loss
          // from transport state or a periodically published status snapshot.
          const lease = await this.api().membershipStatus({
            sessionId: match.id,
            credential: entry.credential,
          });
          inspections.push({ entry, lease });
        }
      }
      // General status alone cannot recover a pending-lease monitoring outage.
      // Clear the first deadline only after all required checks have succeeded,
      // including before any state-transition or reconciliation commit returns.
      match.monitoringUnavailableUntil = null;
      if (status.phase === "results") {
        await this.stopMatch("Match finished. You are back in the same room.");
        return;
      }
      if (status.phase === "lobby" && match.stage === "starting") {
        match.stage = "connecting";
        match.message = "Server ready. Connecting the prepared participants…";
        await this.commit();
        return;
      }
      if (status.phase === "match" && match.stage === "playing") {
        let changed = false;
        for (const { entry, lease } of inspections) {
          if (lease.identity && !lease.pending) {
            entry.pending = false;
            changed = true;
          } else if (!lease.identity) {
            match.roster = match.roster.filter((old) => old !== entry);
            const member = state.members.find((member) => member.id === entry.id);
            if (member) member.ready = false;
            changed = true;
          }
        }
        if (changed) {
          prune(state, now);
          await this.commit();
          return;
        }
      }
      if (status.phase === "match" && match.stage !== "playing") {
        match.stage = "playing";
        match.message =
          "Match in progress. New players can join with a prepared car; existing players can reconnect.";
        await this.commit();
        return;
      }
      if (status.phase === "ready" && match.stage === "validating") {
        if (!status.compatibility || !status.cars?.length) {
          await this.stopMatch("The server did not provide a compatible game catalog.");
          return;
        }
        match.compatibility = status.compatibility;
        match.cars = status.cars;
        match.stage = "ready";
        match.message =
          "Server ready. Choose cars and ready every participant; the host can start with 2–8 players.";
        invalidateReady(state);
        await this.commit();
        return;
      }
    } catch {
      // Persist the first outage deadline, including across eviction. HTTP errors,
      // timeouts and temporary directory failures do not establish that gameplay ended.
      match.monitoringUnavailableUntil ??= Date.now() + monitoringGrace;
      if (match.monitoringUnavailableUntil <= Date.now()) {
        await this.stopMatch("The match service remained unavailable. Prepare a new match.");
        return;
      }
      match.pollAt = Math.min(Date.now() + 2000, match.monitoringUnavailableUntil);
    }
    await this.ctx.storage.put("room", state);
    await this.schedule();
  }

  private async matchRequest(request: Request, key: string): Promise<Response> {
    const state = this.state!;
    const match = state.match;
    const parts = new URL(request.url).pathname.split("/");
    if (parts[3] === "journal" && parts.length === 4 && request.method === "GET") {
      requireHost(state, key);
      const id = parts[2];
      if (
        id !== match?.id &&
        (!state.journal || id !== state.journal.matchId || state.journal.expiresAt <= Date.now())
      )
        throw new RoomError(404, "This match journal is no longer available.");
      const response = await this.env.SERVER.getByName(state.id + ":" + id).fetch(
        "https://server/_server/journal",
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new RoomError(
          response.status,
          "No server journal is available yet, or it has expired.",
        );
      }
      const headers = new Headers(response.headers);
      headers.set(
        "Content-Disposition",
        'attachment; filename="rustymetal4-server-' + id + '.tm4j"',
      );
      return new Response(response.body, { headers });
    }
    if (!match || parts[2] !== match.id)
      throw new RoomError(409, "This match has ended. Return to the room.");
    const member = memberFor(state, key);
    if (!member) throw new RoomError(403, "Join this room first.");
    const action = parts.slice(3).join("/");
    if (action === "socket") {
      if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        throw new RoomError(426, "A game WebSocket is required.");
      if (
        !["connecting", "playing"].includes(match.stage) ||
        !match.roster.some((entry) => entry.id === member.id)
      )
        throw new RoomError(403, "Prepare your participation before connecting to this match.");
      return this.server("/match", { headers: { Upgrade: "websocket" } });
    }
    requireHost(state, key);
    if (action === "cancel" && request.method === "POST" && !match.roster.length) {
      await this.stopMatch("Preparation cancelled. You can prepare another match.");
      return json({ room: snapshot(state, key) });
    }
    if (member.id !== match.ownerId || match.stage !== "uploading")
      throw new RoomError(409, "Resource setup is locked.");
    const manifest = action === "resources" && request.method === "GET";
    const upload = /^resources\/DATA\/[A-Za-z0-9_./-]+$/.test(action) && request.method === "PUT";
    const prepare = action === "prepare" && request.method === "POST";
    if (!manifest && !upload && !prepare) throw new RoomError(404, "Unknown match endpoint.");
    // Native upload validation bounds each resource's exact stock size and a 15-second request.
    try {
      const response = await this.server("/api/" + action, {
        method: request.method,
        headers: {
          "Content-Type": request.headers.get("content-type") ?? "application/octet-stream",
        },
        body: upload ? request.body : undefined,
      });
      if (!response.ok) {
        const message = await response.text();
        await this.stopMatch("Resource setup failed. Prepare the server and try again.");
        throw new RoomError(response.status, message);
      }
      if (prepare) {
        match.stage = "validating";
        match.message = "Validating server resources…";
        await this.commit();
      }
      return response;
    } catch (error) {
      if (state.match?.id === match.id)
        await this.stopMatch("Resource setup failed. Prepare the server and try again.");
      throw error;
    }
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
        if (path.startsWith("/match/")) return await this.matchRequest(request, key);
        if (path === "/" && request.method === "GET") return json({ room: snapshot(state, key) });
        if (path === "/join" && request.method === "POST") {
          const input = object(await readJson(request));
          join(state, key, input.playerName, now);
          await this.commit();
        } else if (path === "/player" && request.method === "POST") {
          updatePlayer(state, key, await readJson(request));
          const member = memberFor(state, key)!;
          const match = state.match;
          if (
            match?.stage === "playing" &&
            member.ready &&
            !match.roster.some((entry) => entry.id === member.id)
          ) {
            const credential = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
            try {
              await this.api().membership({
                sessionId: match.id,
                change: { kind: "admit", credential, car: member.car! },
              });
              match.roster.push({ id: member.id, credential, car: member.car!, pending: true });
            } catch (error) {
              member.ready = false;
              // A lost HTTP response cannot leave an indefinite reservation.
              // Native preparation also has its own bounded cancellation deadline.
              try {
                await this.api().membership({
                  sessionId: match.id,
                  change: { kind: "depart", credential },
                });
              } catch {
                /* Authority expires an unreachable pending preparation. */
              }
              await this.commit();
              throw error;
            }
          }
          await this.commit();
        } else if (path === "/prepare" && request.method === "POST") {
          const match = beginPreparation(state, key, now);
          await this.commit();
          try {
            if (!(await this.env.DIRECTORY.getByName("public").reserveMatch(state.id, match.id)))
              throw new RoomError(503, "All match servers are busy. Try again shortly.");
            const response = await this.server("/api/resources");
            if (!response.ok) throw new Error("The match server could not start.");
            await response.body?.cancel();
          } catch (error) {
            await this.stopMatch("Server preparation failed. Please try again.");
            throw error;
          }
        } else if (path === "/start" && request.method === "POST") {
          const match = freezeRoster(state, key, now);
          await this.commit();
          try {
            await this.api().start({
              players: state.settings.capacity,
              world: mapLabel(state.settings.mapId),
              sessionId: match.id,
              roster: match.roster.map(({ credential, car }) => ({ credential, car })),
            });
          } catch (error) {
            await this.stopMatch("Match startup failed. Prepare the server and try again.");
            throw error;
          }
        } else if (path === "/settings" && request.method === "POST") {
          edit(state, key, await readJson(request));
          await this.commit();
        } else if (path === "/leave" && request.method === "POST") {
          const member = memberFor(state, key);
          if (member) {
            const match = state.match;
            const lease = match?.roster.find((entry) => entry.id === member.id);
            if (match?.stage === "playing" && lease) {
              await this.api().membership({
                sessionId: match.id,
                change: { kind: "depart", credential: lease.credential },
              });
              match.roster = match.roster.filter((entry) => entry.id !== member.id);
            } else if (match?.roster.length && lease) {
              throw new RoomError(
                409,
                "Wait for the match to start before leaving its gameplay seat.",
              );
            }
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
      await this.monitorMatch(now);
      if (!this.state) return;
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
