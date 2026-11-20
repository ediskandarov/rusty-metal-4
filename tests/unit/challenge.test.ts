import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  challengeMaps,
  challengeModels,
  type ChallengePlayer,
  completion,
  releasePath,
} from "../../apps/rustymetal4.com/src/challenge.ts";
import { challengeRuntime } from "../../tools/challenge/local.ts";
import { publishObject } from "../../tools/challenge/publish.ts";
import {
  inventory,
  publicArtifact,
  releaseId,
  verifyRelease,
} from "../../tools/challenge/release.ts";

const reply = async (response: Promise<{ json(): Promise<unknown> }>) =>
  (await (await response).json()) as {
    added: boolean;
    player: ChallengePlayer;
    players: ChallengePlayer[];
    release: unknown;
  };
const attempt = { model: "Orbital", map: "Construction Yard", version: "200-v1" };
test("challenge catalog rejects bonus maps, created models and unknown versions", () => {
  expect(challengeMaps).toHaveLength(8);
  expect(new Set(challengeModels).size).toBe(22);
  expect(completion(attempt)).toEqual(attempt);
  expect(() => completion({ ...attempt, map: "The Pits" })).toThrow();
  expect(() => completion({ ...attempt, model: "My Car" })).toThrow();
  expect(() => completion({ ...attempt, version: "other" })).toThrow();
  expect(() => releasePath("../current")).toThrow();
});
test("leaderboard counts unique models across maps and permits equal display names", async () => {
  const mf = await challengeRuntime();
  try {
    const origin = (await mf.ready).origin;
    function driver() {
      let cookie = "";
      return async (path: string, body?: unknown) => {
        const response = await mf.dispatchFetch(`${origin}/api/challenge/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Origin: origin,
            Cookie: cookie,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.headers.has("set-cookie"))
          cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        return response;
      };
    }
    const a = driver(),
      b = driver();
    for (const client of [a, b]) {
      expect((await client("identity", {})).status).toBe(200);
      expect((await client("profile", { name: "Driver" })).status).toBe(200);
    }
    expect((await reply(a("completion", attempt))).added).toBe(true);
    const repeated = await reply(a("completion", { ...attempt, map: "The Carnival" }));
    expect(repeated.added).toBe(false);
    expect(repeated.player.score).toBe(1);
    expect(repeated.player.completions[0]!.map).toBe("Construction Yard");
    expect(repeated.player.completions[0]!.date).toMatch(/^\d{4}-/);
    expect((await reply(a("completion", { ...attempt, model: "Sweet Tooth" }))).player.score).toBe(
      2,
    );
    expect((await reply(b("completion", attempt))).player.score).toBe(1);
    const board = await reply(a("leaderboard"));
    expect(board.players.map((p: { score: number }) => p.score)).toEqual([2, 1]);
    expect(board.players[0]!.name).toBe(board.players[1]!.name);
    expect(board.players[0]!.id).not.toBe(board.players[1]!.id);
    expect((await a("completion", { ...attempt, map: "The Pits" })).status).toBe(400);
    const denied = await mf.dispatchFetch(`${origin}/api/challenge/identity`, {
      method: "POST",
      headers: { Origin: "https://elsewhere.test" },
    });
    expect(denied.status).toBe(403);
    expect((await reply(a("release"))).release).toBeNull();
  } finally {
    await mf.dispose();
  }
}, 30000);
test("complete release pin includes JS, HTML and modules and rejects changed bytes or disc assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm4-challenge-test-"));
  try {
    const directory = join(root, "release");
    for (const path of [
      "index.html",
      "tm4_web.js",
      "tm4_web.wasm",
      "simulation-build.json",
      "player-build.json",
      "challenge-build.json",
      "coi-serviceworker.js",
      "coi-serviceworker.LICENSE.txt",
      "modules/o_car.wasm",
      "_astro/player.js",
    ])
      await Bun.write(join(directory, path), `fixture:${path}`);
    const files = await inventory(directory);
    await Bun.write(
      join(directory, "release.json"),
      JSON.stringify({
        buildId: releaseId(files, true),
        version: "200-v1",
        diagnostic: true,
        files,
      }),
    );
    const first = await verifyRelease(directory);
    expect(first.files.some((file) => file.path === "_astro/player.js")).toBe(true);
    const mf = await challengeRuntime({ release: directory });
    try {
      const origin = (await mf.ready).origin;
      const pinned = (await (await mf.dispatchFetch(`${origin}/api/challenge/release`)).json()) as {
        release: { buildId: string; playerUrl: string };
      };
      expect(pinned.release.buildId).toBe(first.buildId);
      const asset = await mf.dispatchFetch(`${origin}${pinned.release.playerUrl}tm4_web.wasm`);
      expect(await asset.text()).toBe("fixture:tm4_web.wasm");
      expect(asset.headers.get("Content-Type")).toBe("application/wasm");
      expect(asset.headers.get("Cache-Control")).toContain("immutable");
      expect(asset.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(asset.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
      expect(
        (await mf.dispatchFetch(`${origin}${pinned.release.playerUrl}missing.wasm`)).status,
      ).toBe(404);
    } finally {
      await mf.dispose();
    }

    await Bun.write(join(directory, "index.html"), "changed");
    await expect(verifyRelease(directory)).rejects.toThrow("immutable build ID");
    expect(publicArtifact("DATA/MAIN.MR")).toBe(false);
    expect(publicArtifact("disc.bin")).toBe(false);
    expect(publicArtifact("modules/../MAIN.MR")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const commandResult = (exitCode: number, stdout = "", stderr = "") => ({
  exitCode,
  stdout: new TextEncoder().encode(stdout),
  stderr: new TextEncoder().encode(stderr),
});
const missingObject = () => commandResult(1, "", "The specified key does not exist.");

test("publisher resumes identical objects and refuses differing bytes without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rm4-publish-"));
  try {
    const file = join(directory, "index.html");
    await Bun.write(file, "hello");
    for (const identical of [true, false]) {
      const calls: string[] = [];
      const pending = publishObject(
        { bucket: "test", key: "release/index.html", file, contentType: "text/html" },
        (args) => {
          calls.push(args[2]!);
          expect(args).toContain("--remote");
          expect(args).toContain("--pipe");
          return Promise.resolve(commandResult(0, identical ? "hello" : "different"));
        },
      );
      if (identical) expect(await pending).toBe(false);
      else await expect(pending).rejects.toThrow("Refusing to overwrite");
      expect(calls).toEqual(["get"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "new object is uploaded and verified",
    replies: [missingObject(), commandResult(0), commandResult(0, "hello")],
    calls: ["get", "put", "get"],
    error: null,
  },
  {
    name: "authentication failure never uploads",
    replies: [commandResult(1, "", "Authentication error")],
    calls: ["get"],
    error: "could not read",
  },
  {
    name: "network failure never uploads",
    replies: [commandResult(1, "", "fetch failed")],
    calls: ["get"],
    error: "could not read",
  },
  {
    name: "failed upload is not successful",
    replies: [missingObject(), commandResult(1, "", "upload failed")],
    calls: ["get", "put"],
    error: "could not upload",
  },
  {
    name: "corrupted upload is rejected",
    replies: [missingObject(), commandResult(0), commandResult(0, "wrong")],
    calls: ["get", "put", "get"],
    error: "verification failed",
  },
  {
    name: "missing upload is rejected",
    replies: [missingObject(), commandResult(0), missingObject()],
    calls: ["get", "put", "get"],
    error: "verification failed",
  },
])("publisher: $name", async ({ replies, calls, error }) => {
  const directory = await mkdtemp(join(tmpdir(), "rm4-publish-"));
  try {
    const file = join(directory, "index.html");
    await Bun.write(file, "hello");
    const seen: string[] = [];
    const pending = publishObject(
      { bucket: "test", key: "release/index.html", file, contentType: "text/html" },
      (args) => {
        seen.push(args[2]!);
        expect(args[3]).toBe("test/release/index.html");
        expect(args).toContain("--remote");
        if (args[2] === "put") {
          expect(args[args.indexOf("--file") + 1]).toBe(file);
          expect(args[args.indexOf("--content-type") + 1]).toBe("text/html");
          expect(args[args.indexOf("--cache-control") + 1]).toContain("immutable");
        }
        const response = replies[seen.length - 1];
        if (!response) throw new Error("Unexpected Wrangler call");
        return Promise.resolve(response);
      },
    );
    if (error) await expect(pending).rejects.toThrow(error);
    else expect(await pending).toBe(true);
    expect(seen).toEqual([...calls]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
