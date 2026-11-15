import type { Compatibility } from "@tm4/rooms-client/schemas";
export function sameCompatibility(a: Compatibility | null, b: Compatibility | null): boolean {
  return !!a && !!b && a.protocol === b.protocol && a.build === b.build && a.content === b.content;
}
