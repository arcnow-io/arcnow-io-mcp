/**
 * A token after graduation: quoted and traded in its Uniswap v4 pool, through
 * arcnow.io's router, by way of `client.trade(token)`.
 *
 * Three states, and the tools have to tell them apart out loud:
 *
 * - **on its curve** — everything as before, and a pool-only parameter refused;
 * - **graduated AND migrated** — the pool: a pool quote that says it is one,
 *   with arcnow.io's 1%, the pool's own LP fee, the average fill price against
 *   the pool's spot price, and the price impact; a buy and a sell through the
 *   router under every guard the curve had; curve-only parameters refused;
 * - **graduated, NOT migrated** — tradeable nowhere until somebody calls
 *   `migrate()`, which is what the tools say, naming `arcnow_migrate`.
 *
 * The new thing that can cost somebody something is the router approval a pool
 * sell needs. It is asserted from every side: never sent without
 * `approveRouter: true`, never for more than the amount sold, never when the
 * existing allowance already covers the sale, and disclosed in the result —
 * what, to whom, how much, which transaction — even when the sell that
 * followed it failed.
 */

import { describe, expect, it } from "vitest";
import {
  ArcNowError,
  Bps,
  minTokensOutFromQuote,
  minQuoteOutFromQuote,
  Tokens,
  Usdc,
} from "@arcnow/sdk";

import { callTool, findTool } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat, readOnlyConfig } from "../support/context.js";
import {
  APPROVE_TX,
  CURVE,
  FakePort,
  FEE_HOOK,
  NETWORK,
  PAYEE,
  POOL_MANAGER,
  POOL_TX,
  ROUTER,
  SIGNER,
  TOKEN,
} from "../support/fake-port.js";

const MIGRATED = { state: { graduated: true, migrated: true } } as const;
const STRANDED = { state: { graduated: true, migrated: false } } as const;

const whats = (port: FakePort): string[] => port.calls.map((c) => c.what);
const lower = (text: string): string => text.toLowerCase();

