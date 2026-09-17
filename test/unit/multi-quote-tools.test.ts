/**
 * Every amount in its own quote.
 *
 * A curve is priced in native USDC (18 decimals, paid as msg.value) or an
 * allowlisted ERC-20: EURC at 6 decimals, or an 18-decimal ERC-20. What is
 * asserted here is what a model is told:
 *
 * - a figure is labelled with the symbol of the quote it is in — never "USDC"
 *   for a EURC amount — and the quote token itself is named, with its address,
 *   decimals and kind;
 * - a pool's quote is the SDK's answer, whichever currency of the key it is;
 * - an input with more decimals than its quote has is refused, never rounded;
 * - an ERC-20 spend's approve is reported, sent or not;
 * - `arcnow_quote_tokens` lists what a launch may use, and says so plainly when
 *   the chain has no registry to ask;
 * - a 2.x contract is refused by name.
 */

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ArcNowError, QuoteAmount } from "@arcnow/sdk";

import { callTool, findTool, renderError } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat, withNetworkFile } from "../support/context.js";
import type { FakePort } from "../support/fake-port.js";
import {
  CURVE,
  EURC,
  NETWORK,
  QUOTE_APPROVE_TX,
  RETIRED_CURVE_VERSION,
  ROUTER,
  TOKEN,
  USDC,
  WETHX,
} from "../support/fake-port.js";

const MIGRATED = { graduated: true, migrated: true } as const;
/** A figure followed by USDC: what must never appear in a report about a EURC curve. */
const USDC_FIGURE = /\d USDC\b/;
const whats = (port: FakePort): string[] => port.calls.map((c) => c.what);
const EURC_CAP = { ARCNOW_MCP_MAX_SPEND_EURC: "1000" };
const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: CURVE, quoteIn: "10", slippageBps: 50, maxTotalCost: "10", ...over,
});
const launchArgs = (over: Record<string, unknown> = {}) => ({
  name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25",
  slippageBps: 50, maxTotalCost: "27", acknowledgeIrreversible: true, ...over,
});
const QUOTE_LAUNCH = { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25" };
/** A network that lists WETHX, the 18-decimal ERC-20. */
const withWethx = (env: Record<string, string> = {}) =>
  withNetworkFile([...NETWORK.quoteTokens, WETHX], env);

// ─────────────────────────────────────────────────────────────────────────────

describe("a token priced in a 6-decimal ERC-20 (EURC)", () => {
  it("arcnow_token names the quote token and prints every amount in EURC", async () => {
    const { ctx } = ctxReadOnly({ quote: EURC });
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(new RegExp(
      `quote token\\s+EURC \\(EURC\\) — ERC-20 at ${getAddress(EURC.address)}, 6 decimals`));
    expect(result.text).toMatch(/12000 EURC of 50000 EURC/);
    expect(result.text).toMatch(/spot price\s+0\.0001 EURC per token/);
    expect(result.text).toMatch(/virtual EURC reserve at launch/);
    expect(result.text).not.toMatch(USDC_FIGURE);
  });

  it("arcnow_quote_buy takes the amount in EURC and says an ERC-20 is pulled, not sent as value", async () => {
    const { ctx, port } = ctxReadOnly({ quote: EURC });
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/trade fee\s+1 EURC/);
    expect(result.text).toMatch(/reaches the curve\s+99 EURC/);
    expect(result.text).toMatch(/creator\s+0\.3 EURC/);
    expect(flat(result.text)).toMatch(/pulled by the curve/);
    expect(flat(result.text)).toMatch(/exact ERC-20 approval/);
    expect(result.text).not.toMatch(/msg\.value/);
    expect(result.text).not.toMatch(USDC_FIGURE);
    expect(port.calls.find((c) => c.what === "read:quoteBuy")?.args).toEqual({ quoteIn: "100", symbol: "EURC" });
  });

  it("arcnow_quote_sell reports the proceeds and the floors in EURC", async () => {
    const { ctx } = ctxReadOnly({ quote: EURC });
    const result = await callTool("arcnow_quote_sell", { address: CURVE, tokensIn: "1000" }, ctx);
    expect(result.text).toMatch(/you receive\s+97\.9 EURC/);
    expect(result.text).toMatch(/minimum EURC out, by tolerance/);
    expect(result.text).not.toMatch(USDC_FIGURE);
  });

  it("arcnow_list_tokens labels a launch's figures with the quote from the Launched log", async () => {
    const { ctx } = ctxReadOnly({ quote: EURC });
    const result = await callTool("arcnow_list_tokens", { limit: 1 }, ctx);
    expect(result.text).toMatch(/quote\s+EURC/);
    expect(result.text).toMatch(/25 EURC initial buy, 0 EURC launch fee — launching is free/);
    expect(result.text).not.toMatch(USDC_FIGURE);
  });
});

