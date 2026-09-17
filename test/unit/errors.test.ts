/**
 * What a failure looks like by the time a model reads it.
 *
 * The SDK's errors are already decoded by selector across every pinned ABI and
 * carry a sentence saying what to do. The job here is to not lose any of that,
 * and to add the one thing the SDK cannot know: which tool was running.
 */

import { describe, expect, it } from "vitest";
import { AmountParseError, ArcNowError } from "@arcnow/sdk";

import { callTool, renderError } from "../../src/tools/index.js";
import { NotArcNowError } from "../../src/tools/resolve.js";
import { ctxReadOnly, ctxWithWrites } from "../support/context.js";
import { CURVE } from "../support/fake-port.js";

describe("renderError", () => {
  it("keeps the SDK's code, message and decoded arguments", () => {
    const text = renderError("arcnow_buy", new ArcNowError({
      code: "SlippageExceeded",
      message: "the fill moved against your floor. Re-quote and retry.",
      args: { minOutWad: 1n, actualOutWad: 2n },
    }));
    expect(text).toMatch(/arcnow_buy failed on-chain: SlippageExceeded/);
    expect(text).toMatch(/Re-quote and retry/);
    expect(text).toMatch(/minOutWad=1/);
  });

  it("passes a 'this is not an arcnow.io address' through as written", () => {
    expect(renderError("arcnow_token", new NotArcNowError("not ours"))).toBe("not ours");
  });

  it("explains the amount format rather than repeating the parser", () => {
    const text = renderError("arcnow_buy", new AmountParseError("Usdc: too many decimals"));
    expect(text).toMatch(/decimal strings in whole units/);
    expect(text).toMatch(/18 decimals/);
  });
});

describe("a tool that throws", () => {
  it("comes back as a tool error rather than crashing the server", async () => {
    const { ctx } = ctxReadOnly({
      curveThrows: new ArcNowError({ code: "CurveGraduated", message: "it graduated" }),
      tokenCurveThrows: new Error("nope"),
    });
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not answer as an arcnow.io bonding curve/);
  });

  it("never rejects, whatever the port does", async () => {
    const { ctx } = ctxWithWrites({ curveThrows: "a string, thrown" });
    await expect(callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "1" }, ctx))
      .resolves.toBeDefined();
  });
});

describe("argument validation", () => {
  it("names the field and what was expected", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_token", { address: "not-an-address" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/address:/);
    expect(result.text).toMatch(/0x-prefixed 20-byte address/);
  });

  it("rejects a slippage tolerance outside 0–10000", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_buy", {
      address: CURVE, quoteIn: "1", slippageBps: 20_000, maxTotalCost: "1",
    }, ctx);
    expect(result.isError).toBe(true);
    expect(port.writes).toEqual([]);
  });
});