const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: TOKEN, quoteIn: "1", slippageBps: 100, maxTotalCost: "1", ...over,
});
const sellArgs = (over: Record<string, unknown> = {}) => ({
  address: TOKEN, tokensIn: "1000", slippageBps: 100, ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("arcnow_quote_buy on a migrated token", () => {
  it("quotes the pool through the SDK and says it is a pool quote, not a curve one", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(flat(result.text)).toMatch(/Uniswap v4 pool/);
    expect(flat(result.text)).toMatch(/not a bonding-curve quote/i);
    expect(whats(port)).toContain("read:pool.quoteBuy");
    expect(whats(port)).not.toContain("read:quoteBuy");
  });

  it("breaks out the hook's 0.80% and the pool's own 0.20% LP fee as two separate charges, 1% in all", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(result.text).toMatch(/fees in all\s+1% of the trade in all — 0\.8% \(80 bps\) taken by arcnow\.io's fee hook in USDC, plus 0\.2% \(2000 hundredths of a bip\) the pool keeps as its LP fee/);
    expect(result.text).toMatch(/arcnow\.io fee\s+0\.008 USDC — 0\.8% of the trade \(80 bps\), read from the hook/);
    expect(result.text).toMatch(/pool fee\s+0\.2% \(2000 hundredths of a bip\)/);
    expect(flat(result.text)).toMatch(/liquidity/i);
    // Nothing here says 1% is the hook's: the curve's 1% is never a pool figure.
    expect(result.text).not.toMatch(/arcnow\.io fee\s+0\.01 USDC/);
    // The rates came off the pool, through the SDK's Pool.fees(), not from a constant.
    expect(whats(port)).toContain("read:pool.fees");
  });

  it("reads the rates it prints off the pool: another LP fee in the key is reported as it is", async () => {
    const { ctx } = ctxReadOnly({ ...MIGRATED, poolFee: 3000 });
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(result.text).toMatch(/pool fee\s+0\.3% \(3000 hundredths of a bip\)/);
    expect(result.text).toMatch(/fees in all\s+1\.1% of the trade in all — 0\.8% \(80 bps\)/);
  });

  it("shows how the hook splits its 0.80% — creator, platform, protocol — and that a pool has no referrer share", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(result.text).toMatch(/how the fee hook splits its 0\.8% — read from the hook/);
    expect(result.text).toMatch(/creator\s+5000 bps of the fee \(50% of the fee, 0\.4% of a trade\)/);
    expect(result.text).toMatch(/platform\s+1875 bps of the fee \(18\.75% of the fee, 0\.15% of a trade\)/);
    expect(result.text).toMatch(/protocol\s+3125 bps of the fee \(31\.25% of the fee, 0\.25% of a trade\)/);
    expect(result.text).toMatch(/referrer\s+0 bps — a pool swap names no referrer/);
    expect(result.text).not.toMatch(/developer/);
  });

  it("puts the average fill price next to the pool's spot price, with the price impact", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(result.text).toMatch(/average fill price\s+0\.000\d+ USDC per token/);
    // The fixture's pool is priced at 0.0002 and fills a real order 1.5% worse.
    expect(result.text).toMatch(/pool spot price\s+0\.0002\d* USDC per token/);
    expect(result.text).toMatch(/price impact\s+\+1\.52/);
    expect(flat(result.text)).toMatch(/probe/);
  });

  it("shows the minimum-out floors computed from the pool quote", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    const quote = await port.trade(TOKEN).quoteBuy(Usdc.parse("1"));
    const floor = minTokensOutFromQuote(quote, Bps.of(100n));
    expect(result.text).toMatch(new RegExp(`100 bps \\(1%\\)\\s+${floor.toString()} EXAM`));
  });

  it("names the router the quote was priced through", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(lower(result.text)).toContain(lower(ROUTER));
  });

  it("refuses a referrer rather than ignoring it, because a pool swap has none", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy",
      { address: TOKEN, quoteIn: "1", referrer: PAYEE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("referrer");
    expect(flat(result.text)).toMatch(/curve-only/);
    expect(flat(result.text)).toMatch(/refused rather than ignored/i);
    expect(whats(port)).not.toContain("read:pool.quoteBuy");
  });

  it("has no developer argument anywhere: the fee has four parties, and a strict schema refuses one", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy",
      { address: TOKEN, quoteIn: "1", developer: PAYEE }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/developer/);
    expect(whats(port)).not.toContain("read:pool.quoteBuy");
  });
});

describe("arcnow_quote_sell on a migrated token", () => {
  it("needs a holder on a read-only server, and says why", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_sell", { address: TOKEN, tokensIn: "1000" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/holder/);
    expect(flat(result.text)).toMatch(/actually holds/);
    expect(whats(port)).not.toContain("read:pool.quoteSell");
  });

  it("quotes for a named holder, as a pool quote with both fees and the impact", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_sell",
      { address: TOKEN, tokensIn: "1000", holder: PAYEE }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(flat(result.text)).toMatch(/not a bonding-curve quote/i);
    expect(result.text).toMatch(/you receive\s+0\.\d+ USDC/);
    expect(result.text).toMatch(/arcnow\.io fee\s+0\.00\d+ USDC — 0\.8% of the trade \(80 bps\), read from the hook/);
    expect(result.text).toMatch(/pool fee\s+0\.2% \(2000 hundredths of a bip\)/);
    expect(result.text).toMatch(/fees in all\s+1% of the trade in all/);
    expect(result.text).toMatch(/price impact\s+-1\.5/);
    expect(port.calls.find((c) => c.what === "read:pool.quoteSell")?.args)
      .toMatchObject({ from: PAYEE });
  });

  it("says a sell here needs an approval to the router first, and how much is approved now", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_sell",
      { address: TOKEN, tokensIn: "1000", holder: PAYEE }, ctx);
    expect(flat(result.text)).toMatch(/ERC-20 approval/);
    expect(lower(result.text)).toContain(lower(ROUTER));
    expect(result.text).toMatch(/approved now\s+0 EXAM/);
  });

  it("prices as the signing address on a writing server", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    await callTool("arcnow_quote_sell", { address: TOKEN, tokensIn: "1000" }, ctx);
    expect(port.calls.find((c) => c.what === "read:pool.quoteSell")?.args)
      .toMatchObject({ from: SIGNER });
    expect(port.writes).toEqual([]);
  });
});

