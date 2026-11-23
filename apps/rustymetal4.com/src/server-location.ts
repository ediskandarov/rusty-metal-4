import { roomRegionLabels, roomRegionSchema } from "@tm4/rooms-client/schemas";
import type { ServerLocation } from "@tm4/rustymetal-server-client/schemas";
const countries = new Intl.DisplayNames(["en"], { type: "region" });
export function serverLocationLabel(location: ServerLocation | null): string {
  if (!location) return "Unknown";
  const region = roomRegionSchema.safeParse(location.region?.toLowerCase());
  return (
    [
      region.success ? roomRegionLabels[region.data] : location.region,
      location.country ? countries.of(location.country) : null,
      location.location,
    ]
      .filter(Boolean)
      .join(" · ") || "Unknown"
  );
}