describe("a token priced in an 18-decimal ERC-20", () => {
  it("is labelled with its own symbol and 18 decimals, and still needs an approval", async () => {
    const { env, readFile } = withWethx();
    const { ctx } = ctxReadOnly({ quote: WETHX }, env, readFile);
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "1.000000000000000001" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/1\.000000000000000001 WETHX/);
    expect(flat(result.text)).toMatch(/exact ERC-20 approval/);
    expect(result.text).not.toMatch(USDC_FIGURE);
    const token = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(token.text).toMatch(/quote token\s+WETHX \(Test Eighteen\) — ERC-20 at 0x0e0e.*18 decimals/i);
  });
});

describe("a token priced in native USDC", () => {
  it("says native, 18 decimals, and paid as msg.value with no approval", async () => {
    const { ctx } = ctxReadOnly();
    const token = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(token.text).toMatch(/quote token\s+USDC — native, the gas currency, paid as msg\.value .*18 decimals/);
    const quote = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100" }, ctx);
    expect(quote.text).toMatch(/you send\s+100 USDC — as msg\.value/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a pool's quote is the SDK's, in either currency order", () => {
  it("EURC above the token's address: the quote is currency1, and every figure is EURC", async () => {
    const { ctx } = ctxReadOnly({ quote: EURC, state: MIGRATED });
    const token = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(token.text).toMatch(/quote currency\s+EURC — currency1 of the pool key, with the token as currency0/);
    const quote = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(quote.isError, quote.text).toBeUndefined();
    // The hook's 0.80% of 1 EURC, in EURC — never the curve's 1%.
    expect(quote.text).toMatch(/arcnow\.io fee\s+0\.008 EURC — 0\.8% of the trade \(80 bps\), read from the hook/);
    expect(quote.text).toMatch(/pool spot price\s+0\.000\d+ EURC per token/);
    expect(quote.text).not.toMatch(USDC_FIGURE);
  });

  it("an 18-decimal ERC-20 below the token's address: the quote is currency0", async () => {
    const { env, readFile } = withWethx();
    const { ctx } = ctxReadOnly({ quote: WETHX, state: MIGRATED }, env, readFile);
    const token = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(token.text).toMatch(/quote currency\s+WETHX — currency0 of the pool key, with the token as currency1/);
  });

  it("follows the SDK when it says EURC is currency0, rather than guessing from the addresses", async () => {
    const { ctx } = ctxReadOnly({ quote: EURC, state: MIGRATED, quoteIsCurrency0: true });
    const token = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(token.text).toMatch(/quote currency\s+EURC — currency0 of the pool key/);
  });

  it("a EURC pool sell's floor is a whole number of EURC raw units, and is shown in EURC", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, state: MIGRATED }, EURC_CAP);
    const result = await callTool("arcnow_sell",
      { address: TOKEN, tokensIn: "1000", slippageBps: 37, approveRouter: true }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    const floor = (port.writes.find((w) => w.what === "write:pool.sell")?.args as { minQuoteOut: string }).minQuoteOut;
    expect(() => QuoteAmount.parse(EURC, floor)).not.toThrow();
    expect(result.text).toMatch(/you received\s+0\.\d{1,6} EURC/);
    expect(result.text).not.toMatch(USDC_FIGURE);
  });

  it("a EURC pool buy approves the router for exactly the spend, and reports it", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, state: MIGRATED }, EURC_CAP);
    const result = await callTool("arcnow_buy", buyArgs({ address: TOKEN, quoteIn: "1", maxTotalCost: "1" }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve", "write:pool.buy"]);
    expect(port.writes[0]?.args).toMatchObject({ spender: ROUTER, amount: "1" });
    expect(result.text).toMatch(/approve\s+SENT/);
    expect(result.text).toContain(QUOTE_APPROVE_TX);
    expect(result.text).toMatch(/arcnow\.io fee\s+0\.008 EURC — what arcnow\.io's fee hook took, at 0\.8% of the trade \(80 bps\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("an amount its quote cannot represent", () => {
  it("arcnow_quote_buy refuses 7 decimals of EURC instead of rounding, and quotes nothing", async () => {
    const { ctx, port } = ctxReadOnly({ quote: EURC });
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "1.0000001" }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/quoteIn "1\.0000001" is not an amount of EURC: EURC has 6 decimals/);
    expect(flat(result.text)).toMatch(/Nothing was quoted and nothing was sent/);
    expect(whats(port)).not.toContain("read:quoteBuy");
  });

  it("arcnow_buy refuses it and sends nothing, approve included", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC }, EURC_CAP);
    const result = await callTool("arcnow_buy", buyArgs({ quoteIn: "0.0000001", maxTotalCost: "1" }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/EURC has 6 decimals/);
    expect(port.writes).toEqual([]);
  });

  it("arcnow_launch refuses an initial buy of EURC dust", async () => {
    const { ctx, port } = ctxWithWrites({}, EURC_CAP);
    const result = await callTool("arcnow_launch",
      launchArgs({ quote: "EURC", initialBuy: "1.0000001", maxTotalCost: "30" }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/initialBuy "1\.0000001" is not an amount of EURC/);
    expect(port.writes).toEqual([]);
  });

  it("the SDK's own QuoteAmountNotRepresentable is said as a refusal, by name", () => {
    const text = renderError("arcnow_buy", new ArcNowError({
      code: "QuoteAmountNotRepresentable",
      message: "1 wad of EURC is not a whole number of its raw units.",
      details: { amountWad: 1n, quoteScale: 1_000_000_000_000n, quoteToken: EURC.address },
    }));
    expect(text).toMatch(/^arcnow_buy refused: QuoteAmountNotRepresentable/);
    expect(text).toMatch(/quoteScale=1000000000000/);
    expect(text).not.toMatch(/failed on-chain/);
  });

  it("a native amount has 18 decimals, so the same input is fine there", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "1.0000001" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the ERC-20 approval an ERC-20 spend needs", () => {
  it("a EURC curve buy with no allowance: the approve is sent first, exactly, and reported", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC }, EURC_CAP);
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve", "write:buy"]);
    expect(port.writes[0]?.args).toMatchObject({ spender: CURVE, amount: "10" });
    expect(result.text).toMatch(/approve\s+SENT first, as its own transaction: exactly 10 EURC/);
    expect(result.text).toContain(QUOTE_APPROVE_TX);
    expect(result.text).toMatch(/you sent\s+10 EURC — pulled by the curve/);
  });

  it("a EURC curve buy the allowance already covers: no approve, and the report says so", async () => {
    const { ctx, port } = ctxWithWrites({ quote: EURC, quoteAllowance: "1000" }, EURC_CAP);
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:buy"]);
    expect(result.text).toMatch(/approve\s+none sent — the existing EURC allowance/);
    expect(result.text).not.toContain(QUOTE_APPROVE_TX);
  });

  it("a native buy has no approval at all, and says it is msg.value", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(port.writes.map((w) => w.what)).toEqual(["write:buy"]);
    expect(result.text).toMatch(/you sent\s+10 USDC — as msg\.value/);
    expect(result.text).not.toMatch(/approve\s+/);
  });

  it("a EURC launch approves the launchpad for exactly the total, sends no value, and reports the approve", async () => {
    const { ctx, port } = ctxWithWrites({}, EURC_CAP);
    const result = await callTool("arcnow_launch", launchArgs({ quote: "EURC" }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve", "write:launch"]);
    // Launching is free, so the total IS the initial buy: 25 EURC, no fee on top.
    expect(port.writes[0]?.args).toMatchObject({ spender: NETWORK.contracts.launchpad, amount: "25" });
    expect(port.writes[1]?.args).toMatchObject({ quote: "EURC", value: "0" });
    expect(result.text).toMatch(/total\s+25 EURC — exactly, pulled by the launchpad/);
    expect(result.text).toMatch(/launch fee\s+0 EURC launch fee — launching is free/);
    expect(result.text).toMatch(/approve\s+SENT first/);
    expect(result.text).toContain(QUOTE_APPROVE_TX);
  });

  it("a EURC launch that fails after its approve says the approve may stand, with the allowance read back", async () => {
    const { ctx, port } = ctxWithWrites({
      launchThrows: new ArcNowError({ code: "QuoteTokenNotSupported", message: "the launchpad refuses EURC" }),
    }, EURC_CAP);
    const result = await callTool("arcnow_launch", launchArgs({ quote: "EURC" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/QuoteTokenNotSupported/);
    expect(flat(result.text)).toMatch(/EURC allowance to the launchpad now stands at 25 EURC/);
    expect(port.writes.map((w) => w.what)).toEqual(["write:quote.approve"]);
    expect(whats(port)).toContain("read:quote.spendState");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("arcnow_quote_tokens", () => {
  it("is a read tool, published read-only", () => {
    const tool = findTool("arcnow_quote_tokens");
    expect(tool?.access).toBe("read");
    expect(flat(tool?.description ?? "")).toMatch(/ARCNOW_MCP_MAX_SPEND_<SYMBOL>/);
  });

  it("lists every registered quote with its launch fee, whether it is active, and its spend cap", async () => {
    const { ctx, port } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "100" });
    const result = await callTool("arcnow_quote_tokens", {}, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/^USDC — USD Coin/m);
    expect(result.text).toMatch(/^EURC — EURC/m);
    expect(result.text).toMatch(new RegExp(`address\\s+${getAddress(EURC.address)}`));
    expect(result.text).toMatch(/decimals\s+6/);
    expect(result.text).toMatch(/kind\s+native/);
    expect(result.text).toMatch(/kind\s+ERC-20/);
    // Zero on both, and said to be free — but printed from the registry's answer, not assumed.
    expect(result.text).toMatch(/launch fee\s+0 EURC launch fee — launching is free/);
    expect(result.text).toMatch(/launch fee\s+0 USDC launch fee — launching is free/);
    expect(result.text).toMatch(/active\s+yes/);
    expect(result.text).toMatch(/spend cap\s+100 USDC per write call/);
    expect(flat(result.text)).toMatch(/spend cap NONE — every launch or buy in EURC is refused until the operator sets ARCNOW_MCP_MAX_SPEND_EURC/);
    expect(whats(port)).toEqual(["read:quoteRegistry.list"]);
  });

  it("says a deregistered quote is not accepted, and a quote the network does not list cannot be capped", async () => {
    const { ctx } = ctxReadOnly({
      quoteRegistry: [
        { token: USDC, launchFee: QuoteAmount.parse(USDC, "2"), active: true },
        { token: EURC, launchFee: QuoteAmount.parse(EURC, "2"), active: false },
        { token: WETHX, launchFee: QuoteAmount.parse(WETHX, "0.001"), active: true },
      ],
    });
    const result = await callTool("arcnow_quote_tokens", {}, ctx);
    expect(result.text).toMatch(/active\s+NO/);
    expect(flat(result.text)).toMatch(/WETHX — Test Eighteen.*not one of this network's quote tokens/);
  });

  it("with no registry to ask, falls back to the network's metadata and says nothing is known to be accepted", async () => {
    const { ctx } = ctxReadOnly({
      quoteRegistryThrows: new ArcNowError({
        code: "UnknownRevert",
        message: "the call reverted: the launchpad at this address has no quoteTokenRegistry().",
      }),
    });
    const result = await callTool("arcnow_quote_tokens", {}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^The quote registry could not be read/);
    expect(flat(result.text)).toMatch(/NOT known/);
    expect(result.text).toMatch(/UnknownRevert/);
    expect(result.text).toMatch(/^EURC — EURC/m);
    expect(result.text).toMatch(/accepted\s+unknown/);
    expect(result.text).toMatch(/launch fee\s+unknown/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the launch tools' quote", () => {
  it("defaults to native USDC, paid as msg.value", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch", QUOTE_LAUNCH, ctx);
    expect(result.text).toMatch(/total, exactly\s+25 USDC/);
    expect(result.text).toMatch(/paid as\s+msg\.value: exactly 25 USDC/);
  });

  it.each(["EURC", "eurc", EURC.address, getAddress(EURC.address)])(
    "takes EURC by symbol or address (%s) and quotes the launch in it",
    async (quote) => {
      const { ctx, port } = ctxReadOnly();
      const result = await callTool("arcnow_quote_launch", { ...QUOTE_LAUNCH, quote }, ctx);
      expect(result.isError, result.text).toBeUndefined();
      expect(result.text).toMatch(/total, exactly\s+25 EURC/);
      expect(result.text).toMatch(/launch fee\s+0 EURC launch fee — launching is free/);
      expect(result.text).toMatch(/initial buy\s+25 EURC/);
      expect(result.text).toMatch(/of which fee\s+0\.25 EURC/);
      expect(flat(result.text)).toMatch(/an ERC-20 pull by the launchpad — the transaction carries no value/);
      expect(result.text).not.toMatch(USDC_FIGURE);
      // The launch fee comes inside the quote: no second read for it.
      expect(whats(port)).not.toContain("read:launchFee");
    },
  );

  it("refuses a symbol the network does not list, naming the ones it does", async () => {
    const { ctx, port } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch", { ...QUOTE_LAUNCH, quote: "EURO" }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/EURO is not a quote token of arc-testnet/);
    expect(result.text).toMatch(/USDC, EURC/);
    expect(result.text).toMatch(/arcnow_quote_tokens/);
    expect(whats(port)).not.toContain("read:quoteLaunch");
  });

  it("quotes an unlisted quote by address, reading its metadata, and warns a launch in it will be refused", async () => {
    const { ctx, port } = ctxReadOnly({ unlistedQuotes: [WETHX] });
    const result = await callTool("arcnow_quote_launch", { ...QUOTE_LAUNCH, quote: WETHX.address }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/total, exactly\s+25 WETHX/);
    expect(whats(port)).toContain("read:quoteTokenInfo");
    expect(flat(result.text)).toMatch(/not one of this network's quote tokens/);
  });

  it("says when the platform serves no template for the quote", async () => {
    const { ctx } = ctxReadOnly({ noTemplateFor: [EURC.address] });
    const result = await callTool("arcnow_quote_launch", { ...QUOTE_LAUNCH, quote: "EURC" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/QuoteNotEnabledOnPlatform/);
  });

  it("publishes quote as optional, and the trade tools' amounts as quoteIn and maxTotalCost", () => {
    const schema = (name: string) => findTool(name)?.inputSchema as {
      required?: string[]; properties?: Record<string, { description?: string }>;
    };
    for (const name of ["arcnow_launch", "arcnow_quote_launch"]) {
      expect(Object.keys(schema(name).properties ?? {})).toContain("quote");
      expect(schema(name).required).not.toContain("quote");
    }
    for (const name of ["arcnow_buy", "arcnow_quote_buy"]) {
      expect(Object.keys(schema(name).properties ?? {})).toContain("quoteIn");
      expect(Object.keys(schema(name).properties ?? {})).not.toContain(["usdc", "In"].join(""));
    }
    for (const name of ["arcnow_buy", "arcnow_launch"]) {
      expect(schema(name).required).toContain("maxTotalCost");
      expect(flat(schema(name).properties?.maxTotalCost?.description ?? "")).toMatch(/of the token's quote/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the retired multi-quote stack (3.x), whose data was wiped", () => {
  it("a 3.x curve is refused by name: UnknownCurveVersion, naming the version it answered", async () => {
    const { ctx } = ctxReadOnly({
      state: { version: RETIRED_CURVE_VERSION },
      tokenCurveThrows: new Error("execution reverted"),
    });
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^arcnow_token refused: UnknownCurveVersion/);
    expect(result.text).toContain("arcnow/bonding-curve@3.0.0");
    expect(flat(result.text)).toMatch(/arcnow\/bonding-curve@4\.x\.x/);
    expect(flat(result.text)).toMatch(/retired multi-quote stack/);
    // The SDK's own refusal names what that stack did differently, so nobody prices it by hand.
    expect(flat(result.text)).toMatch(/developer share/);
  });

  it("a quote registry of another version is refused by name, and the tool says which component", () => {
    const text = renderError("arcnow_quote_tokens", new ArcNowError({
      code: "UnknownCurveVersion",
      message: "the quote registry answers VERSION() \"arcnow/quote-registry@2.0.0\".",
      details: { version: "arcnow/quote-registry@2.0.0", component: "quote-registry" },
    }));
    expect(text).toMatch(/^arcnow_quote_tokens refused: UnknownCurveVersion — this quote registry answers VERSION\(\) "arcnow\/quote-registry@2\.0\.0"/);
  });
});