describe("a token that graduated but never migrated", () => {
  it.each([
    ["arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }],
    ["arcnow_quote_sell", { address: TOKEN, tokensIn: "1000", holder: PAYEE }],
    ["arcnow_buy", buyArgs()],
    ["arcnow_sell", sellArgs({ approveRouter: true })],
  ] as const)("%s says it is tradeable nowhere, names arcnow_migrate, and sends nothing",
    async (name, args) => {
      const { ctx, port } = ctxWithWrites(STRANDED);
      const result = await callTool(name, args, ctx);
      expect(result.isError).toBe(true);
      expect(flat(result.text)).toMatch(/not tradeable anywhere/);
      expect(flat(result.text)).toMatch(/arcnow_migrate/);
      expect(port.writes).toEqual([]);
      expect(whats(port).filter((w) => /quote/i.test(w))).toEqual([]);
    });
});

describe("arcnow_token reports where a token trades", () => {
  it("on its curve", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/venue\s+its bonding curve/);
  });

  it("in its pool, through a router this server has configured and can reach", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/venue\s+its Uniswap v4 pool/);
    expect(result.text).toMatch(/reachable\s+yes/);
    expect(lower(result.text)).toContain(lower(ROUTER));
    expect(result.text).toMatch(/fees\s+1% of the trade in all — 0\.8% \(80 bps\) taken by arcnow\.io's fee hook in USDC, plus 0\.2% \(2000 hundredths of a bip\)/);
    expect(result.text).toMatch(/how the fee hook splits its 0\.8%/);
  });

  it("names the PoolManager as a manager, never as the token's pool address", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/pool manager\s+0x/);
    expect(lower(result.text)).toContain(lower(POOL_MANAGER));
    expect(flat(result.text)).toMatch(/has no address of its own/);
    expect(result.text).not.toMatch(/— created/);
  });

  it("nowhere, when it graduated and never migrated", async () => {
    const { ctx } = ctxReadOnly(STRANDED);
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/venue\s+NONE/);
    expect(flat(result.text)).toMatch(/arcnow_migrate/);
  });

  it("says so when no router is configured, rather than implying the pool is tradeable", async () => {
    const config = { ...NETWORK, contracts: { ...NETWORK.contracts, v4Router: undefined } };
    const port = new FakePort(MIGRATED, { canWrite: false, signerAddress: undefined, config });
    const result = await callTool("arcnow_token", { address: TOKEN }, { port, config: readOnlyConfig() });
    expect(result.text).toMatch(/reachable\s+no/);
    expect(flat(result.text)).toMatch(/no v4 router is configured/i);
  });
});

