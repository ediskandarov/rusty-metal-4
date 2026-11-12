import { connectNetwork } from "@tm4/lightyear-client";

import { configureMatch } from "./protocol.ts";
export { connectNetwork };
declare global {
  var tm4Network: { connect: typeof connectNetwork; configure: typeof configureMatch };
}
globalThis.tm4Network = { connect: connectNetwork, configure: configureMatch };
