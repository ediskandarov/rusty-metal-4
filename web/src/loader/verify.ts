export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifyExecutable(bytes: Uint8Array<ArrayBuffer>, expected: string) {
  const actual = await sha256(bytes);
  if (actual !== expected)
    throw new Error(`Unsupported SCUS_945.60.\nExpected SHA-256: ${expected}\nReceived: ${actual}`);
  return actual;
}
