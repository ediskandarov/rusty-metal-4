import { validateExecutable } from "./executable.ts";
import { sha256 } from "./hash.ts";
import { validateMainRegistry } from "./main.ts";
import { readMr } from "./mr.ts";
import { TimLayoutMismatch, validateTim } from "./tim.ts";
import type { TimLayout } from "./tim.ts";
import { validateVideo } from "./video.ts";

export type Compatibility = "compatible" | "warning" | "uncompatible";
export type ResourceStatus = Compatibility | "pending" | "checking";
export interface CheckResult {
  status: Compatibility;
  message: string;
}
export interface ResourceReference {
  id: string;
  size: number;
  sha256: string;
  tim?: TimLayout;
}
export interface ResourceCandidate {
  id: string;
  size: number;
  read?: (signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
}
export interface ResourceRow {
  id: string;
  size?: number;
  reference?: ResourceReference;
  status: ResourceStatus;
  message: string;
}

const compatible = (message: string): CheckResult => ({ status: "compatible", message });
const warning = (message: string): CheckResult => ({ status: "warning", message });
const uncompatible = (message: string): CheckResult => ({ status: "uncompatible", message });

export function isRequiredResource(id: string) {
  return !id.startsWith("AUDIO/") && !id.endsWith(".STR");
}

function absence(id: string): CheckResult {
  return isRequiredResource(id)
    ? uncompatible("Required resource is missing")
    : compatible(id.startsWith("AUDIO/") ? "Optional music is absent" : "Optional video is absent");
}

function resourceMap(resources: ResourceCandidate[]) {
  const found = new Map<string, ResourceCandidate>();
  for (const resource of resources) {
    if (found.has(resource.id)) throw new Error(`Duplicate resource: ${resource.id}`);
    found.set(resource.id, resource);
  }
  return found;
}

export function requireResources(resources: ResourceCandidate[], reference: ResourceReference[]) {
  const found = resourceMap(resources);
  const missing = reference.filter(
    (entry) => !found.has(entry.id) && absence(entry.id).status === "uncompatible",
  );
  if (missing.length)
    throw new Error(`Missing required resources: ${missing.map((entry) => entry.id).join(", ")}`);
}

export function compatibilityReport(rows: ResourceRow[]): {
  status: ResourceStatus;
  problems: string[];
} {
  const problems = rows
    .filter((row) => row.status === "uncompatible")
    .map((row) => `${row.id}: ${row.message}`);
  if (problems.length) return { status: "uncompatible", problems };
  if (!rows.length || rows.some((row) => row.status === "pending" || row.status === "checking"))
    return { status: "checking", problems: [] };
  return {
    status: rows.some((row) => row.status === "warning") ? "warning" : "compatible",
    problems: [],
  };
}

interface CheckContext {
  id: string;
  bytes: Uint8Array<ArrayBuffer>;
  available: ReadonlySet<string>;
  reference?: ResourceReference;
  signal?: AbortSignal;
}

async function checkMain({ bytes, available, signal }: CheckContext): Promise<CheckResult> {
  await validateMainRegistry(bytes, available, signal);
  return compatible("Startup registry structure and resource references are valid");
}
async function checkMr({ bytes, signal }: CheckContext): Promise<CheckResult> {
  await readMr(bytes, signal);
  return compatible(
    "MR container structure and decompression are valid; resource-specific contents are not checked yet",
  );
}
function checkTim({ bytes, reference }: CheckContext): CheckResult {
  try {
    validateTim(bytes, reference?.tim);
  } catch (error) {
    if (error instanceof TimLayoutMismatch) return warning(error.message);
    throw error;
  }
  return reference?.tim
    ? compatible("TIM dimensions, pixel mode and VRAM layout are supported; colors may differ")
    : warning("TIM is readable, but its expected rendering layout is not known");
}
function checkMusic({ bytes }: CheckContext): CheckResult {
  // Raw CD-DA: signed 16-bit stereo, four bytes per sample frame. The tune is unrestricted.
  return bytes.length && bytes.length % 4 === 0
    ? compatible("Readable CD audio; music content may differ")
    : warning("Invalid optional CD audio length");
}
async function checkKnownResource({
  bytes,
  reference,
  signal,
}: CheckContext): Promise<CheckResult> {
  // Until a format-specific validator exists, known supported content is evidence, not a requirement.
  if (reference && (await sha256(bytes)) === reference.sha256) {
    signal?.throwIfAborted();
    return compatible("Known supported resource");
  }
  return warning("No format-specific validator yet; compatibility of this resource is unverified");
}

function checkVideo({ bytes, signal }: CheckContext): CheckResult {
  validateVideo(bytes, signal);
  return compatible(
    "Readable STR sectors and frame headers; compressed video is not decoded by this check",
  );
}

async function checkExecutable({ bytes, reference }: CheckContext): Promise<CheckResult> {
  if (!reference) throw new Error("Main EXE reference is missing");
  await validateExecutable(bytes, reference);
  return compatible("PS-X EXE header and approximate size are supported; code may differ");
}

const rules = [
  { accepts: (id: string) => id === "/SCUS_945.60", check: checkExecutable },
  { accepts: (id: string) => id.endsWith(".STR"), check: checkVideo },
  { accepts: (id: string) => id === "/DATA/MAIN.MR", check: checkMain },
  { accepts: (id: string) => id.endsWith(".MR"), check: checkMr },
  { accepts: (id: string) => id.endsWith(".TIM"), check: checkTim },
  { accepts: (id: string) => id.startsWith("AUDIO/"), check: checkMusic },
];

export async function checkResource(context: CheckContext): Promise<CheckResult> {
  const { id, bytes, signal } = context;
  signal?.throwIfAborted();
  try {
    if (isRequiredResource(id) && !bytes.length) throw new Error("Empty resource");
    const rule = rules.find((rule) => rule.accepts(id));
    const result = await (rule?.check ?? checkKnownResource)(context);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return isRequiredResource(id) ? uncompatible(message) : warning(message);
  }
}

export function resourceRows(
  resources: ResourceCandidate[],
  reference: ResourceReference[],
): ResourceRow[] {
  const found = resourceMap(resources);
  const expected = new Map(reference.map((resource) => [resource.id, resource]));
  return [...new Set([...found.keys(), ...expected.keys()])].sort().map((id) => ({
    id,
    size: found.get(id)?.size,
    reference: expected.get(id),
    ...(found.has(id) ? { status: "pending" as const, message: "" } : absence(id)),
  }));
}

export async function checkResources(
  resources: ResourceCandidate[],
  rows: ResourceRow[],
  signal: AbortSignal,
  changed: (row: ResourceRow) => void,
) {
  const found = resourceMap(resources);
  const available = new Set(found.keys());
  const priority = (row: ResourceRow) =>
    row.id.startsWith("AUDIO/") || row.id.endsWith(".STR") ? 1 : 0;
  for (const row of [...rows].sort((a, b) => priority(a) - priority(b))) {
    if (row.status !== "pending") continue;
    signal.throwIfAborted();
    row.status = "checking";
    row.message = "";
    changed(row);
    try {
      const resource = found.get(row.id)!;
      if (!resource.read) throw new Error("Resource is not readable");
      const bytes = await resource.read(signal);
      Object.assign(
        row,
        await checkResource({ id: row.id, bytes, available, reference: row.reference, signal }),
      );
    } catch (error) {
      if (signal.aborted) {
        row.status = "pending";
        row.message = "";
        changed(row);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      Object.assign(row, isRequiredResource(row.id) ? uncompatible(message) : warning(message));
    }
    changed(row);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
