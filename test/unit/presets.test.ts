/**
 * Both presets, end to end through the tools.
 *
 * `ARCNOW_MCP_NETWORK=arc-mainnet` is the live network, where every write is
 * real money; `arc-testnet` is the rehearsal. Both come from the SDK's
 * `resolveNetwork`, the only source of an address here, and everything
 * downstream — the spend caps, the reports, the instructions, the template a
 * new platform gets — follows the network the configuration resolved. What is
 * asserted is that the mainnet server reads mainnet's addresses, caps mainnet's
 * EURC by its mainnet address, says out loud that it is mainnet, and never
 * mentions testnet's addresses; and that the testnet server is the mirror image.
 */

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { CurveTemplate, resolveNetwork } from "@arcnow/sdk";

import { loadConfig } from "../../src/config.js";
import { instructionsFor } from "../../src/server.js";
import { callTool } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/schema.js";
import { flat, TEST_KEY } from "../support/context.js";
import { CURVE, FakePort, type FakeScript, PAYEE, TOKEN } from "../support/fake-port.js";

const MAINNET = resolveNetwork("arc-mainnet");
const TESTNET = resolveNetwork("arc-testnet");
const MAINNET_EURC = MAINNET.quoteTokens.find((q) => q.symbol === "EURC")!;
const TESTNET_EURC = TESTNET.quoteTokens.find((q) => q.symbol === "EURC")!;

/** A writing server on a preset, with the fake chain built on that preset's network. */
function serverOn(
  network: "arc-mainnet" | "arc-testnet",
  env: Record<string, string> = {},
  script: FakeScript = {},
): { ctx: ToolContext; port: FakePort } {
  const config = loadConfig(
    { ARCNOW_MCP_NETWORK: network, ARCNOW_PRIVATE_KEY: TEST_KEY, ...env }, ["--allow-writes"]);
  const port = new FakePort(script, { config: config.networkConfig });
  return { ctx: { port, config }, port };
}

const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "1000", deadlineMinutes: 5, ...over,
});

