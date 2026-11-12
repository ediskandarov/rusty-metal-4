import { createServerClient } from "@tm4/rustymetal-server-client";
import type { HealthSnapshot } from "@tm4/rustymetal-server-client/schemas";
import { DurableObject } from "cloudflare:workers";

import { isolated } from "../assets.ts";
import { exportHealth } from "../telemetry.ts";
import { ServerJournal } from "./journal.ts";

export interface ServerEnv {
  TM4_ADMIN_SECRET: string;
  HEALTH: AnalyticsEngineDataset;
  CONTAINER_VCPU: string;
}

const idleTimeoutMs = 5 * 60 * 1000;
const httpPort = 8120;
const matchPort = 8122;
const metricsIntervalMs = 10_000;

export class TestServer extends DurableObject<ServerEnv> {
  private journal = new ServerJournal(this.ctx.storage);
  private archiving: Promise<void> | undefined;

  private archiveJournal() {
    return (this.archiving ??= (async () => {
      if (!this.ctx.container?.running) return;
      const response = await this.ctx.container
        .getTcpPort(httpPort)
        .fetch("http://container/api/journal", {
          headers: { Authorization: `Bearer ${this.env.TM4_ADMIN_SECRET}` },
          signal: AbortSignal.timeout(5000),
        });
      if (response.status === 404) {
        await response.body?.cancel();
        return;
      }
      await this.journal.save(response);
    })()
      .catch((error) => {
        console.error("Journal archive failed", String(error));
      })
      .finally(() => {
        this.archiving = undefined;
      }));
  }

  private starting: Promise<void> | undefined;
  private previousHealth: HealthSnapshot | undefined;
  private lastExternalActivity = Date.now();
  private emptySince: number | undefined;

