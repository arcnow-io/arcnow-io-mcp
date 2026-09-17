/**
 * Per-quote spend caps, fail-closed.
 *
 * The design, decided and implemented exactly:
 *
 * - `ARCNOW_MCP_MAX_SPEND_USDC` caps native USDC, default 100, as before.
 * - `ARCNOW_MCP_MAX_SPEND_<SYMBOL>` caps every other quote in its own units.
 * - A symbol resolves ONLY against the network's `quoteTokens`, never against a
 *   token's on-chain `symbol()`.
 * - A variable naming no quote token of the network is a startup error; so are
 *   two quote tokens sharing a symbol.
 * - A quote with no cap is REFUSED for every spending write, and a quote the
 *   network does not list can have no cap at all — so a cap can never be got
 *   round by switching quote.
 *
 * `port.writes` being empty is the assertion for every refusal: an ERC-20
 * approve is a write, and it must not go out either.
 */

import { describe, expect, it } from "vitest";
import { QuoteAmount } from "@arcnow/sdk";

import { ConfigError, loadConfig, startupBanner } from "../../src/config.js";
import { callTool } from "../../src/tools/index.js";
import {
  ctxWithWrites,
  flat,
  TEST_KEY,
  withNetworkFile,
} from "../support/context.js";
import { CURVE, EURC, NETWORK, USDC, WETHX } from "../support/fake-port.js";

