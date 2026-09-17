/**
 * The read tools, which are the part most people will ever use.
 *
 * What is asserted here is mostly about what a model is *told*: that an amount
 * never appears without its unit, that a spot price is never offered as the
 * price of an order, that a graduated curve says so instead of producing a
 * quote, and that "graduated" and "migrated" are reported as the two different
 * states they are.
 */

import { describe, expect, it } from "vitest";

import { callTool } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat } from "../support/context.js";
import { CREATOR, CURVE, NETWORK, TOKEN } from "../support/fake-port.js";

describe("arcnow_network", () => {
  it("says READ-ONLY first when it is read-only", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/mode\s+READ-ONLY/);
    expect(result.text).toMatch(/--allow-writes/);
  });

  it("says which address would sign when writes are on, and the ceiling", async () => {
    const { ctx } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "42" });
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/WRITES ENABLED/);
    expect(result.text).toContain("42 USDC");
  });

  it("states the 18-decimal native USDC and the 6-decimal ERC-20 view apart", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/USDC, 18 decimals/);
    expect(result.text).toMatch(/6 decimals/);
    expect(result.text).toMatch(/1e12/);
  });

  it("reports the real deployed addresses and the venues that exist", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text.toLowerCase()).toContain(NETWORK.contracts.launchpad.toLowerCase());
    expect(result.text).toMatch(/uniswapV4/);
    // Arc testnet has no escrow, v2 or v3 migrator, and says so rather than
    // printing a zero address.
    expect(result.text).toMatch(/escrowMigrator\s+not deployed on this chain/);
    expect(result.text).toMatch(/v2Migrator\s+not deployed on this chain/);
  });

  it("warns that a token's venue comes from its own curve", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/Ask the curve/);
  });
});

describe("arcnow_token", () => {
  it("reports a live curve with its progress and the price caveat", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.text).toContain("Example Token (EXAM)");
    expect(result.text).toMatch(/12000 USDC of 50000 USDC/);
    expect(result.text).toMatch(/24\.00%/);
    expect(result.text).toMatch(/marginal price of the next/);
    expect(result.text).toMatch(/Uniswap v4/);
  });

  it("resolves a token address to its curve", async () => {
    const { ctx } = ctxReadOnly({ notACurve: TOKEN });
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/resolved from\s+the token address you gave/);
  });

  it("separates graduated from migrated, and names the rescue", async () => {
    const { ctx } = ctxReadOnly({ state: { graduated: true, migrated: false } });
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.text).toMatch(/OVER, permanently/);
    expect(result.text).toMatch(/NOT CREATED YET/);
    expect(result.text).toMatch(/arcnow_migrate/);
  });

  it("reports a holder's balance and anything the curve owes them", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_token", { address: CURVE, holder: CREATOR }, ctx);
    expect(result.text).toMatch(/balance\s+4200 EXAM/);
    expect(result.text).toMatch(/curve owes\s+nothing/);
  });

  it("refuses an address that is neither a token nor a curve, in plain words", async () => {
    const { ctx } = ctxReadOnly({
      curveThrows: new Error("reverted"),
      tokenCurveThrows: new Error("reverted"),
    });
    const result = await callTool("arcnow_token",
      { address: "0xdead00000000000000000000000000000000dead" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not answer as an arcnow.io bonding curve/);
  });
});

describe("arcnow_quote_buy", () => {
  it("breaks the fee out, names who receives it, and shows the floors", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100" }, ctx);
    expect(result.text).toMatch(/trade fee\s+1 USDC/);
    expect(result.text).toMatch(/reaches the curve\s+99 USDC/);
    expect(result.text).toMatch(/tokens out\s+250000 EXAM/);
    expect(result.text).toMatch(/fee split/);
    expect(result.text).toMatch(/creator\s+0\.3 USDC/);
    expect(result.text).toMatch(/50 bps \(0\.5%\)\s+248750 EXAM/);
  });

  it("says where an absent referrer's share actually goes", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100" }, ctx);
    expect(result.text).toMatch(/no referrer given, so this goes to the platform/);
  });

  it("gives the average fill price, not just the spot price", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100" }, ctx);
    expect(result.text).toMatch(/average fill price/);
    expect(result.text).toMatch(/USDC per token/);
  });

  it("quotes the pool, not the curve, once the token has migrated", async () => {
    // Before the pin moved this was a refusal: the curve had stopped and there
    // was no router to reach the pool through. See graduated-tokens.test.ts.
    const { ctx, port } = ctxReadOnly({ state: { graduated: true, migrated: true } });
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/Uniswap v4 pool/);
    expect(port.calls.map((c) => c.what)).not.toContain("read:quoteBuy");
  });

  it("rejects a JSON number where a decimal string belongs", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: 100 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/quoteIn/);
  });
});

describe("arcnow_quote_sell", () => {
  it("shows gross, fee and net, and that no approval is needed", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_sell", { address: CURVE, tokensIn: "1000" }, ctx);
    expect(result.text).toMatch(/gross\s+98\.89 USDC/);
    expect(result.text).toMatch(/you receive\s+97\.9 USDC/);
    expect(result.text).toMatch(/no approval needed/);
  });
});

describe("arcnow_quote_launch", () => {
  it("separates the flat fee from the initial buy and its own trade fee", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" }, ctx);
    expect(result.text).toMatch(/total, exactly\s+27 USDC/);
    expect(result.text).toMatch(/launch fee\s+2 USDC/);
    expect(result.text).toMatch(/initial buy\s+25 USDC/);
    expect(result.text).toMatch(/of which fee\s+0\.25 USDC/);
  });

  it("says overpaying reverts, because the launchpad has no refund path", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" }, ctx);
    expect(result.text).toMatch(/Overpaying reverts/);
  });

  it("says plainly that nothing about the token can be changed afterwards", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" }, ctx);
    expect(flat(result.text)).toMatch(/irreversible/);
    expect(flat(result.text))
      .toMatch(/none of the parameters above can be changed afterwards/);
  });

  it("predicts addresses only when a creator is named", async () => {
    const { ctx } = ctxReadOnly();
    const without = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" }, ctx);
    expect(without.text).not.toMatch(/where it would land/);

    const with_ = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", creator: CREATOR }, ctx);
    expect(with_.text).toMatch(/where it would land/);
    expect(with_.text).toMatch(/current launch nonce/);
  });

  it("spends nothing: no write reaches the port", async () => {
    const { ctx, port } = ctxReadOnly();
    await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" }, ctx);
    expect(port.writes).toEqual([]);
  });
});

describe("arcnow_platform", () => {
  it("prints every share both as bps of the fee and as a percentage of a trade", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_platform", {}, ctx);
    expect(result.text).toMatch(/creator\s+3000 bps of the fee \(30% of the fee, 0\.3% of a trade\)/);
    expect(result.text).toMatch(/the RESIDUAL/);
    expect(result.text).toMatch(/arcnow\.io's own, the launch default/);
  });

  it("reports the default migrator as a venue, not just an address", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_platform", {}, ctx);
    expect(result.text).toMatch(/Uniswap v4/);
    expect(result.text).toMatch(/immutable/);
  });
});

describe("arcnow_list_tokens", () => {
  it("says how far back it looked and that it is not a complete index", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_list_tokens", { limit: 5 }, ctx);
    expect(result.text).toMatch(/what this scan covered/);
    expect(result.text).toMatch(/62226550–62270000/);
    expect(result.text).toMatch(/there is more history below this/);
  });
});
