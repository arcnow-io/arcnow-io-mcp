/**
 * Building a {@link ToolContext} for a test.
 *
 * The key below is `0x11…11`. It is a syntactically valid secp256k1 key and
 * obviously not anybody's: the point of using it rather than a well-known
 * testing key is that a grep for a famous key across this repository should
 * find nothing, and a grep for a real one should find nothing either.
 *
 * The fake port is built on the network the configuration resolved, so a test
 * that points the server at a network file (`withNetworkFile`) gets a chain with
 * that file's quote tokens, and the spend caps resolve against the same list.
 */

import type { QuoteTokenInfo } from "@arcnow/sdk";

import { loadConfig, type ServerConfig } from "../../src/config.js";
import type { ToolContext } from "../../src/tools/schema.js";
import { FakePort, type FakeScript, NETWORK } from "./fake-port.js";

export const TEST_KEY = `0x${"11".repeat(32)}`;

/** Where a test's network file claims to live. Never read from disk. */
export const NETWORK_FILE_PATH = "/networks/fork.json";

/** A file reader that knows one network file and refuses every other path. */
export type ReadFile = (path: string) => string;

export function readOnlyConfig(
  env: Record<string, string | undefined> = {},
  argv: string[] = [],
  readFile?: ReadFile,
): ServerConfig {
  return loadConfig(env, argv, readFile);
}

export function writeConfig(
  env: Record<string, string | undefined> = {},
  argv: string[] = ["--allow-writes"],
  readFile?: ReadFile,
): ServerConfig {
  return loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY, ...env }, argv, readFile);
}

export function ctxWithWrites(
  script: FakeScript = {},
  env: Record<string, string> = {},
  readFile?: ReadFile,
): { ctx: ToolContext; port: FakePort } {
  const config = writeConfig(env, ["--allow-writes"], readFile);
  const port = new FakePort(script, { config: config.networkConfig });
  return { ctx: { port, config }, port };
}

export function ctxReadOnly(
  script: FakeScript = {},
  env: Record<string, string> = {},
  readFile?: ReadFile,
): { ctx: ToolContext; port: FakePort } {
  const config = readOnlyConfig(env, [], readFile);
  const port = new FakePort(script, {
    canWrite: false, signerAddress: undefined, config: config.networkConfig,
  });
  return { ctx: { port, config }, port };
}

/**
 * A `CustomNetwork` document: Arc testnet's addresses with `quoteTokens`
 * replaced, as `ARCNOW_MCP_NETWORK_FILE` would hold it.
 */
export function networkDocument(
  quoteTokens: readonly QuoteTokenInfo[] = NETWORK.quoteTokens,
): string {
  const contracts = Object.fromEntries(
    Object.entries(NETWORK.contracts).filter(([, value]) => value !== undefined));
  return JSON.stringify({
    name: "fork-under-test",
    rpcUrl: "http://127.0.0.1:8545",
    chainId: NETWORK.chainId,
    contracts,
    venues: NETWORK.venues,
    v4: NETWORK.v4,
    quoteTokens,
    quoteAllowanceSlots: { [quoteTokens.find((q) => !q.isNative)?.address ?? "0x"]: 10 },
  });
}

/** The env and reader that point a config at {@link networkDocument}. */
export function withNetworkFile(
  quoteTokens: readonly QuoteTokenInfo[] = NETWORK.quoteTokens,
  env: Record<string, string> = {},
): { env: Record<string, string>; readFile: ReadFile } {
  const document = networkDocument(quoteTokens);
  return {
    env: { ARCNOW_MCP_NETWORK_FILE: NETWORK_FILE_PATH, ...env },
    readFile: (path) => {
      if (path !== NETWORK_FILE_PATH) throw new Error(`ENOENT: ${path}`);
      return document;
    },
  };
}

/**
 * Collapse the report's line wrapping before matching prose.
 *
 * The tools hard-wrap their explanatory paragraphs so that a person reading a
 * transcript gets something readable. That makes a regex over a sentence
 * fragile for reasons that have nothing to do with what is being asserted, so
 * prose assertions go through this and figures are matched against the raw
 * text, where the column alignment is part of what is being checked.
 */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}
