import { expect, test } from "bun:test";

import { buildManifest, loadBuildModules } from "@tm4/mr-preparation";

import { nameModule } from "../../packages/resources/src/mods/modules.ts";

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const browser = nameModule(empty, "c_toy.sym");
const authority = nameModule(new Uint8Array([...empty, 0, 2, 0, 1]), "c_toy.sym");
const digest = (bytes: Uint8Array<ArrayBuffer>) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const manifest = (bytes = browser) => ({
  sha256: "a".repeat(64),
  authoritySha256: digest(authority),
  modules: [{ name: "c_toy.wasm", sha256: digest(bytes), authoritySha256: digest(authority) }],
});

test("shared Wasm manifest checks each target and returns the registry identity", async () => {
  const build = await buildManifest(JSON.stringify(manifest()));
  try {
    expect(build.sha256).toBe("a".repeat(64));
    expect(build.authoritySha256).toBe(digest(authority));
    expect(build.moduleNames()).toEqual(["c_toy.wasm"]);
    expect(build.verifyModule("c_toy.wasm", browser, "browser")).toBe("c_toy.sym");
    expect(build.verifyModule("c_toy.wasm", authority, "authority")).toBe("c_toy.sym");
    expect(() => build.verifyModule("c_toy.wasm", browser, "authority")).toThrow("different build");
    expect(() => build.verifyModule("c_toy.wasm", authority, "browser")).toThrow("different build");
    expect(() => build.verifyModule("c_toy.wasm", browser, "typo")).toThrow("target");
    expect(() => build.verifyModule("unknown.wasm", browser, "browser")).toThrow("absent");
    build.verifyAuthority(authority);
    expect(() => build.verifyAuthority(browser)).toThrow("does not match");
    const read = (name: string) => {
      expect(name).toBe("c_toy.wasm");
      return Promise.resolve(browser);
    };
    expect(await loadBuildModules(build, "browser", read)).toEqual(
      new Map([["c_toy.sym", browser]]),
    );
    await expect(
      loadBuildModules(build, "browser", () => Promise.resolve(authority)),
    ).rejects.toThrow("different build");
    await expect(
      loadBuildModules(build, "browser", () => Promise.reject(Error("missing file"))),
    ).rejects.toThrow("missing file");
  } finally {
    build.free();
  }
});

test("matching hashes cannot hide a wrong or absent module identity", async () => {
  for (const bytes of [empty, nameModule(empty, "different.sym")]) {
    const build = await buildManifest(JSON.stringify(manifest(bytes)));
    try {
      expect(() => build.verifyModule("c_toy.wasm", bytes, "browser")).toThrow("identity");
    } finally {
      build.free();
    }
  }
});

test("manifest validation is supplied by Rust, including duplicate names and both hashes", async () => {
  const good = manifest();
  const invalid = [
    {},
    { ...good, modules: [] },
    { ...good, modules: [good.modules[0], good.modules[0]] },
    ...["sha256", "authoritySha256"].flatMap((field) => [
      { ...good, [field]: "BAD" },
      { ...good, modules: [{ ...good.modules[0], [field]: undefined }] },
      { ...good, modules: [{ ...good.modules[0], [field]: "F".repeat(64) }] },
    ]),
    ...["../c_toy.wasm", "1car.wasm", ".wasm", "x.sym"].map((name) => ({
      ...good,
      modules: [{ ...good.modules[0], name }],
    })),
  ];
  for (const value of invalid) await expect(buildManifest(JSON.stringify(value))).rejects.toThrow();
});

test("failed concurrent I/O can release the manifest before remaining reads settle", async () => {
  const value = manifest();
  value.modules.push({ ...value.modules[0]!, name: "pending.wasm" });
  const build = await buildManifest(JSON.stringify(value));
  let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
  let settled = false;
  const pending = new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
    finish = resolve;
  });
  await expect(
    loadBuildModules(build, "browser", async (name) => {
      if (name === "c_toy.wasm") throw Error("download failed");
      const bytes = await pending;
      settled = true;
      return bytes;
    }),
  ).rejects.toThrow("download failed");
  build.free();
  finish(browser);
  await pending;
  await Promise.resolve();
  expect(settled).toBe(true);
});
