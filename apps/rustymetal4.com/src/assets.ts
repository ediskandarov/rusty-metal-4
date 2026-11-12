export function isolated(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  copy.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  copy.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  copy.headers.set("X-Content-Type-Options", "nosniff");
  return copy;
}
export async function frontend(
  assets: { fetch(request: Request): Promise<Response> },
  request: Request,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return isolated(new Response(null, { status: 405 }));
  return isolated(await assets.fetch(request));
}
