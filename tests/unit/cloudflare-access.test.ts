import { expect, test } from "bun:test";

import { hasSession, sameSecret, sessionCookie } from "../../apps/cloudflare/src/access.ts";

const secret = "test-only-access-code-not-a-deployed-secret";
const now = Date.UTC(2026, 10, 12);
const request = (cookie: string) =>
  new Request("https://test.example/", { headers: { Cookie: cookie } });

test("the test gate accepts signed unexpired cookies only", async () => {
  const cookie = await sessionCookie(secret, now);
  expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict; Path=/");
  expect(await hasSession(request(cookie), secret, now + 1000)).toBe(true);
  expect(await hasSession(request(cookie), "other-secret", now)).toBe(false);
  expect(await hasSession(request(cookie), secret, now + 12 * 3600 * 1000)).toBe(false);
  expect(await hasSession(request(cookie.replace(/\d+\./, "9999999999.")), secret, now)).toBe(
    false,
  );
  expect(await hasSession(request("__Host-tm4-test=broken"), secret, now)).toBe(false);
  expect(await hasSession(request(""), secret, now)).toBe(false);
});

test("access codes require an exact match", async () => {
  expect(await sameSecret(secret, secret)).toBe(true);
  expect(await sameSecret(secret + "x", secret)).toBe(false);
  expect(await sameSecret("", secret)).toBe(false);
});
