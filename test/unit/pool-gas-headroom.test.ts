/**
 * An ERC-20-quoted pool swap goes out with more gas headroom than a curve trade.
 *
 * Security review L-1 on arcnow-io/contracts#23: a swap's gas estimate can miss the fee
 * hook redeeming and distributing its accrued fee — an accrual that was zero
 * when estimated, until a front-running dust swap made it not — and every ERC-20
 * share the hook then pushes needs 111,587 gas left before it. So the pinned SDK
 * sends an ERC-20 pool buy or sell at the estimate plus max(20%, 400,000)
 * (`withPoolQuoteTransferHeadroom`), where a curve trade or a launch keeps
 * max(20%, 150,000). A native pool is unchanged.
 *
 * The fake chain sends a pool swap the way the SDK does, with the SDK's own
 * function over a scripted estimate, and records the limit that went out.
 */

import { describe, expect, it } from "vitest";
import {
  ArcNowError,
  POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN,
  QUOTE_TRANSFER_GAS_HEADROOM_MIN,
  withPoolQuoteTransferHeadroom,
  withQuoteTransferHeadroom,
} from "@arcnow/sdk";

import { callTool, renderError } from "../../src/tools/index.js";
import { ctxWithWrites, flat } from "../support/context.js";
import { EURC, TOKEN } from "../support/fake-port.js";

const MIGRATED = { graduated: true, migrated: true } as const;
const EURC_CAP = { ARCNOW_MCP_MAX_SPEND_EURC: "1000" };
const ESTIMATE = 300_000n;
type SwapWrite = { gasSent?: bigint };
type Writes = { writes: readonly { what: string; args: unknown }[] };
const swap = (port: Writes, what: string): SwapWrite =>
  port.writes.find((w) => w.what === what)?.args as SwapWrite;
const POOL_GAS_ROW
  = /gas limit sent estimated by the node, plus the SDK's headroom for a pool swap — max\(20%, 400,000\) more/;
const ON_EURC_POOL = { quote: EURC, state: MIGRATED, gasEstimate: ESTIMATE } as const;

describe("the SDK at the pin", () => {
  it("adds max(20%, 400,000) to an ERC-20 pool swap, and 150,000 to a curve trade", () => {
    expect(POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN).toBe(400_000n);
    expect(QUOTE_TRANSFER_GAS_HEADROOM_MIN).toBe(150_000n);
    expect(withPoolQuoteTransferHeadroom(300_000n)).toBe(700_000n);
    expect(withPoolQuoteTransferHeadroom(3_000_000n)).toBe(3_600_000n);
    expect(withQuoteTransferHeadroom(300_000n)).toBe(450_000n);
  });
});

describe("a EURC pool swap", () => {
  it("a buy goes out at the estimate plus 400,000, and its report says so", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC_POOL, EURC_CAP);
    const result = await callTool("arcnow_buy",
      { address: TOKEN, quoteIn: "1", slippageBps: 50, maxTotalCost: "1" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(swap(port, "write:pool.buy").gasSent).toBe(700_000n);
    expect(flat(result.text)).toMatch(POOL_GAS_ROW);
    expect(result.text).not.toMatch(/150,000/);
  });

  it("a sell goes out at the estimate plus 400,000, and its report says so", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC_POOL, EURC_CAP);
    const result = await callTool("arcnow_sell",
      { address: TOKEN, tokensIn: "1000", slippageBps: 50, approveRouter: true }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(swap(port, "write:pool.sell").gasSent).toBe(700_000n);
    expect(flat(result.text)).toMatch(POOL_GAS_ROW);
  });
});

describe("a native USDC pool swap", () => {
  it("is unchanged: the node's estimate, with no ERC-20 headroom", async () => {
    const { ctx, port } = ctxWithWrites({ state: MIGRATED, gasEstimate: ESTIMATE });
    const result = await callTool("arcnow_buy",
      { address: TOKEN, quoteIn: "1", slippageBps: 50, maxTotalCost: "1" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(swap(port, "write:pool.buy").gasSent).toBeUndefined();
    expect(result.text).toMatch(/gas limit sent\s+estimated by the node — a pool buy cannot graduate/);
    expect(result.text).not.toMatch(/400,000/);
  });
});

describe("the out-of-gas error", () => {
  it("names both minimums: 150,000 for a curve trade or launch, 400,000 for a pool swap", () => {
    const text = flat(renderError("arcnow_buy", new ArcNowError({
      code: "QuoteTransferOutOfGas",
      message: "the call reverted with no data, on a path that pays EURC fee shares.",
      data: "0x",
      details: { quoteToken: EURC.address },
    })));
    expect(text).toMatch(/at least 150,000 more for a curve trade or a launch/);
    expect(text).toMatch(/at least 400,000 more for a pool swap/);
  });
});
