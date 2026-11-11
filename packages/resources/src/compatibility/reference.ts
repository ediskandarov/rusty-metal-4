import disc from "../../../../config/disc.json";
import resources from "../../../../config/resources.json";
import type { ResourceReference } from "./resources.ts";

export const resourceReference: ResourceReference[] = [
  { id: "/SCUS_945.60", size: disc.executable.size, sha256: disc.executable.sha256 },
  ...resources.files,
];
