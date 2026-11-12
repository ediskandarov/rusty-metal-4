/// <reference types="bun" />
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildSite } from "../../tools/web/build.ts";

const root = resolve(import.meta.dir, "../..");
const site = join(root, "build/release/rustymetal4.com-site");
await rm(site, { recursive: true, force: true });
await buildSite("rustymetal4.com", "release", site);
