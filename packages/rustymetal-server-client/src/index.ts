import {
  authoritativeResultSchema,
  healthSnapshotSchema,
  type MembershipLookup,
  membershipLookupSchema,
  type MembershipOptions,
  membershipOptionsSchema,
  membershipReplySchema,
  resourceIdSchema,
  resourceManifestSchema,
  serverStatusSchema,
  type StartOptions,
  startOptionsSchema,
} from "./schemas.ts";
export type Fetch = (request: Request) => Promise<Response>;
export interface ClientOptions {
  baseURL: string | URL;
  fetch?: Fetch;
  headers?: () => Record<string, string>;
}
export class ServerApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerApiError";
  }
}
function requests(options: ClientOptions) {
  const base = new URL(options.baseURL);
  base.pathname = base.pathname.replace(/\/?$/, "/");
  return async (path: string, init: RequestInit = {}) => {
    const request = new Request(new URL(path, base).href, { ...init, cache: "no-store" });
    for (const [key, value] of Object.entries(options.headers?.() ?? {}))
      if (!request.headers.has(key)) request.headers.set(key, value);
    const response = await (options.fetch ?? fetch)(request);
    if (!response.ok)
      throw new ServerApiError(
        response.status,
        (await response.text()) || "Server API: HTTP " + response.status,
      );
    return response;
  };
}
export function createResourceClient(options: ClientOptions) {
  const request = requests(options);
  return {
    async resources(signal?: AbortSignal) {
      return resourceManifestSchema.parse(await (await request("resources", { signal })).json());
    },
    async upload(id: string, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
      const response = await request("resources" + resourceIdSchema.parse(id), {
        method: "PUT",
        body: bytes,
        signal,
      });
      await response.body?.cancel();
    },
    async prepare(signal?: AbortSignal) {
      const response = await request("prepare", { method: "POST", signal });
      await response.body?.cancel();
    },
  };
}
export function createServerClient(options: ClientOptions) {
  const request = requests(options);
  return {
    ...createResourceClient(options),
    async results(signal?: AbortSignal) {
      return authoritativeResultSchema.parse(await (await request("results", { signal })).json());
    },
    async status(signal?: AbortSignal) {
      return serverStatusSchema.parse(await (await request("status", { signal })).json());
    },
    async start(input: StartOptions, signal?: AbortSignal) {
      const response = await request("start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startOptionsSchema.parse(input)),
        signal,
      });
      await response.body?.cancel();
    },
    async membership(input: MembershipOptions, signal?: AbortSignal) {
      const response = await request("membership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(membershipOptionsSchema.parse(input)),
        signal,
      });
      return membershipReplySchema.parse(await response.json());
    },
    async membershipStatus(input: MembershipLookup, signal?: AbortSignal) {
      const response = await request("membership/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(membershipLookupSchema.parse(input)),
        signal,
      });
      return membershipReplySchema.parse(await response.json());
    },
    async health(signal?: AbortSignal) {
      return healthSnapshotSchema.parse(await (await request("metrics", { signal })).json());
    },
    async systemMetrics(signal?: AbortSignal) {
      return (await request("system-metrics", { signal })).text();
    },
    async journal(signal?: AbortSignal) {
      return request("journal", { signal });
    },
  };
}