describe("arcnow_network reports the router", () => {
  it("names it when the network configures one", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_network", {}, ctx);
    expect(lower(result.text)).toMatch(new RegExp(`v4router\\s+${lower(ROUTER)}`));
    expect(flat(result.text)).toMatch(/graduated tokens trade/i);
  });

  it("says graduated tokens cannot be traded when it does not", async () => {
    const config = { ...NETWORK, contracts: { ...NETWORK.contracts, v4Router: undefined } };
    const port = new FakePort({}, { canWrite: false, signerAddress: undefined, config });
    const result = await callTool("arcnow_network", {}, { port, config: readOnlyConfig() });
    expect(result.text).toMatch(/v4Router\s+not deployed on this chain/);
    expect(flat(result.text)).toMatch(/cannot be quoted or traded/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("arcnow_buy on a migrated token", () => {
  it("routes through the pool, with a floor from a quote taken inside the call and no gas limit", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError, result.text).toBeUndefined();

    const order = whats(port);
    expect(order.indexOf("read:pool.quoteBuy")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("read:pool.quoteBuy")).toBeLessThan(order.indexOf("write:pool.buy"));
    expect(port.writes.map((w) => w.what)).toEqual(["write:pool.buy"]);

    const quote = await port.trade(TOKEN).quoteBuy(Usdc.parse("1"));
    const write = port.writes[0]?.args as { minTokensOut: string; quoteIn: string };
    expect(write.quoteIn).toBe("1");
    expect(write.minTokensOut).toBe(minTokensOutFromQuote(quote, Bps.of(100n)).toString());
  });

  it("still stops a buy over the caller's stated ceiling", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_buy", buyArgs({ quoteIn: "40", maxTotalCost: "25" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Refused/);
    expect(port.writes).toEqual([]);
  });

  it("still stops a buy over the operator's ceiling", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED, { ARCNOW_MCP_MAX_SPEND_USDC: "0.5" });
    const result = await callTool("arcnow_buy", buyArgs({ maxTotalCost: "1000" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/operator capped/);
    expect(port.writes).toEqual([]);
  });

  it.each([
    ["gasLimit", 8_000_000],
    ["referrer", PAYEE],
  ] as const)("refuses %s, a curve-only parameter, and sends nothing", async (field, value) => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_buy", buyArgs({ [field]: value }), ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(field);
    expect(flat(result.text)).toMatch(/curve-only/);
    expect(flat(result.text)).toMatch(/refused rather than ignored/i);
    expect(port.writes).toEqual([]);
  });

  it("reports what the transaction did: tokens, the hook's fee, the pool fee, the hash", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    const quote = await port.trade(TOKEN).quoteBuy(Usdc.parse("1"));
    expect(result.text).toMatch(/venue\s+Uniswap v4 pool/);
    expect(result.text).toContain(`${quote.tokensOut.toString()} EXAM`);
    expect(result.text).toMatch(/arcnow\.io fee\s+0\.008 USDC — what arcnow\.io's fee hook took, at 0\.8% of the trade \(80 bps\)/);
    expect(result.text).toMatch(/pool fee\s+0\.2% \(2000 hundredths of a bip\) — Uniswap's LP fee, inside the price/);
    expect(flat(result.text)).toMatch(/1% of the trade in all, both read off the pool/);
    expect(result.text).toContain(POOL_TX);
    expect(result.text).toMatch(/tokens to\s+0x3333333333333333333333333333333333333333 \(the signing address\)/);
  });

  it("pays a named recipient, and says it is not the signing address", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_buy", buyArgs({ recipient: PAYEE }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect((port.writes[0]?.args as { recipient: string }).recipient).toBe(PAYEE);
    expect(result.text).toMatch(/NOT the signing address/);
  });
});

