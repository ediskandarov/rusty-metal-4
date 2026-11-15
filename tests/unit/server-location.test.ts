import { expect, test } from "bun:test";

import { serverStatusSchema } from "@tm4/rustymetal-server-client/schemas";

import { serverLocationLabel } from "../../apps/rustymetal4.com/src/server-location.ts";

test("server location labels preserve partial and unknown provider locations", () => {
  expect(serverLocationLabel(null)).toBe("Unknown");
  expect(serverLocationLabel({ region: "WEUR", country: "DE", location: "FRA" })).toBe(
    "Western Europe · Germany · FRA",
  );
  expect(serverLocationLabel({ region: null, country: "US", location: null })).toBe(
    "United States",
  );
  expect(serverLocationLabel({ region: "NEW", country: null, location: "site-42" })).toBe(
    "NEW · site-42",
  );
  expect(serverLocationLabel({ region: null, country: null, location: null })).toBe("Unknown");
});

test("status accepts unavailable location during deployment and validates reported fields", () => {
  const schema = serverStatusSchema.pick({ location: true });
  expect(schema.parse({})).toEqual({ location: null });
  expect(schema.parse({ location: null })).toEqual({ location: null });
  const location = { region: "WEUR", country: "DE", location: "FRA" };
  expect(schema.parse({ location })).toEqual({ location });
  expect(() => schema.parse({ location: { ...location, country: 42 } })).toThrow();
});
