/**
 * The SDK's refusals, said as refusals, and the reads this server does not make.
 *
 * - **An address that is not a bonding curve** is the SDK's `AddressIsNotACurve`,
 *   naming what the address is. A token address is still followed to its curve;
 *   anything else is refused under that code, and a transport failure stays a
 *   transport failure rather than becoming "not an arcnow.io address".
 * - **SDK-side refusals are refusals.** Every code in the SDK's own
 *   `SDK_ERROR_CODES` that is not a decoded revert or a transport failure is
 *   raised before any transaction, and is said as "refused", never "failed
 *   on-chain".
 * - **A failed native transfer inside a pool is decoded by the SDK**
 *   (`NativeTransferFailed`). This server names it from the layers and shows
 *   the SDK's reason once, without guessing a cause of its own on top.
 * - **Reads.** A pool trade's fill and fee payout come from its receipt, so the
 *   trade tools ask the fee hook nothing; `arcnow_token` asks it once, for the
 *   accrual.
 */

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ArcNowError, SDK_ERROR_CODES, WRAPPED_ERROR_SELECTOR } from "@arcnow/sdk";

import { callTool, renderError } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat } from "../support/context.js";
import type { FakePort } from "../support/fake-port.js";
import { CURVE, FEE_HOOK, TOKEN } from "../support/fake-port.js";

/** Arc's USDC ERC-20 interface predeploy: an ERC-20, and not an arcnow.io token. */
const USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const MIGRATED = { state: { graduated: true, migrated: true } } as const;

const whats = (port: FakePort): string[] => port.calls.map((c) => c.what);
const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: TOKEN, quoteIn: "1", slippageBps: 100, maxTotalCost: "1", ...over,
});
const sellArgs = (over: Record<string, unknown> = {}) => ({
  address: TOKEN, tokensIn: "1000", slippageBps: 100, ...over,
});

/**
 * The SDK's refusal for an address that answers no `VERSION()`, as its curve
 * handle raises it. (`notACurve` builds it inside the SDK and is not exported.)
 */