const ON_EURC = { quote: EURC } as const;
const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10", ...over,
});
const launchArgs = (over: Record<string, unknown> = {}) => ({
  name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25",
  slippageBps: 50, maxTotalCost: "27", acknowledgeIrreversible: true, ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the caps, as configured", () => {
  it("defaults to 100 USDC for native USDC and NO cap for any other quote", () => {
    const config = loadConfig({});
    expect(config.maxSpendPerCallUsdc.format()).toBe("100 USDC");
    expect(config.describe().maxSpendPerCallUsdc).toBe("100");
    expect(config.describe().maxSpendPerCall).toEqual({ USDC: "100", EURC: null });
    expect(config.spendCapFor(EURC)?.cap).toBeUndefined();
    expect(config.spendCapFor(EURC)?.variable).toBe("ARCNOW_MCP_MAX_SPEND_EURC");
  });

  it("reads ARCNOW_MCP_MAX_SPEND_EURC in EURC's own units", () => {
    const config = loadConfig({ ARCNOW_MCP_MAX_SPEND_EURC: "50" });
    const cap = config.spendCapFor(EURC)?.cap;
    expect(cap?.format()).toBe("50 EURC");
    expect(cap?.token.decimals).toBe(6);
    expect(config.describe().maxSpendPerCall).toEqual({ USDC: "100", EURC: "50" });
  });

  it("shows every cap in the banner, and says which quotes are refused", () => {
    const withEurc = startupBanner(loadConfig(
      { ARCNOW_PRIVATE_KEY: TEST_KEY, ARCNOW_MCP_MAX_SPEND_EURC: "50" }, ["--allow-writes"]));
    expect(withEurc).toMatch(/spend cap\s+100 USDC per write call/);
    expect(withEurc).toMatch(/50 EURC per write call/);
    const without = flat(startupBanner(loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY }, ["--allow-writes"])));
    expect(without).toMatch(/EURC none — every spend in EURC is refused/);
    expect(without).toMatch(/ARCNOW_MCP_MAX_SPEND_EURC/);
  });

  it("refuses to start on a variable that names no quote token of the network: a typo", () => {
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_EURO: "50" })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_EURO: "50" }))
      .toThrow(/ARCNOW_MCP_MAX_SPEND_EURO names no quote token of arc-testnet/);
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_EURO: "50" })).toThrow(/ARCNOW_MCP_MAX_SPEND_EURC/);
  });

  it("refuses a lower-cased symbol rather than guessing: the symbol is upper-cased", () => {
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_eurc: "50" })).toThrow(ConfigError);
  });

  it("refuses a cap with more decimals than its quote token has", () => {
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_EURC: "50.0000001" }))
      .toThrow(/ARCNOW_MCP_MAX_SPEND_EURC.*6 decimals/s);
  });

  it("refuses to start when two of the network's quote tokens share a symbol", () => {
    const twin = { ...WETHX, symbol: "EURC" };
    const { env, readFile } = withNetworkFile([...NETWORK.quoteTokens, twin]);
    expect(() => loadConfig(env, [], readFile)).toThrow(ConfigError);
    expect(() => loadConfig(env, [], readFile)).toThrow(/share the symbol EURC/);
  });

  it("resolves a symbol against the network's quoteTokens only: WETHX exists only on a network that lists it", () => {
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_WETHX: "3" })).toThrow(ConfigError);
    const { env, readFile } = withNetworkFile([...NETWORK.quoteTokens, WETHX], { ARCNOW_MCP_MAX_SPEND_WETHX: "3" });
    expect(loadConfig(env, [], readFile).spendCapFor(WETHX)?.cap?.format()).toBe("3 WETHX");
  });

  it("is keyed by address, so a token that calls itself EURC is not EURC", () => {
    const config = loadConfig({ ARCNOW_MCP_MAX_SPEND_EURC: "50" });
    const impostor = { ...WETHX, symbol: "EURC", decimals: 6 };
    expect(config.spendCapFor(impostor)).toBeUndefined();
    expect(config.spendCapFor(USDC)?.cap?.format()).toBe("100 USDC");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a USDC-only configuration", () => {
  it("refuses a EURC buy, names the variable that would allow it, and sends nothing — no approve either", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC);
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/no spend cap for EURC/);
    expect(flat(result.text)).toMatch(/ARCNOW_MCP_MAX_SPEND_EURC/);
    expect(flat(result.text)).toMatch(/Nothing was sent/);
    expect(port.writes).toEqual([]);
    expect(port.calls.map((c) => c.what)).not.toContain("read:quoteBuy");
  });

  it("refuses a EURC launch the same way", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_launch", launchArgs({ quote: "EURC" }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/no spend cap for EURC/);
    expect(flat(result.text)).toMatch(/ARCNOW_MCP_MAX_SPEND_EURC=/);
    expect(port.writes).toEqual([]);
    expect(port.calls.map((c) => c.what)).not.toContain("read:quoteLaunch");
  });

  it("refuses a EURC pool buy too", async () => {
    const { ctx, port } = ctxWithWrites({ ...ON_EURC, state: { graduated: true, migrated: true } });
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/no spend cap for EURC/);
    expect(port.writes).toEqual([]);
  });

  it("still caps native USDC with ARCNOW_MCP_MAX_SPEND_USDC", async () => {
    const { ctx, port } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "5" });
    const result = await callTool("arcnow_buy", buyArgs({ maxTotalCost: "1000" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/operator capped/);
    expect(result.text).toContain("5 USDC");
    expect(port.writes).toEqual([]);
  });
});