describe("ARCNOW_MCP_NETWORK=arc-mainnet, end to end", () => {
  it("arcnow_network reports mainnet: chain 5042, the live launchpad and platform, mainnet's EURC", async () => {
    const { ctx } = serverOn("arc-mainnet", { ARCNOW_MCP_MAX_SPEND_EURC: "50" });
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/network\s+arc-mainnet/);
    expect(result.text).toMatch(/chain id\s+5042$/m);
    expect(result.text).toContain(getAddress(MAINNET.contracts.launchpad));
    expect(result.text).toContain(getAddress(MAINNET.contracts.arcnowPlatform));
    expect(result.text).toContain(getAddress(MAINNET_EURC.address));
    expect(result.text).toMatch(/first block\s+21179866/);
    expect(result.text).toMatch(/Spend cap: 50 EURC per write call/);
    expect(result.text).toMatch(/Spend cap: 100 USDC per write call/);
    // Nothing of testnet's leaks into a mainnet report.
    expect(result.text.toLowerCase()).not.toContain(TESTNET.contracts.launchpad.toLowerCase());
    expect(result.text.toLowerCase()).not.toContain(TESTNET_EURC.address.toLowerCase());
    expect(result.text).not.toMatch(/5042002/);
  });

  it("caps a mainnet EURC buy by its mainnet address: over the cap is refused with nothing sent, under it goes out", async () => {
    const { ctx, port } = serverOn("arc-mainnet", { ARCNOW_MCP_MAX_SPEND_EURC: "50" }, { quote: MAINNET_EURC });
    const refused = await callTool("arcnow_buy", buyArgs({ quoteIn: "50.000001" }), ctx);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/operator capped any single write in EURC at 50 EURC/);
    expect(port.writes).toEqual([]);

    const bought = await callTool("arcnow_buy", buyArgs({ quoteIn: "50" }), ctx);
    expect(bought.isError, bought.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve", "write:buy"]);
    expect(port.writes[0]?.args).toMatchObject({ token: MAINNET_EURC.address, amount: "50" });
  });

  it("refuses a mainnet EURC spend with no EURC cap, naming the variable, and testnet's EURC address is no quote here", async () => {
    const { ctx, port } = serverOn("arc-mainnet", {}, { quote: MAINNET_EURC });
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/ARCNOW_MCP_MAX_SPEND_EURC/);
    expect(port.writes).toEqual([]);
    // A curve priced in testnet's EURC is, on mainnet, priced in a quote the network does not list.
    const { ctx: foreign, port: foreignPort } = serverOn("arc-mainnet",
      { ARCNOW_MCP_MAX_SPEND_EURC: "50" }, { quote: TESTNET_EURC });
    const refused = await callTool("arcnow_buy", buyArgs(), foreign);
    expect(refused.isError).toBe(true);
    expect(foreignPort.writes).toEqual([]);
  });

  it("arcnow_quote_tokens lists mainnet's EURC with its cap and a free launch", async () => {
    const { ctx } = serverOn("arc-mainnet", { ARCNOW_MCP_MAX_SPEND_EURC: "50" });
    const result = await callTool("arcnow_quote_tokens", {}, ctx);
    expect(result.text).toMatch(/^EURC — EURC/m);
    expect(result.text).toContain(getAddress(MAINNET_EURC.address));
    expect(result.text).toMatch(/spend cap\s+50 EURC per write call/);
    expect(result.text).toMatch(/launch fee\s+0 USDC launch fee — launching is free/);
  });

  it("the instructions say THIS IS ARC MAINNET and real money, and never offer testnet's addresses", () => {
    const text = flat(instructionsFor(serverOn("arc-mainnet").ctx.config));
    expect(text).toMatch(/arcnow\.io on Arc \(arc-mainnet\)/);
    expect(text).toMatch(/THIS IS ARC MAINNET\. Every amount here is real money/);
    expect(text).not.toMatch(/There is no arcnow\.io mainnet/);
  });

  it("arcnow_register_platform seeds the new platform with the reference template mainnet's own platform serves", async () => {
    const { ctx, port } = serverOn("arc-mainnet");
    const result = await callTool("arcnow_register_platform", {
      admin: TOKEN, feeRecipient: PAYEE, defaultMigrator: MAINNET.contracts.v4Migrator,
    }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    const reference = CurveTemplate.reference();
    expect(reference.totalSupply.toString()).toBe("1000000000");
    expect(reference.target.format()).toBe("50000 USDC");
    expect(port.writes[0]?.args).toMatchObject({
      template: { totalSupply: "1000000000", target: "50000" },
    });
    expect(result.text).toMatch(/curve template\s+the template arcnow\.io's own platform serves on arc-mainnet: 1000000000 supply/);
    expect(flat(result.text)).toMatch(/graduating at 50000 USDC/);
  });
});

describe("ARCNOW_MCP_NETWORK=arc-testnet, the rehearsal", () => {
  it("arcnow_network reports testnet: chain 5042002, the fee-model launchpad, testnet's EURC", async () => {
    const { ctx } = serverOn("arc-testnet", { ARCNOW_MCP_MAX_SPEND_EURC: "50" });
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/network\s+arc-testnet/);
    expect(result.text).toMatch(/chain id\s+5042002/);
    expect(result.text).toContain(getAddress(TESTNET.contracts.launchpad));
    expect(result.text).toContain(getAddress(TESTNET_EURC.address));
    expect(result.text).toMatch(/first block\s+62386232/);
    expect(result.text.toLowerCase()).not.toContain(MAINNET.contracts.launchpad.toLowerCase());
    expect(result.text.toLowerCase()).not.toContain(MAINNET_EURC.address.toLowerCase());
  });

  it("the instructions say it is the rehearsal, and name arc-mainnet as the live network", () => {
    const text = flat(instructionsFor(serverOn("arc-testnet").ctx.config));
    expect(text).toMatch(/This is ARC TESTNET, the rehearsal network/);
    expect(text).toMatch(/The live network is arc-mainnet/);
    expect(text).not.toMatch(/THIS IS ARC MAINNET/);
  });

  it("arcnow_register_platform seeds the new platform with the testnet template testnet's own platform serves", async () => {
    const { ctx, port } = serverOn("arc-testnet");
    const result = await callTool("arcnow_register_platform", {
      admin: TOKEN, feeRecipient: PAYEE, defaultMigrator: TESTNET.contracts.v4Migrator,
    }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes[0]?.args).toMatchObject({ template: { totalSupply: "1000000", target: "50" } });
    expect(result.text).toMatch(/serves on arc-testnet: 1000000 supply/);
  });
});