describe("a pool-only or pool-sell parameter on a token still on its curve", () => {
  it("arcnow_buy refuses a recipient, because a curve pays msg.sender", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_buy", buyArgs({ address: CURVE, recipient: PAYEE }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/pool-only/);
    expect(flat(result.text)).toMatch(/msg\.sender/);
    expect(port.writes).toEqual([]);
  });

  it("arcnow_sell refuses a recipient too", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_sell", sellArgs({ address: CURVE, recipient: PAYEE }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/pool-only/);
    expect(port.writes).toEqual([]);
  });

  it("arcnow_sell refuses approveRouter, because a curve sell never needs an approval", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_sell", sellArgs({ address: CURVE, approveRouter: true }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/needs no approval/);
    expect(port.writes).toEqual([]);
  });

  it("a curve buy still goes to the curve, with its gas-limit handling intact", async () => {
    const { ctx, port } = ctxWithWrites({ buyQuote: { graduates: true } });
    const result = await callTool("arcnow_buy",
      buyArgs({ address: CURVE, quoteIn: "10", maxTotalCost: "10" }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:buy"]);
    expect((port.writes[0]?.args as { gasLimit?: bigint }).gasLimit).toBe(8_000_000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("arcnow_sell on a migrated token: the router approval", () => {
  it("refuses without approveRouter when the router is not approved, and sends nothing", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell", sellArgs(), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/ERC-20 approval/);
    expect(lower(result.text)).toContain(lower(ROUTER));
    expect(result.text).toMatch(/1000 EXAM/);
    expect(flat(result.text)).toMatch(/approveRouter: true/);
    expect(flat(result.text)).toMatch(/Nothing was sent/);
    expect(port.writes).toEqual([]);
  });

  it("with approveRouter, approves exactly the amount being sold, never more, then sells", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:pool.approveRouter", "write:pool.sell"]);
    expect(port.writes[0]?.args).toEqual({ amount: "1000", spender: ROUTER });
  });

  it("discloses the approval in the result: what, to whom, how much, and which transaction", async () => {
    const { ctx } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(result.text).toMatch(/approval granted/i);
    expect(result.text).toMatch(/spender\s+0x139166Ee61bb560ff34f05AE4a2B666ad98B9b2e/);
    expect(result.text).toMatch(/amount\s+1000 EXAM — exactly the amount sold, not unlimited/);
    expect(result.text).toContain(APPROVE_TX);
    expect(result.text).toMatch(/allowance now\s+0 EXAM/);
  });

  it("sends no approval when the existing allowance already covers the sale, and says so", async () => {
    const { ctx, port } = ctxWithWrites({ ...MIGRATED, routerAllowance: Tokens.parse("5000") });
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(port.writes.map((w) => w.what)).toEqual(["write:pool.sell"]);
    expect(flat(result.text)).toMatch(/No approval was sent/);
    expect(result.text).toMatch(/allowance now\s+4000 EXAM/);
  });

  it("still discloses an approval it granted when the sell itself then fails", async () => {
    const { ctx, port } = ctxWithWrites({
      ...MIGRATED,
      poolSellThrows: new Error("execution reverted: SlippageExceeded"),
    });
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(result.isError).toBe(true);
    expect(port.writes.map((w) => w.what)).toEqual(["write:pool.approveRouter"]);
    expect(result.text).toMatch(/approval granted/i);
    expect(result.text).toContain(APPROVE_TX);
    expect(flat(result.text)).toMatch(/still stands/);
    expect(result.text).toMatch(/SlippageExceeded/);
  });

  it("computes the floor from a fresh pool quote and the stated slippage", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    const order = whats(port);
    expect(order.indexOf("read:pool.quoteSell")).toBeLessThan(order.indexOf("write:pool.approveRouter"));
    const quote = await port.trade(TOKEN).quoteSell(Tokens.parse("1000"), { from: SIGNER });
    const write = port.writes[1]?.args as { minQuoteOut: string };
    expect(write.minQuoteOut).toBe(minQuoteOutFromQuote(quote, Bps.of(100n)).toString());
  });

  it("pays the USDC to a named recipient", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell",
      sellArgs({ approveRouter: true, recipient: PAYEE }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect((port.writes[1]?.args as { recipient: string }).recipient).toBe(PAYEE);
    expect(result.text).toMatch(/NOT the signing address/);
  });

  it("refuses a referrer and sends nothing, approval included", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true, referrer: PAYEE }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/curve-only/);
    expect(port.writes).toEqual([]);
  });

  it("a developer is not an argument at all, and sends nothing, approval included", async () => {
    const { ctx, port } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true, developer: PAYEE }), ctx);
    expect(result.isError).toBe(true);
    expect(port.writes).toEqual([]);
  });
});

