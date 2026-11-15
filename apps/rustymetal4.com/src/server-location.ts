import type { ServerLocation } from "@tm4/rustymetal-server-client/schemas";
const regions: Record<string, string> = {
  AFR: "Africa",
  APAC: "Asia Pacific",
  EEUR: "Eastern Europe",
  ENAM: "Eastern North America",
  WNAM: "Western North America",
  ME: "Middle East",
  OC: "Oceania",
  SAM: "South America",
  WEUR: "Western Europe",
};
const countries = new Intl.DisplayNames(["en"], { type: "region" });
export function serverLocationLabel(location: ServerLocation | null): string {
  if (!location) return "Unknown";
  return (
    [
      location.region ? (regions[location.region] ?? location.region) : null,
      location.country ? countries.of(location.country) : null,
      location.location,
    ]
      .filter(Boolean)
      .join(" · ") || "Unknown"
  );
}
