/**
 * The options the SDK client is built from, out of a {@link ServerConfig}.
 *
 * Its own module, rather than three lines in `index.ts`, so the one thing that
 * decides which deployment the server talks to — the preset or the network
 * file, the endpoint override, the signer — is testable without starting a
 * process.
 *
 * @module
 */

import type { ArcNowClientOptions, NetworkConfig } from "@arcnow/sdk";

import type { ServerConfig } from "./config.js";

export function clientOptionsFor(
  config: ServerConfig,
): ArcNowClientOptions & { readonly network: NetworkConfig } {
  const rpcUrl = config.rpcUrlForClient();
  const account = config.account();
  return {
    // Already resolved by the SDK in loadConfig: the caps were checked against
    // this same list of quote tokens, so the client must not resolve another.
    network: config.networkConfig,
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    ...(account === undefined ? {} : { account }),
  };
}
