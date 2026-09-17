#!/usr/bin/env node
/**
 * The entry point: read the configuration, say what mode it produced, connect.
 *
 * # stdout belongs to the protocol
 *
 * An MCP stdio server speaks JSON-RPC over stdout. One stray byte there — a
 * `console.log`, a library's banner, a warning — corrupts a frame and the
 * client's connection with it. So **everything** this process says to a human
 * goes to stderr, and the rule holds for the whole codebase: there is no
 * `console.log` anywhere in `src/`, and the tools return text to the client
 * rather than printing it.
 *
 * @module
 */

import { createArcNowClient } from "@arcnow/sdk";

import { clientOptionsFor } from "./client-options.js";
import { ConfigError, loadConfig, startupBanner } from "./config.js";
import { createSdkPort } from "./sdk-port.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv.slice(2));
  process.stderr.write(`${startupBanner(config)}\n`);

  const client = createArcNowClient(clientOptionsFor(config));

  // Asked once, up front, and reported rather than fatal: an endpoint that is
  // briefly unreachable should not stop the server from starting, but a client
  // pointed at the wrong chain should find out now and not from a transaction.
  try {
    await client.verifyChain();
  } catch (error) {
    process.stderr.write(
      `  warning     the endpoint could not be verified as chain ${config.network}: `
      + `${error instanceof Error ? error.message : String(error)}\n`
      + "              Tools will report this again when they are called.\n",
    );
  }

  const port = createSdkPort(client, config.logScan);
  const server = createServer(port, config);

  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js",
  );
  await server.connect(new StdioServerTransport());
  process.stderr.write("  ready       listening on stdio\n");
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`arcnow.io MCP server cannot start.\n\n${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `arcnow.io MCP server failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
