/**
 * The gas trap, which is the most expensive thing this server can get wrong and
 * the only one that fails with no error at all.
 *
 * A graduating buy migrates the curve in its own transaction, under a bounded
 * budget whose failure the curve CATCHES. `eth_estimateGas` finds the lowest
 * limit at which the transaction still succeeds — and it succeeds either way —
 * so an estimate converges on exactly the limit that starves the migration. The
 * buy fills, the curve graduates, the refund is right, and no market is ever
 * created.
 *
 * So: an explicit limit on a buy the quote says will graduate, no limit
 * otherwise, and a refusal rather than a silent disaster when somebody passes
 * one that is too small.
 */

import { describe, expect, it } from "vitest";

import { callTool } from "../../src/tools/index.js";
import { ctxWithWrites } from "../support/context.js";
import { CURVE } from "../support/fake-port.js";

const args = (over: Record<string, unknown> = {}) => ({
  address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10", ...over,
});

describe("a buy the quote says will graduate", () => {
  it("is sent with an explicit 8,000,000 gas limit", async () => {
    const { ctx, port } = ctxWithWrites({ buyQuote: { graduates: true } });
    await callTool("arcnow_buy", args(), ctx);
    const write = port.writes[0]?.args as { gasLimit?: bigint };
    expect(write.gasLimit).toBe(8_000_000n);
  });

  it("says in the report that the limit was explicit and why", async () => {
    const { ctx } = ctxWithWrites({ buyQuote: { graduates: true } });
    const result = await callTool("arcnow_buy", args(), ctx);
    expect(result.text).toMatch(/8000000, explicitly/);
    expect(result.text).toMatch(/unused gas is not charged/);
  });

  it("reports whether the pool was created in this very transaction", async () => {
    const { ctx } = ctxWithWrites({
      buyQuote: { graduates: true },
      buyResult: {
        graduated: true,
        migratedInThisTransaction: true,
        pool: "0x8888888888888888888888888888888888888888",
      },
    });
    const result = await callTool("arcnow_buy", args(), ctx);
    expect(result.text).toMatch(/migrated here\s+YES/);
  });

  it("calls out a starved migration as rescuable, and names the rescue", async () => {
    const { ctx } = ctxWithWrites({
      buyQuote: { graduates: true },
      buyResult: {
        graduated: true,
        migratedInThisTransaction: false,
        instantMigrationFailed: true,
      },
    });
    const result = await callTool("arcnow_buy", args(), ctx);
    expect(result.text).toMatch(/migrated here\s+NO/);
    expect(result.text).toMatch(/FAILED and was caught/);
    expect(result.text).toMatch(/arcnow_migrate/);
    expect(result.text).toMatch(/permissionless/);
  });

  it("refuses a gas limit too small for the migration, and sends nothing", async () => {
    const { ctx, port } = ctxWithWrites({ buyQuote: { graduates: true } });
    const result = await callTool("arcnow_buy", args({ gasLimit: 500_000 }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Refused/);
    expect(result.text).toMatch(/6200000/);
    expect(result.text).toMatch(/silently guarantees|starved|no market/i);
    expect(port.writes).toEqual([]);
  });
});

describe("a buy that will not graduate", () => {
  it("carries no gas limit, so the node estimates as usual", async () => {
    const { ctx, port } = ctxWithWrites({ buyQuote: { graduates: false } });
    await callTool("arcnow_buy", args(), ctx);
    const write = port.writes[0]?.args as { gasLimit?: bigint };
    expect(write.gasLimit).toBeUndefined();
  });

  it("accepts an explicit small limit, because nothing is at stake", async () => {
    const { ctx, port } = ctxWithWrites({ buyQuote: { graduates: false } });
    const result = await callTool("arcnow_buy", args({ gasLimit: 500_000 }), ctx);
    expect(result.isError).toBeUndefined();
    expect((port.writes[0]?.args as { gasLimit?: bigint }).gasLimit).toBe(500_000n);
  });
});

describe("the quote for a graduating buy", () => {
  it("explains the trap before anybody sends anything", async () => {
    const { ctx } = ctxWithWrites({ buyQuote: { graduates: true } });
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "10" }, ctx);
    expect(result.text).toMatch(/graduates\s+YES/);
    expect(result.text).toMatch(/eth_estimateGas/);
    expect(result.text).toMatch(/6,000,000/);
  });
});

describe("a launch whose initial buy graduates the curve", () => {
  const launchArgs = {
    name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", slippageBps: 50,
    maxTotalCost: "30", acknowledgeIrreversible: true,
  };

  it("is called out in the launch quote, with the SDK's explicit gas limit named", async () => {
    const { ctx } = ctxWithWrites({ launchQuote: { graduates: true } });
    const result = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" }, ctx);
    expect(result.text).toMatch(/graduates at launch\s+YES/);
    expect(result.text).toMatch(/8,000,000/);
  });

  it("reports whether the pool was created in the launch transaction itself", async () => {
    const { ctx } = ctxWithWrites({ launchQuote: { graduates: true } });
    const result = await callTool("arcnow_launch", launchArgs, ctx);
    expect(result.text).toMatch(/graduated at launch\s+YES/);
    expect(result.text).toMatch(/migrated here\s+YES/);
  });

  it("names the rescue when the launch graduated and its migration was starved", async () => {
    const { ctx } = ctxWithWrites({
      launchQuote: { graduates: true },
      launchResult: { migratedInThisTransaction: false, instantMigrationFailed: true },
    });
    const result = await callTool("arcnow_launch", launchArgs, ctx);
    expect(result.text).toMatch(/migrated here\s+NO/);
    expect(result.text).toMatch(/arcnow_migrate/);
  });

  it("says nothing about graduation when the initial buy does not graduate", async () => {
    const { ctx } = ctxWithWrites();
    const result = await callTool("arcnow_launch", launchArgs, ctx);
    expect(result.text).not.toMatch(/graduated at launch/);
  });
});
