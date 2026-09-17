/**
 * The two ceilings, and the assertion that they stop a transaction rather than
 * annotate one.
 *
 * `port.writes` being empty is the test. An error message that arrives after
 * the money left is not a guard.
 */

import { describe, expect, it } from "vitest";

import { callTool, findTool } from "../../src/tools/index.js";
import { ctxWithWrites, flat } from "../support/context.js";
import { CURVE } from "../support/fake-port.js";

const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: CURVE,
  quoteIn: "10",
  slippageBps: 50,
  maxTotalCost: "10",
  ...over,
});

describe("the caller's stated ceiling", () => {
  it("stops a buy that would cost more than the caller said", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "40", maxTotalCost: "25" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Refused/);
    expect(result.text).toContain("40 USDC");
    expect(result.text).toContain("25 USDC");
    expect(flat(result.text)).toMatch(/Nothing was sent/);
    expect(port.writes).toEqual([]);
  });

  it("tells the caller not to simply raise the ceiling", async () => {
    const { ctx } = ctxWithWrites();
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "40", maxTotalCost: "25" }), ctx);
    expect(flat(result.text)).toMatch(/Do not simply raise the ceiling/);
  });

  it("stops a launch whose quoted total is above the stated ceiling", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_launch", {
      name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "27", slippageBps: 50,
      maxTotalCost: "26", acknowledgeIrreversible: true,
    }, ctx);

    // The fixture quotes 27: the initial buy, launching being free.
    expect(result.isError).toBe(true);
    expect(result.text).toContain("27 USDC");
    expect(result.text).toContain("26 USDC");
    expect(port.writes).toEqual([]);
  });

  it("lets a spend equal to the ceiling through", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_buy", buyArgs({ quoteIn: "10", maxTotalCost: "10" }),
      ctx);
    expect(result.isError).toBeUndefined();
    expect(port.writes.length).toBe(1);
  });
});

describe("the operator's ceiling", () => {
  it("stops a buy above it even when the caller stated a bigger number", async () => {
    const { ctx, port } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "5" });
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "10", maxTotalCost: "1000" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/operator capped/);
    expect(result.text).toContain("5 USDC");
    expect(port.writes).toEqual([]);
  });

  it("says it cannot be raised from a tool call", async () => {
    const { ctx } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "5" });
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "10", maxTotalCost: "1000" }), ctx);
    expect(flat(result.text)).toMatch(/not an argument and cannot be raised/);
    expect(result.text).toMatch(/ARCNOW_MCP_MAX_SPEND_USDC/);
  });

  it("applies to a launch as well as a buy", async () => {
    const { ctx, port } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "5" });
    const result = await callTool("arcnow_launch", {
      name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", slippageBps: 50,
      maxTotalCost: "1000", acknowledgeIrreversible: true,
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/operator capped/);
    expect(port.writes).toEqual([]);
  });
});

describe("a launch", () => {
  it("will not run without the irreversibility acknowledgement", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_launch", {
      name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", slippageBps: 50,
      maxTotalCost: "30",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(port.writes).toEqual([]);
  });

  it("passes a slippage floor derived from the quote, never zero by default", async () => {
    const { ctx, port } = ctxWithWrites();
    await callTool("arcnow_launch", {
      name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", slippageBps: 100,
      maxTotalCost: "30", acknowledgeIrreversible: true,
    }, ctx);
    const write = port.writes[0]?.args as { minTokensOut: string };
    // 1% below the fixture's 125000.
    expect(write.minTokensOut).toBe("123750");
  });

  it("requires a slippage tolerance rather than defaulting one", () => {
    for (const name of ["arcnow_launch", "arcnow_buy", "arcnow_sell"]) {
      const tool = findTool(name);
      const schema = tool?.inputSchema as {
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
      };
      expect(schema.required).toContain("slippageBps");
      expect(schema.properties?.slippageBps?.default).toBeUndefined();
    }
  });

  it("requires a stated cost ceiling on every tool that spends", () => {
    for (const name of ["arcnow_launch", "arcnow_buy"]) {
      const schema = findTool(name)?.inputSchema as { required?: string[] };
      expect(schema.required).toContain("maxTotalCost");
    }
  });
});

describe("selling and migrating", () => {
  it("do not require a spend ceiling, because they spend nothing", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_sell",
      { address: CURVE, tokensIn: "1000", slippageBps: 50 }, ctx);
    expect(result.isError).toBeUndefined();
    expect(port.writes.length).toBe(1);
  });
});