describe("the schemas say which parameters apply where", () => {
  const property = (tool: string, field: string): Record<string, unknown> | undefined =>
    (findTool(tool)?.inputSchema as { properties?: Record<string, Record<string, unknown>> })
      .properties?.[field];

  it("marks gasLimit and referrer curve-only and recipient pool-only", () => {
    for (const field of ["gasLimit", "referrer"]) {
      expect(String(property("arcnow_buy", field)?.description)).toMatch(/^CURVE ONLY/);
    }
    expect(String(property("arcnow_buy", "recipient")?.description)).toMatch(/^POOL ONLY/);
    expect(String(property("arcnow_sell", "recipient")?.description)).toMatch(/^POOL ONLY/);
    expect(String(property("arcnow_sell", "approveRouter")?.description)).toMatch(/^POOL ONLY/);
  });

  it("publishes no developer argument on any tool: the fee has four parties", () => {
    for (const tool of ["arcnow_quote_buy", "arcnow_quote_sell", "arcnow_buy", "arcnow_sell", "arcnow_register_platform"]) {
      const schema = findTool(tool)?.inputSchema as { properties?: Record<string, unknown> };
      for (const field of Object.keys(schema.properties ?? {})) {
        expect(field, `${tool}.${field}`).not.toMatch(/dev/i);
      }
    }
  });

  it("does not require or default approveRouter", () => {
    const schema = findTool("arcnow_sell")?.inputSchema as { required?: string[] };
    expect(schema.required).not.toContain("approveRouter");
    expect(property("arcnow_sell", "approveRouter")?.default).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a pool revert the SDK cannot decode", () => {
  // What the SDK reports for v4's WrappedError around a native transfer the
  // PoolManager could not make: decoded to NativeTransferFailed, and explained
  // by the SDK itself.
  const wrapped = () => new ArcNowError({
    code: "WrappedRevert",
    message: "inside a Uniswap v4 call — beforeSwap on the hook (HookCallFailed), inside native "
      + "transfer on the hook (NativeTransferFailed) — the PoolManager could not pay native USDC to "
      + "the hook: v4-core's native transfer failed with no reason; a smaller trade succeeds.",
    selector: "0x90bfb865",
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
  const unknown = (selector: `0x${string}`) => new ArcNowError({
    code: "UnknownRevert",
    message: `the call reverted with selector ${selector}, which is in none of the ABIs this `
      + "SDK carries.",
    selector,
    data: `${selector}${"00".repeat(32)}`,
  });

  it("arcnow_quote_buy says which transfer failed, from the SDK's decoded layers", async () => {
    const { ctx } = ctxReadOnly({ ...MIGRATED, poolQuoteBuyThrows: wrapped() });
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "25000" }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/the pool refused this buy/);
    expect(flat(result.text)).toMatch(/a smaller trade succeeds/);
    expect(flat(result.text)).toMatch(/NativeTransferFailed/);
    expect(result.text).toContain("0x90bfb865");
  });

  it("arcnow_buy says the same, and sends nothing", async () => {
    const { ctx, port } = ctxWithWrites(
      { ...MIGRATED, poolBuyThrows: wrapped() },
      { ARCNOW_MCP_MAX_SPEND_USDC: "100000" },
    );
    const result = await callTool("arcnow_buy",
      buyArgs({ quoteIn: "25000", maxTotalCost: "25000" }), ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/the pool refused this buy/);
    expect(port.writes).toEqual([]);
  });

  it("passes any other unknown revert through as the SDK wrote it, with no guess attached", async () => {
    const { ctx } = ctxReadOnly({ ...MIGRATED, poolQuoteBuyThrows: unknown("0xdeadbeef") });
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/UnknownRevert/);
    expect(flat(result.text)).not.toMatch(/too large/);
  });
});

describe("a pool trade's figures, as its receipt records them", () => {
  it("reports a buy too small to be charged as paying no fee, not as a zero amount", async () => {
    const { ctx } = ctxWithWrites(MIGRATED);
    const tiny = "0.00000000000000005";
    const result = await callTool("arcnow_buy", buyArgs({ quoteIn: tiny, maxTotalCost: tiny }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/arcnow\.io fee\s+none — this trade was too small/);
  });

  it("reports a sell's USDC as read from the Swap log, not as an estimate or a bound", async () => {
    const { ctx } = ctxWithWrites(MIGRATED);
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(flat(result.text)).toMatch(/you received \d/);
    expect(flat(result.text)).toMatch(/PoolManager's Swap log/);
    expect(flat(result.text)).not.toMatch(/lower bound|approximate|at most 99 wei/i);
  });
});
