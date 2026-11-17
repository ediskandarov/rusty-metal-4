import { maps, modes } from "@tm4/rooms-client/schemas";

import pinnedChallenge from "../../../../config/challenge-release.json";
import { frontend, isolated } from "../assets.ts";
import { challengeVersion, releasePath } from "../challenge.ts";
import { digest, failure, json, readJson } from "../http.ts";
import { object, RoomError, text } from "../room-state.ts";
import type { ChallengeLeaderboard } from "./challenge.ts";
import type { RoomDirectory } from "./directory.ts";
import type { Room } from "./room.ts";
import type { TestServer } from "./test-server.ts";

export { ChallengeLeaderboard } from "./challenge.ts";
export { RoomDirectory } from "./directory.ts";
export { Room } from "./room.ts";
export { TestServer } from "./test-server.ts";
export interface Env {
  CHALLENGE: DurableObjectNamespace<ChallengeLeaderboard>;
  CHALLENGE_RELEASES?: R2Bucket;
  CHALLENGE_BUILD_ID?: string;
  SERVER: DurableObjectNamespace<TestServer>;
  TM4_ADMIN_SECRET: string;
  ROOMS: DurableObjectNamespace<Room>;
  DIRECTORY: DurableObjectNamespace<RoomDirectory>;
  ASSETS: Fetcher;
  CREATION_LIMIT: RateLimit;
  REQUEST_LIMIT: RateLimit;
}
const sessionName = "rm4_session";
function credential(request: Request, name = sessionName): string | null {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const release = /^\/challenge-releases\/([a-f0-9]{64})\/(.*)$/.exec(url.pathname);
      if (release) {
        if (!["GET", "HEAD"].includes(request.method))
          return isolated(new Response(null, { status: 405 }));
        const file = release[2] || "index.html";
        if (
          !/^[A-Za-z0-9_./-]+$/.test(file) ||
          file.split("/").some((part) => part === "." || part === "..")
        )
          return isolated(new Response("Not found", { status: 404 }));
        const object = await env.CHALLENGE_RELEASES?.get(`${release[1]}/${file}`);
        if (!object) return isolated(new Response("Challenge release not found", { status: 404 }));
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("ETag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return isolated(new Response(request.method === "HEAD" ? null : object.body, { headers }));
      }
      const api = url.pathname.startsWith("/api/");
      if (!api) {
        if (/^\/rooms\/[a-f0-9]{32}\/?$/.test(url.pathname)) {
          const target = new URL("/rooms/", url);
          return frontend(env.ASSETS, new Request(target.href, request));
        }
        return frontend(env.ASSETS, request);
      }
      const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if ((request.method !== "GET" || websocket) && request.headers.get("origin") !== url.origin)
        throw new RoomError(403, "Open the room on this website to continue.");
      if (!["GET", "POST", "PUT"].includes(request.method))
        throw new RoomError(405, "This request method is not supported.");
      if (url.pathname === "/api/challenge/release" && request.method === "GET") {
        const buildId = env.CHALLENGE_BUILD_ID ?? pinnedChallenge.buildId;
        return json({
          release: buildId
            ? { buildId, version: challengeVersion, playerUrl: releasePath(buildId) }
            : null,
        });
      }
      if (url.pathname.startsWith("/api/challenge/")) {
        const name = "rm4_challenge";
        let secret = credential(request, name);
        const issue = request.method === "POST" && url.pathname === "/api/challenge/identity";
        if (issue) {
          secret ??= [...crypto.getRandomValues(new Uint8Array(32))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const response = json({ ok: true });
          response.headers.set(
            "Set-Cookie",
            `${name}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${url.protocol === "https:" ? "; Secure" : ""}`,
          );
          return response;
        }
        const match = /^\/api\/challenge\/(leaderboard|profile|completion)$/.exec(url.pathname);
        if (!match) throw new RoomError(404, "Unknown challenge endpoint.");
        if (!secret && match[1] !== "leaderboard")
          throw new RoomError(401, "Enable cookies and try again.");
        const headers = new Headers({
          "Content-Type": "application/json",
          "x-challenge-identity": secret ? await digest(secret) : "",
        });
        return env.CHALLENGE.getByName("200-challenge").fetch(
          new Request(`https://challenge/${match[1]}`, {
            method: request.method,
            headers,
            body: request.method === "POST" ? JSON.stringify(await readJson(request)) : null,
          }),
        );
      }
      if (url.pathname === "/api/catalog" && request.method === "GET") return json({ maps, modes });
      if (url.pathname === "/api/session" && request.method === "POST") {
        if (credential(request)) return json({ ok: true, serverTime: Date.now() });
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const response = json({ ok: true, serverTime: Date.now() });
        response.headers.set(
          "Set-Cookie",
          `${sessionName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${url.protocol === "https:" ? "; Secure" : ""}`,
        );
        return response;
      }
      if (
        (url.pathname === "/api/rooms" || url.pathname === "/api/directory/live") &&
        request.method === "GET"
      )
        return env.DIRECTORY.getByName("public").fetch(request);
      const secret = credential(request);
      if (!secret && request.method !== "GET")
        throw new RoomError(401, "Enable cookies and try again.");
      const key = secret ? await digest(secret) : "";
      if (request.method === "POST") {
        const ip = await digest(request.headers.get("cf-connecting-ip") ?? "local");
        const allowed = await env.REQUEST_LIMIT.limit({ key: ip });
        if (!allowed.success) throw new RoomError(429, "Too many requests. Please wait a minute.");
      }
      let id: string;
      let path: string;
      let body: string | ReadableStream<Uint8Array> | null | undefined;
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const input = object(await readJson(request));
        text(input.name, "Room name", 48);
        text(input.playerName, "Player name", 24);
        if (typeof input.requestId !== "string" || !/^\d{13}\.[a-f0-9-]{36}$/.test(input.requestId))
          throw new RoomError(400, "A valid creation request ID is required.");
        const ip = await digest(request.headers.get("cf-connecting-ip") ?? "local");
        const [bySession, byAddress] = await Promise.all([
          env.CREATION_LIMIT.limit({ key: `session:${key}` }),
          env.CREATION_LIMIT.limit({ key: `address:${ip}` }),
        ]);
        if (!bySession.success || !byAddress.success)
          throw new RoomError(429, "You have created several rooms. Please wait a minute.");
        id = (await digest(`${key}:${input.requestId}`)).slice(0, 32);
        path = "/create";
        body = JSON.stringify(input);
      } else {
        const match =
          /^\/api\/rooms\/([a-f0-9]{32})(\/(?:join|settings|leave|live|player|prepare|start|match\/[a-f0-9-]{36}\/(?:journal|cancel|resources(?:\/DATA\/[A-Za-z0-9_./-]+)?|prepare|socket)))?$/.exec(
            url.pathname,
          );
        if (!match) throw new RoomError(404, "Unknown room endpoint.");
        id = match[1]!;
        path = match[2] ?? "/";
        if (path.includes("/match/")) body = request.body;
        else if (request.method === "POST") body = JSON.stringify(await readJson(request));
      }
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.set("x-room-session", key);
      headers.set("x-room-id", id);
      return await env.ROOMS.getByName(id).fetch(
        new Request(`https://room${path}`, {
          method: request.method,
          headers,
          body,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