describe("an EURC cap", () => {
  const EURC_50 = { ARCNOW_MCP_MAX_SPEND_EURC: "50" };

  it("allows a EURC buy up to it, approving exactly the spend", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC, EURC_50);
    const result = await callTool("arcnow_buy", buyArgs({ quoteIn: "50", maxTotalCost: "50" }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve", "write:buy"]);
    expect(port.writes[0]?.args).toMatchObject({ amount: "50", token: EURC.address });
  });

  it("refuses a EURC buy one raw unit above it, in EURC", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC, EURC_50);
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "50.000001", maxTotalCost: "1000" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/operator capped any single write in EURC at 50 EURC/);
    expect(flat(result.text)).toMatch(/ARCNOW_MCP_MAX_SPEND_EURC/);
    expect(port.writes).toEqual([]);
  });

  it("allows a EURC launch whose total — the initial buy, launching being free — is exactly the cap", async () => {
    const { ctx, port } = ctxWithWrites({}, EURC_50);
    const result = await callTool("arcnow_launch",
      launchArgs({ quote: "EURC", initialBuy: "50", maxTotalCost: "50" }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve", "write:launch"]);
    expect(port.writes[0]?.args).toMatchObject({ amount: "50", spender: NETWORK.contracts.launchpad });
  });

  it("refuses a EURC launch whose total is above it", async () => {
    const { ctx, port } = ctxWithWrites({}, EURC_50);
    const result = await callTool("arcnow_launch",
      launchArgs({ quote: "EURC", initialBuy: "50.000001", maxTotalCost: "1000" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/50\.000001 EURC/);
    expect(result.text).toMatch(/operator capped/);
    expect(port.writes).toEqual([]);
  });
});

describe("a cap is for its own quote and no other", () => {
  it("a cap on USDC does not let a EURC spend above the EURC cap through", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC,
      { ARCNOW_MCP_MAX_SPEND_USDC: "1000", ARCNOW_MCP_MAX_SPEND_EURC: "5" });
    const result = await callTool("arcnow_buy", buyArgs({ maxTotalCost: "1000" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("5 EURC");
    expect(result.text).not.toContain("1000 USDC");
    expect(port.writes).toEqual([]);
  });

  it("a small USDC cap does not stop a EURC spend under the EURC cap", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC,
      { ARCNOW_MCP_MAX_SPEND_USDC: "5", ARCNOW_MCP_MAX_SPEND_EURC: "1000" });
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toContain("write:buy");
  });

  it("an EURC cap does not lift the USDC cap", async () => {
    const { ctx, port } = ctxWithWrites({},
      { ARCNOW_MCP_MAX_SPEND_USDC: "5", ARCNOW_MCP_MAX_SPEND_EURC: "1000" });
    const result = await callTool("arcnow_buy", buyArgs({ maxTotalCost: "1000" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("5 USDC");
    expect(port.writes).toEqual([]);
  });

  it("the caller's stated ceiling is read in the quote too, exactly", async () => {
    const { ctx, port } = ctxWithWrites(ON_EURC, { ARCNOW_MCP_MAX_SPEND_EURC: "1000" });
    const over = await callTool("arcnow_buy", buyArgs({ quoteIn: "10", maxTotalCost: "9.999999" }), ctx);
    expect(over.isError).toBe(true);
    expect(over.text).toContain("10 EURC");
    expect(over.text).toContain("9.999999 EURC");
    const tooFine = await callTool("arcnow_buy", buyArgs({ maxTotalCost: "10.0000001" }), ctx);
    expect(tooFine.isError).toBe(true);
    expect(flat(tooFine.text)).toMatch(/EURC has 6 decimals/);
    expect(port.writes).toEqual([]);
  });
});

describe("a quote this network does not list", () => {
  it("cannot be capped, so a buy on a curve priced in it is refused", async () => {
    const { ctx, port } = ctxWithWrites({ quote: WETHX }, { ARCNOW_MCP_MAX_SPEND_EURC: "1000" });
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/not one of this network's quote tokens/);
    expect(flat(result.text)).toMatch(/no spend cap can be configured for it/);
    expect(port.writes).toEqual([]);
  });

  it("a launch in it is refused before anything is read about it", async () => {
    const { ctx, port } = ctxWithWrites({ unlistedQuotes: [WETHX] });
    const result = await callTool("arcnow_launch", launchArgs({ quote: WETHX.address }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/not one of this network's quote tokens/);
    expect(port.calls.map((c) => c.what)).toEqual([]);
  });

  it("the refusal on an amount of it is exact about what would have been spent", () => {
    expect(QuoteAmount.parse(WETHX, "10").format()).toBe("10 WETHX");
  });
});
