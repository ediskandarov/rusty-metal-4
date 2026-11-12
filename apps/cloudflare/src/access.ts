const cookieName = "__Host-tm4-test";
const encoder = new TextEncoder();
const sessionSeconds = 12 * 60 * 60;

async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sameSecret(actual: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [actual, expected].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  const right = new Uint8Array(b!);
  return (
    new Uint8Array(a!).reduce((difference, byte, i) => difference | (byte ^ right[i]!), 0) === 0
  );
}

export async function sessionCookie(secret: string, now = Date.now()): Promise<string> {
  const expires = String(Math.floor(now / 1000) + sessionSeconds);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(expires)),
  );
  const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${cookieName}=${expires}.${hex}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionSeconds}`;
}

export async function hasSession(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const match = /^(\d{10})\.([a-f0-9]{64})$/.exec(value ?? "");
  if (!match || Number(match[1]) <= now / 1000 || Number(match[1]) > now / 1000 + sessionSeconds)
    return false;
  const signature = Uint8Array.from(match[2]!.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", await key(secret), signature, encoder.encode(match[1]));
}

export function accessPage(message = "Enter the test access code.", status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rusty Metal 4 test server</title><style>body{background:#111820;color:#eee;font:18px system-ui;max-width:30rem;margin:12vh auto;padding:1rem}input,button{font:inherit;padding:.7rem;margin:.6rem 0;width:100%;box-sizing:border-box}button{cursor:pointer}</style><h1>Rusty Metal 4</h1><p>${message}</p><form method="post" action="/_access"><label>Access code<input name="code" type="password" required autocomplete="current-password" maxlength="256"></label><button>Open server</button></form></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
