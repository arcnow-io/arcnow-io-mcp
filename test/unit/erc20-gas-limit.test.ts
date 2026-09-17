/**
 * A caller's gas limit on an ERC-20 write is raised to a safe minimum, never
 * refused, and never lowered.
 *
 * The coordinator's decision, implemented by the pinned SDK (`erc20GasLimit`):
 * a non-graduating ERC-20 write goes out at
 * `max(callerGasLimit, estimate + max(20%, 150,000))`, because every ERC-20 fee
 * share passes contracts#23's gas guard, which an estimate can land right at the
 * edge of. A graduating one needs the migration's budget, so this server sends
 * `max(callerGasLimit, GRADUATION_GAS_LIMIT)`. Native USDC writes are unchanged.
 *
 * The fake chain sends a curve buy the way the SDK does, with the SDK's own
 * `erc20GasLimit` over a scripted estimate, and records the limit that went out.
 */

import { describe, expect, it } from "vitest";
import {
  erc20GasLimit,
  GRADUATION_GAS_LIMIT,
  QUOTE_TRANSFER_GAS_HEADROOM_BPS,
  QUOTE_TRANSFER_GAS_HEADROOM_MIN,
} from "@arcnow/sdk";

import { callTool, findTool } from "../../src/tools/index.js";
import { ctxWithWrites, flat } from "../support/context.js";
import { CURVE, EURC } from "../support/fake-port.js";

const EURC_CAP = { ARCNOW_MCP_MAX_SPEND_EURC: "1000" };
const ESTIMATE = 300_000n;
const buy = (gasLimit?: number) => ({
  address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10",
  ...(gasLimit === undefined ? {} : { gasLimit }),
});
type BuyWrite = { gasLimit?: bigint; gasSent?: bigint };
const sent = (port: { writes: readonly { what: string; args: unknown }[] }): BuyWrite =>
  port.writes.find((w) => w.what === "write:buy")?.args as BuyWrite;

describe("the SDK at the pin", () => {
  it("raises a limit below the estimate plus max(20%, 150,000), and keeps one above it", () => {
    expect(QUOTE_TRANSFER_GAS_HEADROOM_BPS).toBe(2_000n);
    expect(QUOTE_TRANSFER_GAS_HEADROOM_MIN).toBe(150_000n);
    expect(erc20GasLimit(300_000n)).toBe(450_000n);
    expect(erc20GasLimit(300_000n, 100_000n)).toBe(450_000n);
    expect(erc20GasLimit(1_000_000n, 100_000n)).toBe(1_200_000n);
    expect(erc20GasLimit(300_000n, 5_000_000n)).toBe(5_000_000n);
  });
});

describe("a non-graduating EURC curve buy with a caller's gasLimit", () => {
  it("below the safe minimum: not refused, and the SDK raises it to the estimate plus headroom", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, gasEstimate: ESTIMATE }, EURC_CAP);
    const result = await callTool("arcnow_buy", buy(100_000), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(sent(port).gasLimit).toBe(100_000n);
    expect(sent(port).gasSent).toBe(450_000n);
    expect(flat(result.text)).toMatch(/gas limit sent at least 100000, raised by the SDK/);
  });

  it("above it: kept exactly", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, gasEstimate: ESTIMATE }, EURC_CAP);
    const result = await callTool("arcnow_buy", buy(5_000_000), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(sent(port).gasSent).toBe(5_000_000n);
  });

  it("with none: the estimate plus headroom", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, gasEstimate: ESTIMATE }, EURC_CAP);
    await callTool("arcnow_buy", buy(), ctx);
    expect(sent(port).gasLimit).toBeUndefined();
    expect(sent(port).gasSent).toBe(450_000n);
  });
});

describe("a graduating EURC curve buy", () => {
  it("a caller's limit below GRADUATION_GAS_LIMIT is raised to it, never refused", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, buyQuote: { graduates: true } }, EURC_CAP);
    const result = await callTool("arcnow_buy", buy(500_000), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(sent(port).gasLimit).toBe(GRADUATION_GAS_LIMIT);
    expect(port.writes.map((w) => w.what)).toContain("write:buy");
  });

  it("a caller's limit above it is kept", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, buyQuote: { graduates: true } }, EURC_CAP);
    await callTool("arcnow_buy", buy(9_000_000), ctx);
    expect(sent(port).gasLimit).toBe(9_000_000n);
  });
});

describe("the gasLimit parameter's description", () => {
  it("says an ERC-20 limit is raised to a safe minimum and a higher one kept, with no out-of-gas warning", () => {
    const schema = findTool("arcnow_buy")?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    const text = flat(schema.properties?.gasLimit?.description ?? "");
    expect(text).toMatch(/raised to a safe minimum/);
    expect(text).toMatch(/estimate plus max\(20%, 150,000\)/);
    expect(text).toMatch(/8,000,000 when the buy graduates/);
    expect(text).toMatch(/A higher limit is kept/);
    expect(text).not.toMatch(/QuoteTransferOutOfGas/);
  });
});
