/**
 * The MCP surface: a thin wrapper over {@link listTools} and {@link callTool}.
 *
 * Everything that decides anything lives in `tools/`, which is why this file is
 * short and why the test suite never has to stand up a transport to prove a
 * property of the server.
 *
 * @module
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ServerConfig } from "./config.js";
import { capsSummary } from "./tools/spend.js";
import type { ArcNowPort } from "./sdk-port.js";
import { callTool, listTools } from "./tools/index.js";
import type { ToolContext } from "./tools/schema.js";

export const SERVER_NAME = "arcnow-io";
export const SERVER_VERSION = "0.1.0";

/**
 * What the model is told before it sees a single tool.
 *
 * Three things, because these are the three that produce expensive mistakes:
 * the mode, so it never offers to do something this server cannot; the decimal
 * trap, so it never quotes a price out by a factor of a trillion; and the key
 * rule, so it never asks a user to paste one into a chat.
 */
export function instructionsFor(config: ServerConfig): string {
  const mode = config.canWrite
    ? "This server HAS WRITES ENABLED. It can launch tokens, buy, sell and migrate, signing "
    + `as ${config.signerAddress ?? "an address it was configured with"}. Its operator capped `
    + `any single write per quote token: ${capsSummary(config)}. A quote with no cap is refused `
    + "for every launch and buy — do not offer one in it. Quote before you act, show the "
    + "user the cost, and get their agreement — especially for a launch, which is "
    + "irreversible in every respect: name, symbol, supply, curve and graduation venue are "
    + "fixed at the launch transaction and no contract anywhere can change them afterwards."
    : "This server is READ-ONLY. It cannot sign, spend, launch or trade, and the write tools "
      + "are not published. Do not offer to buy, sell or launch anything. Enabling writes is "
      + "the operator's decision, made by restarting the server — it is not something that "
      + "can be granted during a conversation.";

  return [
    `arcnow.io on Arc (${config.network}) — bonding-curve token launches, trading and `
    + "graduation, read straight from the contracts.",
    "",
    mode,
    "",
    "NEVER ask anyone for a private key, and never put one in a tool argument. No tool here "
    + "takes one, and an argument named like a credential is refused rather than ignored. A "
    + "tool call is written into a transcript; a key that has been through a transcript has "
    + "been published and must be rotated. Signing is configured in the server's environment "
    + "by whoever starts it.",
    "",
    "MONEY ON THIS CHAIN. Every token is priced for life in ONE quote token, fixed at its "
    + "launch: native USDC — the gas currency, 18 decimals, paid as msg.value — or an allowlisted "
    + "ERC-20 such as EURC (6 decimals), pulled with an exact ERC-20 approval. arcnow_token names "
    + "a token's quote; arcnow_quote_tokens lists the ones a launch may use. Every amount a tool "
    + "takes or reports is in that token's own quote, and is labelled with its symbol: never "
    + "read a EURC figure as dollars, and never add amounts of two quotes together. Amounts cross "
    + "these tools as decimal strings in whole units (\"25\", \"1.5\") with no more decimals than "
    + "the quote has — never as JSON numbers, which cannot hold 18 decimals. Gas is always native "
    + "USDC. The USDC ERC-20 predeploy is native USDC's 6-decimal view, pays for nothing, and is "
    + "not a quote token.",
    "",
    "PRICES. A curve's spot price is the marginal price of the next infinitesimal token, not "
    + "what an order fills at — the curve integrates price across an order. Answer \"what "
    + "would 50 EURC get me\" with arcnow_quote_buy, never by multiplying.",
    "",
    "GRADUATION. A curve retires permanently once it collects its target, and the buy that "
    + "fills it migrates the curve into a Uniswap v4 pool in that same transaction. From then "
    + "on the token trades in that pool, through arcnow.io's router, and the quote and trade "
    + "tools route there on their own — every pool quote says it is one, and names its two "
    + "charges apart: arcnow.io's fee hook's 0.80% and the pool's own 0.20% LP fee, 1.00% in all, "
    + "the same as the curve's flat 1%. Where a token graduates to is snapshotted into its "
    + "own curve at launch: ask the curve, not a network-wide list. A token can be graduated "
    + "and NOT migrated — trading over, no market anywhere — until somebody runs the "
    + "permissionless migrate().",
    "",
    "SELLING IN A POOL needs an ERC-20 approval to the router first: a separate transaction "
    + "granting it spending rights. arcnow_sell grants one only when told to (approveRouter: "
    + "true), only for exactly the amount being sold, and reports it. Tell the user about the "
    + "approval before you set that flag.",
    "",
    "FEES. On a curve the trade fee is a flat 1%, split FOUR ways — creator, platform, "
    + "referrer, protocol; there is no developer share, and no tool takes a developer. A "
    + "referrer is a curve-only argument; a pool swap has none. Launching is free on "
    + "arcnow.io's networks: the launch fee the quote registry reports is zero, and the tools "
    + "print what it reports rather than assuming.",
    "",
    networkNote(config),
  ].join("\n");
}

/**
 * Which network this is, said so that a model never substitutes the other one.
 * arcnow.io is live on Arc mainnet (`arc-mainnet`, chain 5042) and on Arc
 * testnet (`arc-testnet`, chain 5042002); the two run the same contracts at
 * different addresses, and a token address from one means nothing on the other.
 */
function networkNote(config: ServerConfig): string {
  switch (config.network) {
    case "arc-mainnet":
      return "THIS IS ARC MAINNET. Every amount here is real money and every write spends it. "
        + "Nothing on Arc testnet — no token, no curve, no address — exists here; do not carry "
        + "one over. If someone wants to rehearse, the operator runs a second server with "
        + "ARCNOW_MCP_NETWORK=arc-testnet.";
    case "arc-testnet":
      return "This is ARC TESTNET, the rehearsal network: the same contracts as arcnow.io on Arc "
        + "mainnet, at other addresses, with test funds. Nothing bought, sold or launched here "
        + "exists on mainnet, and no mainnet token or address can be reached from here. The live "
        + "network is arc-mainnet, which the operator selects with ARCNOW_MCP_NETWORK.";
    default:
      return `This server is pointed at ${config.network}, a deployment its operator described `
        + "rather than an arcnow.io preset. Nothing here says which of Arc mainnet or Arc testnet "
        + "it is, or whether it is either; do not assume, and do not carry an address over from "
        + "another network.";
  }
}

export function createServer(port: ArcNowPort, config: ServerConfig): Server {
  const ctx: ToolContext = { port, config };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: instructionsFor(config) },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listTools(config).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(request.params.name, request.params.arguments, ctx);
    return {
      content: [{ type: "text" as const, text: result.text }],
      ...(result.isError === true ? { isError: true } : {}),
    };
  });

  return server;
}
