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

test("room results require an explicit mode and choose presentation from it", async () => {
  const { roomResultSchema } = await import("@tm4/rooms-client/schemas");
  const { matchResultPresentation } =
    await import("../../apps/rustymetal4.com/src/match-results.ts");
  const common = {
    matchId: result.sessionId,
    completion: { tick: 600, reasons: 2, winners: 1 },
    participants: [
      {
        memberId: "e9898e1f-2946-45b5-a210-4bba96b22986",
        name: "Host",
        identity: { participant: "0000000000000001", slot: 0 },
        score: { frags: 20, deaths: 1 },
        winner: true,
      },
    ],
  };
  expect(roomResultSchema.safeParse(common).success).toBe(false);
  expect(roomResultSchema.safeParse({ ...common, modeId: "unknown" }).success).toBe(false);
  const ffa = roomResultSchema.parse({ ...common, modeId: "ffa" });
  expect(matchResultPresentation(ffa).summary).toBe("Frag limit reached · Winner: Host");
  const tournament = roomResultSchema.parse({
    ...common,
    modeId: "tournament",
    completion: { ...common.completion, reasons: 4 },
  });
  expect(matchResultPresentation(tournament).summary).toBe("Tournament won · Team: Host");
  expect(matchResultPresentation(tournament).rows[0]?.outcome).toBe("Victory");
});
