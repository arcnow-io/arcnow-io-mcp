/**
 * An ERC-20 trade or launch that ran out of gas inside a fee-share transfer.
 *
 * arcnow.io's contracts push every ERC-20 fee share through a gas guard
 * (contracts#23, `QuoteTransfer.tryPushBounded`) that reverts with NO DATA when
 * too little gas is left for it. The SDK turns that empty revert into
 * `QuoteTransferOutOfGas`. What a model is told must be exactly that — a gas
 * limit too tight, named, with what to do — and never an unknown or empty
 * revert, and never a "refusal" as if nothing had been attempted.
 *
 * And the server never makes it happen: it adds no gas limit of its own to a
 * trade that does not graduate, so the SDK's own headroom (the node's estimate
 * plus a fifth, at least 150,000) is what goes out.
 */

import { describe, expect, it } from "vitest";
import { ArcNowError } from "@arcnow/sdk";

import { callTool, renderError } from "../../src/tools/index.js";
import { ctxWithWrites, flat } from "../support/context.js";
import { CURVE, EURC, TOKEN } from "../support/fake-port.js";

const outOfGas = (gasLimit?: bigint) => new ArcNowError({
  code: "QuoteTransferOutOfGas",
  message: "the call reverted with no data (calling buyWithQuote), on a path that pays EURC fee "
    + "shares. Leave gasLimit unset and the SDK sends the node's estimate plus a fifth, or raise it.",
  data: "0x",
  details: { quoteToken: EURC.address, gasLimit },
});
const EURC_CAP = { ARCNOW_MCP_MAX_SPEND_EURC: "1000" };
const MIGRATED = { graduated: true, migrated: true } as const;

/** What every one of these reports must say. */
function expectNamedOutOfGas(tool: string, text: string): void {
  expect(text).toMatch(new RegExp(`^${tool}(: the launch in EURC did not go through\\.\\n\\n${tool})? failed on-chain: QuoteTransferOutOfGas`));
  expect(flat(text)).toMatch(/ran out of gas paying an ERC-20 fee share/);
  expect(flat(text)).toMatch(/leave the gas limit unset, or raise it/);
  expect(text).not.toMatch(/UnknownRevert|EmptyRevert|refused:/);
}

describe("QuoteTransferOutOfGas, said by name", () => {
  it("renderError names it as an on-chain failure, with the gas advice and the limit it ran at", () => {
    const text = renderError("arcnow_buy", outOfGas(180_000n));
    expectNamedOutOfGas("arcnow_buy", text);
    expect(text).toMatch(/gasLimit=180000/);
  });

  it("arcnow_buy on a EURC curve", async () => {
    const { ctx } = ctxWithWrites({ quote: EURC, curveBuyThrows: outOfGas() }, EURC_CAP);
    const result = await callTool("arcnow_buy",
      { address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10" }, ctx);
    expect(result.isError).toBe(true);
    expectNamedOutOfGas("arcnow_buy", result.text);
  });

  it("arcnow_sell on a EURC curve", async () => {
    const { ctx } = ctxWithWrites({ quote: EURC, curveSellThrows: outOfGas() }, EURC_CAP);
    const result = await callTool("arcnow_sell",
      { address: CURVE, tokensIn: "1000", slippageBps: 50 }, ctx);
    expect(result.isError).toBe(true);
    expectNamedOutOfGas("arcnow_sell", result.text);
  });

  it("arcnow_buy in a EURC pool", async () => {
    const { ctx } = ctxWithWrites(
      { quote: EURC, state: MIGRATED, poolBuyThrows: outOfGas() }, EURC_CAP);
    const result = await callTool("arcnow_buy",
      { address: TOKEN, quoteIn: "1", slippageBps: 50, maxTotalCost: "1" }, ctx);
    expect(result.isError).toBe(true);
    expectNamedOutOfGas("arcnow_buy", result.text);
  });

  it("arcnow_sell in a EURC pool", async () => {
    const { ctx } = ctxWithWrites(
      { quote: EURC, state: MIGRATED, poolSellThrows: outOfGas() }, EURC_CAP);
    const result = await callTool("arcnow_sell",
      { address: TOKEN, tokensIn: "1000", slippageBps: 50, approveRouter: true }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/failed on-chain: QuoteTransferOutOfGas/);
    expect(flat(result.text)).toMatch(/leave the gas limit unset, or raise it/);
  });

  it("arcnow_launch in EURC", async () => {
    const { ctx } = ctxWithWrites({ launchThrows: outOfGas() }, EURC_CAP);
    const result = await callTool("arcnow_launch", {
      name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", quote: "EURC",
      slippageBps: 50, maxTotalCost: "27", acknowledgeIrreversible: true,
    }, ctx);
    expect(result.isError).toBe(true);
    expectNamedOutOfGas("arcnow_launch", result.text);
  });
});

describe("the server adds no gas limit of its own to an ERC-20 trade that does not graduate", () => {
  it("a non-graduating EURC curve buy goes out with no gasLimit, so the SDK adds its headroom", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, buyQuote: { graduates: false } }, EURC_CAP);
    const result = await callTool("arcnow_buy",
      { address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    const write = port.writes.find((w) => w.what === "write:buy")?.args as { gasLimit?: bigint };
    expect(write.gasLimit).toBeUndefined();
    expect(result.text).toMatch(/gas limit sent\s+estimated by the node, with the SDK's headroom/);
  });

  it("a graduating one still carries the SDK's GRADUATION_GAS_LIMIT", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, buyQuote: { graduates: true } }, EURC_CAP);
    await callTool("arcnow_buy", { address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10" }, ctx);
    const write = port.writes.find((w) => w.what === "write:buy")?.args as { gasLimit?: bigint };
    expect(write.gasLimit).toBe(8_000_000n);
  });
});
