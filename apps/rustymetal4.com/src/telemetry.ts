export interface Measurement {
  name: string;
  kind: "counter" | "gauge";
  value: number;
  slot?: number;
  bucket?: string;
}
export interface HealthSnapshot {
  schema: 1;
  boot: string;
  uptimeSeconds: number;
  phase: string;
  measurements: Measurement[];
}
interface Dataset {
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
}
const key = (measurement: Measurement) =>
  `${measurement.name}/${measurement.slot ?? ""}/${measurement.bucket ?? ""}`;

export function parseHealth(value: unknown): HealthSnapshot {
  const snapshot = value as HealthSnapshot;
  if (
    !snapshot ||
    snapshot.schema !== 1 ||
    typeof snapshot.boot !== "string" ||
    typeof snapshot.phase !== "string" ||
    !Number.isFinite(snapshot.uptimeSeconds) ||
    snapshot.uptimeSeconds < 0 ||
    !Array.isArray(snapshot.measurements) ||
    snapshot.measurements.length > 200
  )
    throw new Error("Invalid application health snapshot");
  const keys = new Set<string>();
  for (const row of snapshot.measurements) {
    if (
      !row ||
      typeof row.name !== "string" ||
      !/^rustymetal4_[a-z0-9_]+$/.test(row.name) ||
      !["counter", "gauge"].includes(row.kind) ||
      !Number.isFinite(row.value) ||
      row.value < 0 ||
      (row.slot !== undefined && (!Number.isInteger(row.slot) || row.slot < 0 || row.slot > 7)) ||
      (row.bucket !== undefined && typeof row.bucket !== "string") ||
      keys.has(key(row))
    )
      throw new Error("Invalid application health measurement");
    keys.add(key(row));
  }
  return snapshot;
}

// Each point stores the current value, its counter increase, and the observed interval.
// A new process/collector starts a baseline instead of inventing a rate across a reset.
export function exportHealth(
  dataset: Dataset,
  index: string,
  vcpu: number,
  current: HealthSnapshot,
  previous?: HealthSnapshot,
): void {
  const interval =
    previous?.boot === current.boot ? current.uptimeSeconds - previous.uptimeSeconds : 0;
  const prior = new Map(previous?.measurements.map((row) => [key(row), row.value]));
  for (const row of current.measurements) {
    const baseline = prior.get(key(row)) ?? 0;
    const validInterval = row.kind === "counter" && interval > 0 && row.value >= baseline;
    dataset.writeDataPoint({
      indexes: [index],
      blobs: [
        row.name,
        row.kind,
        String(row.slot ?? ""),
        row.bucket ?? "",
        current.phase,
        current.boot,
        String(vcpu),
      ],
      doubles: [row.value, validInterval ? row.value - baseline : 0, validInterval ? interval : 0],
    });
  }
}