  constructor(ctx: DurableObjectState, env: ServerEnv) {
    super(ctx, env);
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        this.lastExternalActivity =
          (await ctx.storage.get<number>("lastExternalActivity")) ?? Date.now();
        this.emptySince = await ctx.storage.get<number>("emptySince");
        this.previousHealth = await ctx.storage.get<HealthSnapshot>("previousHealth");
        await ctx.container!.setInactivityTimeout(idleTimeoutMs);
        await this.scheduleMetrics();
      });
    }
  }

  private get vcpu(): number {
    const value = Number(this.env.CONTAINER_VCPU);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid container CPU allocation");
    return value;
  }

  private api() {
    return createServerClient({
      baseURL: "http://container/api/",
      headers: () => ({ Authorization: "Bearer " + this.env.TM4_ADMIN_SECRET }),
      fetch: (request) => this.ctx.container!.getTcpPort(httpPort).fetch(request),
    });
  }

  private async ready(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      container.start({
        image: container.images.base!,
        instance: { vcpu: this.vcpu, memoryMib: 256, diskMb: 2000 },
        enableInternet: false,
        env: { TM4_ADMIN_SECRET: this.env.TM4_ADMIN_SECRET },
      });
      await container.setInactivityTimeout(idleTimeoutMs);
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await this.api().status(AbortSignal.timeout(1000));
        await this.scheduleMetrics();
        return;
      } catch {
        // Only readiness probes are retried; uploads and game messages are never replayed.
      }
      await scheduler.wait(200);
    }
    throw new Error("Test server did not become ready");
  }

  private async scheduleMetrics(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + metricsIntervalMs);
    }
  }

  override async alarm(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      this.previousHealth = undefined;
      await this.journal.expire();
      const meta = await this.journal.metadata();
      if (meta) await this.ctx.storage.setAlarm(meta.expiresAt);
      else await this.ctx.storage.deleteAll();
      return;
    }
    const saved = await this.journal.metadata();
    if (!saved || Date.now() - saved.savedAt >= 30_000) await this.archiveJournal();
    try {
      const snapshot = await this.api().health(AbortSignal.timeout(3000));
      exportHealth(
        this.env.HEALTH,
        this.ctx.id.toString(),
        this.vcpu,
        snapshot,
        this.previousHealth,
      );
      this.previousHealth = snapshot;
      await this.ctx.storage.put("previousHealth", snapshot);
      this.env.HEALTH.writeDataPoint({
        indexes: [this.ctx.id.toString()],
        blobs: ["rustymetal4_telemetry_scrape_success", "gauge"],
        doubles: [1],
      });
      const connected =
        snapshot.measurements.find((row) => row.name === "rustymetal4_players_connected")?.value ??
        0;
      if (connected === 0 && this.emptySince === undefined) {
        this.emptySince = Date.now();
        await this.ctx.storage.put("emptySince", this.emptySince);
      } else if (connected > 0 && this.emptySince !== undefined) {
        this.emptySince = undefined;
        await this.ctx.storage.delete("emptySince");
      }
      const remaining =
        Math.max(this.lastExternalActivity, this.emptySince ?? 0) + idleTimeoutMs - Date.now();
      // Monitoring must not keep an empty container alive indefinitely.
      if (connected === 0) {
        await container.setInactivityTimeout(Math.max(1, remaining));
        if (remaining <= 0) {
          const meta = await this.journal.metadata();
          if (meta) await this.ctx.storage.setAlarm(meta.expiresAt);
          return;
        }
      } else {
        await container.setInactivityTimeout(idleTimeoutMs);
      }
    } catch (error) {
      this.env.HEALTH.writeDataPoint({
        indexes: [this.ctx.id.toString()],
        blobs: ["rustymetal4_telemetry_scrape_success", "gauge"],
        doubles: [0],
      });
      console.error(
        "Application health collection failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      if (
        this.emptySince !== undefined &&
        Date.now() - Math.max(this.lastExternalActivity, this.emptySince) >= idleTimeoutMs
      ) {
        // A monitoring failure must never actively terminate a match.
        const meta = await this.journal.metadata();
        if (meta) await this.ctx.storage.setAlarm(meta.expiresAt);
        return;
      }
    }
    if (container.running) await this.ctx.storage.setAlarm(Date.now() + metricsIntervalMs);
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/_server/stop") {
      await this.ctx.storage.deleteAlarm();
      this.previousHealth = undefined;
      this.emptySince = undefined;
      await this.ctx.storage.delete("emptySince");
      await this.ctx.storage.delete("previousHealth");
      await this.archiveJournal();
      if (this.ctx.container!.running) await this.ctx.container!.destroy();
      const meta = await this.journal.metadata();
      await this.ctx.storage.delete("lastExternalActivity");
      if (meta) await this.ctx.storage.setAlarm(meta.expiresAt);
      return new Response(null, {
        status: 204,
        headers: meta ? { "X-Journal-Expires-At": String(meta.expiresAt) } : {},
      });
    }
    const path = new URL(request.url).pathname;
    if (path === "/_server/journal") {
      await this.archiveJournal();
      return this.journal.download();
    }
    if (path === "/_server/measure") {
      if (!this.ctx.container!.running) return new Response("Server not running", { status: 409 });
      const endpoint = "system-metrics";
      return this.ctx.container!.getTcpPort(httpPort).fetch(`http://container/api/${endpoint}`, {
        headers: { Authorization: `Bearer ${this.env.TM4_ADMIN_SECRET}` },
      });
    }
    if (path === "/api/status" && !this.ctx.container!.running) {
      return isolated(
        Response.json(
          {
            phase: "setup",
            sessionId: null,
            cars: [],
            compatibility: null,
            sleeping: true,
            message: "Administrator: supply your disc resources to start the server.",
            players: 2,
            worlds: [],
            world: null,
            connected: 0,
            tick: 0,
            endpoint: "/match",
            uploaded: 0,
            required: 0,
          },
          { headers: { "Cache-Control": "no-store" } },
        ),
      );
    }
    const startsServer =
      path === "/api/resources" ||
      path.startsWith("/api/resources/") ||
      path === "/api/prepare" ||
      path === "/api/start";
    if (!this.ctx.container!.running && !startsServer)
      return new Response("Server not running", { status: 409 });
    if (startsServer) {
      this.lastExternalActivity = Date.now();
      await this.ctx.storage.put("lastExternalActivity", this.lastExternalActivity);
    }
    this.starting ??= this.ready().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    const url = new URL(request.url);
    const match = url.pathname === "/match";
    url.protocol = "http:";
    url.host = "container";
    if (match) url.pathname = "/";
    const forwarded = new Request(url.href, request);
    forwarded.headers.delete("host");
    forwarded.headers.delete("cookie");
    if (!match) forwarded.headers.set("Authorization", `Bearer ${this.env.TM4_ADMIN_SECRET}`);
    return this.ctx.container!.getTcpPort(match ? matchPort : httpPort).fetch(forwarded);
  }
}
