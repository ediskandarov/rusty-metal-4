import { measurementKey as key } from "@tm4/rustymetal-server-client/schemas";
import type { HealthSnapshot } from "@tm4/rustymetal-server-client/schemas";
interface Dataset {
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
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
