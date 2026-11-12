import { DurableObject } from "cloudflare:workers";

import { accessPage, hasSession, sameSecret, sessionCookie } from "./access.ts";
import { frontend, isolated } from "./assets.ts";
import { exportHealth, type HealthSnapshot, parseHealth } from "./telemetry.ts";

interface Env {
  SERVER: DurableObjectNamespace<TestServer>;
  ASSETS: Fetcher;
  TEST_ACCESS_CODE: string;
  TM4_ADMIN_SECRET: string;
  HEALTH: AnalyticsEngineDataset;
  CONTAINER_VCPU: string;
}

const idleTimeoutMs = 5 * 60 * 1000;
const httpPort = 8120;
const matchPort = 8122;
const metricsIntervalMs = 10_000;

export class TestServer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private previousHealth: HealthSnapshot | undefined;
  private lastExternalActivity = Date.now();
  private emptySince: number | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
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
        const response = await container
          .getTcpPort(httpPort)
          .fetch("http://container/api/status", { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) {
          await this.scheduleMetrics();
          return;
        }
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
      return;
    }
    try {
      const response = await container.getTcpPort(httpPort).fetch("http://container/api/metrics", {
        headers: { Authorization: `Bearer ${this.env.TM4_ADMIN_SECRET}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
      const snapshot = parseHealth(await response.json());
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
        if (remaining <= 0) return;
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
      if (this.ctx.container!.running) await this.ctx.container!.destroy();
      return new Response(null, { status: 204 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/_server/measure" || path === "/_server/journal") {
      if (!this.ctx.container!.running) return new Response("Server not running", { status: 409 });
      const endpoint = path === "/_server/measure" ? "system-metrics" : "journal";
      return this.ctx.container!.getTcpPort(httpPort).fetch(`http://container/api/${endpoint}`, {
        headers: { Authorization: `Bearer ${this.env.TM4_ADMIN_SECRET}` },
      });
    }
    if (path === "/api/status" && !this.ctx.container!.running) {
      return isolated(
        Response.json(
          {
            phase: "setup",
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
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    forwarded.headers.delete("cookie");
    return this.ctx.container!.getTcpPort(match ? matchPort : httpPort).fetch(forwarded);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.TEST_ACCESS_CODE || !env.TM4_ADMIN_SECRET)
      return new Response("Server access is not configured", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/_access" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });
      const length = Number(request.headers.get("content-length"));
      if (!length || length > 1024) return new Response("Invalid request size", { status: 413 });
      const code = new URLSearchParams(await request.text()).get("code") ?? "";
      if (!(await sameSecret(code, env.TEST_ACCESS_CODE)))
        return accessPage(env.ASSETS, request, true);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": await sessionCookie(env.TEST_ACCESS_CODE),
          "Cache-Control": "no-store",
        },
      });
    }
    if (!(await hasSession(request, env.TEST_ACCESS_CODE))) {
      return request.method === "GET" && request.headers.get("upgrade") !== "websocket"
        ? accessPage(env.ASSETS, request)
        : new Response("Test access code required", { status: 401 });
    }
    // Never derive the object name from user input: this deployment owns one container.
    if (url.pathname === "/match" && request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
    if (
      url.pathname.startsWith("/_server/") &&
      (request.method !== "POST" ||
        !(await sameSecret(
          request.headers.get("authorization") ?? "",
          `Bearer ${env.TM4_ADMIN_SECRET}`,
        )))
    ) {
      return new Response("Administrator secret required", { status: 401 });
    }
    if (
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/status" &&
      !(await sameSecret(
        request.headers.get("authorization") ?? "",
        `Bearer ${env.TM4_ADMIN_SECRET}`,
      ))
    ) {
      return new Response("Administrator secret required", { status: 401 });
    }
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/_server/") &&
      url.pathname !== "/match"
    )
      return frontend(env.ASSETS, request);
    try {
      return await env.SERVER.getByName("test").fetch(request);
    } catch (error) {
      console.error(
        "Test server request failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      return new Response("The test server is starting or unavailable. Try again shortly.", {
        status: 503,
        headers: { "Retry-After": "5", "Cache-Control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