function answersNoVersion(address: string): ArcNowError {
  return new ArcNowError({
    code: "AddressIsNotACurve",
    message: `the address ${address} answers no VERSION(), so it is not a bonding curve: every `
      + "arcnow.io curve answers arcnow/bonding-curve@<version>. Either nothing is deployed there "
      + "on this chain, or the contract there is not one of arcnow.io's. Check the address and the "
      + "network. If it is a token, its curve is token.curve(), or use client.trade(token).",
    details: { address },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("an address that is not a bonding curve", () => {
  it("an ERC-20 that is not an arcnow.io token is refused as AddressIsNotACurve, and nothing is quoted", async () => {
    const { ctx, port } = ctxReadOnly({
      curveThrows: answersNoVersion(USDC_ERC20),
      tokenCurveThrows: new Error("execution reverted"),
    });
    const result = await callTool("arcnow_quote_buy", { address: USDC_ERC20, quoteIn: "1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^arcnow_quote_buy refused: AddressIsNotACurve/);
    expect(result.text).toContain(USDC_ERC20);
    expect(flat(result.text)).toMatch(/not an arcnow\.io token either/);
    expect(flat(result.text)).toMatch(/Nothing was quoted and nothing was sent/);
    expect(flat(result.text)).not.toMatch(/failed on-chain/);
    expect(whats(port)).not.toContain("read:quoteBuy");
  });

  it("an arcnow.io token address is still followed to its curve", async () => {
    const { ctx, port } = ctxReadOnly({ notACurve: TOKEN });
    await expect(Promise.resolve().then(() => port.curve(TOKEN).state()))
      .rejects.toMatchObject({ code: "AddressIsNotACurve" });
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/resolved from\s+the token address you gave/);
  });

  it("a transport failure reading the address stays a transport failure", async () => {
    const { ctx } = ctxReadOnly({
      curveThrows: new ArcNowError({
        code: "RpcFailure",
        message: "the call did not reach a contract (calling VERSION): rate limit exceeded.",
      }),
      tokenCurveThrows: new Error("rate limit exceeded"),
    });
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^arcnow_token could not reach the chain: RpcFailure/);
    expect(flat(result.text)).toMatch(/says nothing about the address/);
    expect(flat(result.text)).not.toMatch(/AddressIsNotACurve|does not answer as an arcnow\.io/);
  });
});

describe("the SDK's own codes: refusals are refusals, reverts are failures", () => {
  const REVERTS = new Set([
    "WrappedRevert", "UnknownRevert", "RevertString", "Panic", "EmptyRevert", "QuoteTransferOutOfGas",
  ]);

  it.each([...SDK_ERROR_CODES])("%s", (code) => {
    const text = renderError("arcnow_tool", new ArcNowError({ code, message: "m" }));
    if (REVERTS.has(code)) {
      expect(text).toMatch(new RegExp(`^arcnow_tool failed on-chain: ${code}`));
    } else if (code === "RpcFailure") {
      expect(text).toMatch(/^arcnow_tool could not reach the chain: RpcFailure/);
    } else {
      expect(text).toMatch(new RegExp(`^arcnow_tool refused: ${code}`));
      expect(text).not.toMatch(/failed on-chain/);
    }
  });

  it("a decoded contract revert is still a failure on-chain", () => {
    const text = renderError("arcnow_tool", new ArcNowError({ code: "CurveGraduated", message: "m" }));
    expect(text).toMatch(/^arcnow_tool failed on-chain: CurveGraduated/);
  });

  it("UnknownHookVersion names the hook and the version it answered", () => {
    const text = renderError("arcnow_token", new ArcNowError({
      code: "UnknownHookVersion",
      message: "the pool carries a fee hook answering VERSION() \"arcnow/arc-now-fee-hook@1.0.0\".",
      details: { hook: FEE_HOOK, version: "arcnow/arc-now-fee-hook@1.0.0" },
    }));
    expect(text).toMatch(/^arcnow_token refused: UnknownHookVersion/);
    expect(text).toContain("arcnow/arc-now-fee-hook@1.0.0");
    expect(text).toContain(getAddress(FEE_HOOK));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a native transfer that failed inside a pool, explained once", () => {
  const sdkMessage = "inside a Uniswap v4 call — beforeSwap on the hook (HookCallFailed), inside native "
    + `transfer on the hook (NativeTransferFailed) — the PoolManager could not pay native USDC to `
    + `${FEE_HOOK}: v4-core's native transfer failed with no reason; a smaller trade succeeds. The `
    + "layers are on error.details.wrappedBy.";
  const nativeTransferFailed = new ArcNowError({
    code: "WrappedRevert",
    message: sdkMessage,
    selector: WRAPPED_ERROR_SELECTOR,
    details: {
      wrappedBy: [
        {
          target: FEE_HOOK, selector: "0x575e24b4", selectorName: "beforeSwap",
          details: "0xa9e35b2f", detailsName: "HookCallFailed",
        },
        {
          target: FEE_HOOK, selector: "0x00000000", selectorName: "native transfer",
          details: "0xf4b3b1bc", detailsName: "NativeTransferFailed",
        },
      ],
      reason: "0x",
    },
  });

  it("names what failed from the SDK's decoded layers, and gives the SDK's reason once", async () => {
    const { ctx } = ctxReadOnly({ ...MIGRATED, poolQuoteBuyThrows: nativeTransferFailed });
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "25000" }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text))
      .toMatch(/^arcnow_quote_buy: the pool refused this buy — a native USDC transfer out of the PoolManager failed/);
    expect(result.text).toContain(`native transfer on ${getAddress(FEE_HOOK)} (NativeTransferFailed)`);
    expect(flat(result.text).split("a smaller trade succeeds")).toHaveLength(2);
    expect(flat(result.text)).not.toMatch(/inference|too large for the pool's current USDC/);
    expect(flat(result.text)).toMatch(/quote a smaller amount with arcnow_quote_buy/);
  });

  it("arcnow_buy says the same, and sends nothing", async () => {
    const { ctx, port } = ctxWithWrites(
      { ...MIGRATED, poolBuyThrows: nativeTransferFailed },
      { ARCNOW_MCP_MAX_SPEND_USDC: "100000" },
    );
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "25000", maxTotalCost: "25000" }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/a native USDC transfer out of the PoolManager failed/);
    expect(port.writes).toEqual([]);
  });

  it("a WrappedRevert the SDK could not name gets no cause guessed", async () => {
    const { ctx } = ctxReadOnly({
      ...MIGRATED,
      poolQuoteBuyThrows: new ArcNowError({
        code: "WrappedRevert",
        message: "inside a Uniswap v4 call — the call reverted with no data at all.",
        selector: WRAPPED_ERROR_SELECTOR,
        details: {
          wrappedBy: [{
            target: FEE_HOOK, selector: "0x575e24b4", selectorName: "beforeSwap",
            details: "0xa9e35b2f", detailsName: "HookCallFailed",
          }],
          reason: "0x",
        },
      }),
    });
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "25000" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/WrappedRevert/);
    expect(result.text).toContain(`beforeSwap on ${getAddress(FEE_HOOK)} (HookCallFailed)`);
    expect(flat(result.text)).not.toMatch(/inference|too large|smaller trade succeeds/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the reads the tools make of the fee hook", () => {
  it("a pool buy and a pool sell ask the hook only its rates: fill and payout come from the receipt", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const bought = await callTool("arcnow_buy", buyArgs(), ctx);
    const sold = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(bought.isError, bought.text).toBeUndefined();
    expect(sold.isError, sold.text).toBeUndefined();
    // The buy's 0.80% of 1 USDC, paid out by the sell — from the receipt, not the hook.
    expect(sold.text).toMatch(/earlier fees paid out\s+0\.008 USDC/);
    expect(whats(port)).not.toContain("read:pool.accruedHookFee");
    // The rates each report prints are read off the pool, once per trade.
    expect(whats(port).filter((w) => w === "read:pool.fees")).toHaveLength(2);
  });

  it("arcnow_token asks the hook once for its accrual and once for its rates", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(whats(port).filter((w) => w === "read:pool.accruedHookFee")).toHaveLength(1);
    expect(whats(port).filter((w) => w === "read:pool.fees")).toHaveLength(1);
  });
});
