import { expect, test } from "bun:test";

import { authoritativeResultSchema } from "@tm4/rustymetal-server-client/schemas";

const result = {
  sessionId: "c24baad1-69d9-4cc8-b74c-e56de97502e4",
  completion: { tick: 15, reasons: 1, winners: 132 },
  participants: [
    {
      identity: { participant: "0000000000000008", slot: 7 },
      credential: "a".repeat(64),
      score: { frags: 4, deaths: 9 },
    },
    {
      identity: { participant: "0000000000000009", slot: 2 },
      credential: "b".repeat(64),
      score: { frags: 4, deaths: 1 },
    },
  ],
};
test("private final results validate authoritative sparse participants and all tied winners", () => {
  expect(authoritativeResultSchema.parse(result)).toEqual(result);
  for (const invalid of [
    { ...result, completion: { ...result.completion, reasons: 0 } },
    { ...result, completion: { ...result.completion, winners: 128 } },
    { ...result, completion: { ...result.completion, winners: 133 } },
    { ...result, participants: [result.participants[0], result.participants[0]] },
    {
      ...result,
      participants: [
        result.participants[0],
        { ...result.participants[1], credential: "a".repeat(64) },
      ],
    },
  ])
    expect(authoritativeResultSchema.safeParse(invalid).success).toBe(false);
  expect(
    authoritativeResultSchema.safeParse({
      ...result,
      completion: { ...result.completion, winners: 0 },
      participants: [],
    }).success,
  ).toBe(true);
});
