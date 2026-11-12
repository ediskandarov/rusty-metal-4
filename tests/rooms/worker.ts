import type { RoomSummary } from "@tm4/rooms-client/schemas";
import { DurableObject } from "cloudflare:workers";

import type { RoomState } from "../../apps/rustymetal4.com/src/room-state.ts";
import { RoomDirectory as ProductionDirectory } from "../../apps/rustymetal4.com/src/worker/directory.ts";
import { ServerJournal } from "../../apps/rustymetal4.com/src/worker/journal.ts";
import { Room as ProductionRoom } from "../../apps/rustymetal4.com/src/worker/room.ts";

export { default } from "../../apps/rustymetal4.com/src/worker/index.ts";

// These inspection/fault controls exist only in the local integration worker bundle.
export class Room extends ProductionRoom {
  async restoreMatchFromStorageForTest() {
    this.state = undefined;
    this.state = await this.ctx.storage.get<RoomState>("room");
    return this.state?.match;
  }
  async checkMatchForTest() {
    await this.alarm();
    return this.state?.match;
  }
  async emptyMatchForTest() {
    if (this.state?.match) {
      for (const member of this.state.members) member.connections = [];
      this.state.match.emptyUntil = Date.now() - 1;
    }
    await this.alarm();
  }
  async expireMatchForTest() {
    if (this.state?.match) this.state.match.deadline = Date.now() - 1;
    await this.alarm();
  }
  async ageSilentSocketsForTest() {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {
        memberId: string;
        connectionId: string;
        connectedAt: number;
      };
      socket.serializeAttachment({ ...attachment, connectedAt: Date.now() - 71_000 });
    }
    await this.ctx.storage.setAlarm(Date.now());
  }
  async inspectForTest() {
    return {
      entries: [...(await this.ctx.storage.list())],
      alarm: await this.ctx.storage.getAlarm(),
      sockets: this.ctx.getWebSockets().length,
    };
  }
}
export class RoomDirectory extends ProductionDirectory {
  private unavailable = false;
  private reservationUnavailable = false;
  setReservationUnavailableForTest(value: boolean) {
    this.reservationUnavailable = value;
  }
  override async reserveMatch(room: string, session: string) {
    if (this.reservationUnavailable) throw new Error("Temporary reservation RPC outage");
    return super.reserveMatch(room, session);
  }
  async reservationForTest(room: string) {
    return this.ctx.storage.get<{ session: string; until: number }>("match:" + room);
  }
  setUnavailableForTest(value: boolean) {
    this.unavailable = value;
  }
  async expireListingsForTest() {
    const entries = await this.ctx.storage.list<{ summary: RoomSummary; expiresAt: number }>({
      prefix: "room:",
    });
    for (const [key, value] of entries) {
      const expired = { ...value, expiresAt: Date.now() - 1 };
      await this.ctx.storage.put(key, expired);
      this.listings.set(key, expired);
    }
    await super.alarm();
  }
  async inspectDirectoryForTest() {
    return {
      entries: [...(await this.ctx.storage.list())],
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  override async publish(id: string, summary: RoomSummary | null) {
    if (this.unavailable) throw new Error("Directory outage for integration test");
    return super.publish(id, summary);
  }
}

// A deterministic native boundary for authority tests. Real game coverage uses the local process bridge.
export class TestServer extends DurableObject<{ NATIVE_URL?: string }> {
  private phase = "setup";
  private sessionId: string | null = null;
  private starts = 0;
  private stops = 0;
  private failUpload = false;
  private failStop = false;
  private statusFailure: "http" | "timeout" | null = null;
  private roster: unknown[] = [];
  configureForTest(options: {
    phase?: string;
    failUpload?: boolean;
    failStop?: boolean;
    statusFailure?: "http" | "timeout" | null;
    sessionId?: string;
  }) {
    Object.assign(this, options);
  }
  inspectForTest() {
    return { phase: this.phase, starts: this.starts, stops: this.stops, roster: this.roster };
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (this.env.NATIVE_URL)
      return fetch(this.env.NATIVE_URL + "/" + this.ctx.id.toString() + path, request);
    if (path === "/_server/stop") {
      if (this.failStop) return new Response("Stop temporarily failed", { status: 503 });
      this.stops++;
      this.phase = "stopped";
      const meta = await new ServerJournal(this.ctx.storage).metadata();
      return new Response(null, {
        status: 204,
        headers: meta ? { "X-Journal-Expires-At": String(meta.expiresAt) } : {},
      });
    }
    if (path === "/api/resources") {
      this.starts++;
      return Response.json([{ id: "/DATA/MAIN.MR" }]);
    }
    if (path.startsWith("/api/resources/")) {
      await request.arrayBuffer();
      return new Response(this.failUpload ? "Invalid stock resource" : "Uploaded", {
        status: this.failUpload ? 400 : 200,
      });
    }
    if (path === "/api/prepare") {
      this.phase = "ready";
      return new Response(null, { status: 202 });
    }
    if (path === "/_server/journal") return new ServerJournal(this.ctx.storage).download();
    if (path === "/api/start") {
      const input = (await request.json()) as { sessionId: string; roster: unknown[] };
      this.sessionId = input.sessionId;
      this.roster = input.roster;
      this.phase = "match";
      await new ServerJournal(this.ctx.storage).save(
        new Response(new Uint8Array([84, 77, 52, 74, 82, 78, 76, 1, 0, 1, 2]), {
          headers: { "Content-Length": "11" },
        }),
      );
      return new Response(null, { status: 202 });
    }
    if (path === "/api/status") {
      if (this.statusFailure === "http")
        return new Response("Temporary monitoring outage", { status: 503 });
      if (this.statusFailure === "timeout") await scheduler.wait(6000);
      return Response.json({
        phase: this.phase,
        players: 2,
        worlds: ["Construction Yard"],
        world: "Construction Yard",
        connected: 2,
        tick: 0,
        endpoint: "/match",
        uploaded: 1,
        required: 1,
        sessionId: this.sessionId,
        cars: ["Orbital", "Pizza Boy"],
        compatibility: { protocol: 9, build: "a".repeat(64), content: "b".repeat(64) },
        message: "Native fixture status",
      });
    }
    if (path === "/match") {
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Missing", { status: 404 });
  }
}
