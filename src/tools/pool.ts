/**
 * A graduated token's Uniswap v4 pool, as a quote presents it.
 *
 * # What a pool quote contains
 *
 * The SDK prices a pool trade by `eth_call`-ing the real swap through
 * arcnow.io's router and reading back the trader's own balance delta. So the
 * figures it returns — the quote in or out, tokens out or in — are the real
 * fill, with **two** charges already inside them, and this module's job is to
 * take them back out and name each one:
 *
 * - **arcnow.io's 1%**, the same flat fee the curve took, charged in the pool's
 *   quote token by `ArcNowFeeHook` inside the swap — off the input on a buy,
 *   out of the payout on a sell. The SDK reports it as `feeQuote`.
 * - **The pool's own LP fee**, which is Uniswap's and not arcnow.io's: the
 *   `fee` field of the pool key, in hundredths of a bip (3000 is 0.3%), charged
 *   by the pool on the amount it swaps and kept by its liquidity. The SDK does
 *   not report it as an amount; its rate is read from `pool.key()` and the
 *   amount follows from the rate.
 *
 * # The quote is the SDK's, whichever currency of the key it is
 *
 * A v4 key orders its two currencies by address. Native USDC is `address(0)` and
 * always `currency0`; an ERC-20 quote such as EURC may be either. Nothing here
 * reads `currency0` as the quote: the amounts are the SDK's `QuoteAmount`s,
 * already oriented and scaled, and where a report names the pair it asks the
 * SDK which side the quote is on.
 *
 * # The spot price comes from a probe, because the SDK has no reader for one
 *
 * `@arcnow/sdk` exposes no pool price — no `slot0`, no `sqrtPriceX96`. Reading
 * the PoolManager's storage here would be exactly the second, unpinned copy of
 * chain code that `src/sdk-port.ts` exists to prevent. So the spot price is the
 * SDK's own quote of a buy too small to move the price ({@link spotProbe}),
 * with both fees taken back out, and every report that shows one says so. The
 * price impact is the order's own fill, fees out, against that.
 *
 * @module
 */

import type { Address } from "viem";
import type { QuoteTokenInfo, TradeBuyQuote, TradeSellQuote } from "@arcnow/sdk";
import {
  Bps,
  minQuoteOutFromQuote,
  minTokensOutFromQuote,
  QuoteAmount,
  Tokens,
  TRADE_FEE_BPS,
  WAD,
} from "@arcnow/sdk";

import { addr, effectivePrice, money, note, price, priceMove, qty, report, section } from "../format.js";
import type { PoolHandle } from "../sdk-port.js";
import { renderPoolError } from "./errors.js";
import { parseQuoteAmount } from "./quote.js";
import type { ToolContext, ToolOutput } from "./schema.js";
import type { Market } from "./venue.js";
import { refuseCurveOnly, routerName, venueMovedText } from "./venue.js";

const BPS = 10_000n;
const LP_FEE_DENOMINATOR = 1_000_000n;

/** The tolerances a quote is shown at, so a floor is a choice and not a guess. */
const TOLERANCES = [50n, 100n, 300n, 1000n];

/**
 * The buy a spot price is read from: a millionth of a whole unit of the quote,
 * or 10,000 of its raw units if that is more.
 *
 * Small enough that it moves no pool's price by anything a report can show.
 * Large enough that the hook and the pool, which charge their fees on RAW
 * units, round by at most one part in ten thousand: for 18-decimal native USDC
 * that is 0.000001 USDC, and for 6-decimal EURC it is 0.01 EURC — a millionth
 * of a EURC is one raw unit, on which a 1% fee floors to nothing.
 */
export function spotProbe(quote: QuoteTokenInfo): QuoteAmount {
  return QuoteAmount.fromRaw(quote, 10n ** BigInt(Math.max(4, quote.decimals - 6)));
}

/** A v4 LP fee, in hundredths of a bip, said both ways. */
export function lpFee(fee: number): string {
  return `${fee / 10_000}% (${fee} hundredths of a bip)`;
}

/** What reaches the pool on a buy: the input after arcnow.io's 1%. */
function afterHookFee(quoteIn: QuoteAmount): bigint {
  return (quoteIn.wad * (BPS - TRADE_FEE_BPS)) / BPS;
}

/** The LP fee on a buy, in the quote: charged on what reaches the pool. */
export function buyLpFee(quoteIn: QuoteAmount, fee: number): QuoteAmount {
  const lp = (afterHookFee(quoteIn) * BigInt(fee)) / LP_FEE_DENOMINATOR;
  return QuoteAmount.fromWad(quoteIn.token, lp);
}

/** The LP fee on a sell, in tokens: charged on the tokens the pool takes in. */
export function sellLpFee(tokensIn: Tokens, fee: number): Tokens {
  return Tokens.fromWad((tokensIn.wad * BigInt(fee)) / LP_FEE_DENOMINATOR);
}

/** The quote per token a buy filled at, with both fees taken back out. */
export function buyFillExFees(
  quoteIn: QuoteAmount,
  tokensOut: Tokens,
  fee: number,
): QuoteAmount | undefined {
  if (tokensOut.wad === 0n) return undefined;
  const swapped = (afterHookFee(quoteIn) * (LP_FEE_DENOMINATOR - BigInt(fee))) / LP_FEE_DENOMINATOR;
  return QuoteAmount.fromWad(quoteIn.token, (swapped * WAD) / tokensOut.wad);
}

/** The quote per token a sell filled at, with both fees taken back out. */
export function sellFillExFees(
  tokensIn: Tokens,
  quoteOut: QuoteAmount,
  fee: number,
): QuoteAmount | undefined {
  const swapped = (tokensIn.wad * (LP_FEE_DENOMINATOR - BigInt(fee))) / LP_FEE_DENOMINATOR;
  if (swapped === 0n) return undefined;
  const gross = (quoteOut.wad * BPS) / (BPS - TRADE_FEE_BPS);
  return QuoteAmount.fromWad(quoteOut.token, (gross * WAD) / swapped);
}

/** The pool's spot price, fees out, from the SDK's quote of {@link spotProbe}. */
export async function poolSpotPrice(
  pool: PoolHandle,
  quote: QuoteTokenInfo,
  fee: number,
): Promise<QuoteAmount | undefined> {
  const probe = spotProbe(quote);
  try {
    const quoted = await pool.quoteBuy(probe);
    return buyFillExFees(probe, quoted.tokensOut, fee);
  } catch {
    return undefined;
  }
}

/**
 * How the quote leaves the buyer: `msg.value` for native USDC, an ERC-20 pull
 * after an exact approval for anything else.
 */
export function buyPaymentLine(amount: QuoteAmount, puller: string): string {
  return amount.token.isNative
    ? `${money(amount)} — as msg.value; native USDC needs no approval and has no ERC-20 leg`
    : `${money(amount)} — pulled by ${puller} from the buyer's ${amount.token.symbol}, with no value `
      + `sent: it needs an exact ERC-20 approval of this amount first — a separate transaction, `
      + "sent by the buying tool only when the existing allowance falls short, never for more, "
      + "and reported";
}

function againstSpot(spot: QuoteAmount | undefined, fill: QuoteAmount | undefined, side: "buy" | "sell"): string {
  return section("against the pool's own price", [
    ["pool spot price", spot === undefined
      ? "could not be read — the probe quote it comes from failed"
      : `${price(spot)} — the pool's marginal price before this order, fees out`],
    ["fill, fees out", fill === undefined ? "n/a" : price(fill)],
    ["price impact", spot === undefined || fill === undefined
      ? "n/a"
      : `${priceMove(spot, fill)} — how far from the spot price this order fills from its `
        + `own size alone (a ${side} fills ${side === "buy" ? "above" : "below"} spot)`],
  ]);
}

function spotNote(quote: QuoteTokenInfo): string {
  return `How the spot price is read: @arcnow/sdk has no reader for a pool's price, so it is the `
    + `SDK's own quote of a ${spotProbe(quote).format()} probe buy with both fees taken back `
    + "out — an order too small to move the price. A pool swap names no referrer and no "
    + "developer: arcnow.io's fee hook pays those two shares of its 1% to the platform recipient.";
}

function curveOnlyNamed(args: { referrer?: string | undefined; developer?: string | undefined }) {
  return (["referrer", "developer"] as const).filter((field) => args[field] !== undefined);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function quotePoolBuy(
  args: { quoteIn: string; referrer?: string | undefined; developer?: string | undefined },
  ctx: ToolContext,
  market: Market,
  symbol: string,
): Promise<ToolOutput> {
  const refused = curveOnlyNamed(args);
  if (refused.length > 0) {
    return { isError: true, text: refuseCurveOnly("arcnow_quote_buy", refused, "quoted") };
  }

  const quoteToken = market.state.quoteToken;
  const quoteIn = parseQuoteAmount(quoteToken, args.quoteIn, "quoteIn");
  const pool = market.trade.pool;
  let quote: TradeBuyQuote;
  try {
    quote = await market.trade.quoteBuy(quoteIn);
  } catch (error) {
    return { isError: true, text: renderPoolError("arcnow_quote_buy", "buy", error) };
  }
  if (quote.venue !== "pool") return { isError: true, text: venueMovedText("arcnow_quote_buy") };

  const key = await pool.key();
  const spot = await poolSpotPrice(pool, quoteToken, key.fee);
  const avg = effectivePrice(quote.quoteIn, quote.tokensOut);
  const fill = buyFillExFees(quote.quoteIn, quote.tokensOut, key.fee);
  const router = routerName(ctx.port.config);

  return {
    text: report(
      `Buy quote — POOL — ${money(quoteIn)} into ${symbol}, in its Uniswap v4 pool`,
      note(`This is a Uniswap v4 pool quote, not a bonding-curve quote. ${symbol} graduated and `
        + "migrated, its curve no longer trades, and this price comes from simulating the real "
        + `swap through arcnow.io's router at ${router} against the pool as it is now.`),
      section("what you pay and get", [
        ["venue", `Uniswap v4 pool, through arcnow.io's router ${router}`],
        ["you send", buyPaymentLine(quote.quoteIn, `arcnow.io's router ${router}`)],
        ["arcnow.io fee", `${money(quote.feeQuote)} — the same flat 1% the curve charged, taken in `
        + `${quoteToken.symbol} by arcnow.io's fee hook inside the swap`],
        ["pool fee", `${lpFee(key.fee)} — Uniswap's LP fee, charged by the pool on top of `
        + `arcnow.io's 1% and kept by its liquidity: about ${money(buyLpFee(quote.quoteIn, key.fee))} `
        + "of this order"],
        ["tokens out", qty(quote.tokensOut, symbol)],
        ["average fill price", avg === undefined
          ? "n/a"
          : `${price(avg)} — everything you pay, both fees in, over everything you get`],
      ]),
      againstSpot(spot, fill, "buy"),
      section("minimum tokens out, by tolerance", TOLERANCES.map((bps) => [
        `${bps} bps (${Number(bps) / 100}%)`,
        qty(minTokensOutFromQuote(quote, Bps.of(bps)), symbol),
      ] as [string, string])),
      note(spotNote(quoteToken)),
      note("This quote is one block old the moment it is returned. Anybody's trade in this pool "
        + "moves it, which is what the minimum-out floor is for."),
    ),
  };
}

export async function quotePoolSell(
  args: {
    tokensIn: string;
    holder?: string | undefined;
    referrer?: string | undefined;
    developer?: string | undefined;
  },
  ctx: ToolContext,
  market: Market,
  symbol: string,
): Promise<ToolOutput> {
  const refused = curveOnlyNamed(args);
  if (refused.length > 0) {
    return { isError: true, text: refuseCurveOnly("arcnow_quote_sell", refused, "quoted") };
  }

  const holder = (args.holder ?? ctx.port.signerAddress) as Address | undefined;
  if (holder === undefined) {
    return {
      isError: true,
      text: report(
        "arcnow_quote_sell: a sell in a Uniswap v4 pool is priced for a particular holder, and "
        + "this call named none and this server has no signing address to default to. Nothing "
        + "was quoted.",
        note("The SDK prices a pool sell by simulating the real swap as that holder. The router "
          + "pulls the tokens with transferFrom; the simulation stands in for the approval but "
          + "deliberately not for the balance, because a price for tokens nobody has is a "
          + "number, not a quote. Call again with `holder` set to an address that actually "
          + "holds at least this many tokens."),
      ),
    };
  }

  const quoteToken = market.state.quoteToken;
  const tokensIn = Tokens.parse(args.tokensIn);
  const pool = market.trade.pool;
  let quote: TradeSellQuote;
  try {
    quote = await market.trade.quoteSell(tokensIn, { from: holder });
  } catch (error) {
    return { isError: true, text: renderPoolError("arcnow_quote_sell", "sell", error) };
  }
  if (quote.venue !== "pool") return { isError: true, text: venueMovedText("arcnow_quote_sell") };

  const [key, approved] = await Promise.all([pool.key(), pool.routerAllowance(holder)]);
  const spot = await poolSpotPrice(pool, quoteToken, key.fee);
  const avg = effectivePrice(quote.quoteOut, quote.tokensIn);
  const fill = sellFillExFees(quote.tokensIn, quote.quoteOut, key.fee);
  const router = routerName(ctx.port.config);

  return {
    text: report(
      `Sell quote — POOL — ${qty(tokensIn, symbol)}, in its Uniswap v4 pool`,
      note(`This is a Uniswap v4 pool quote, not a bonding-curve quote. ${symbol} graduated and `
        + "migrated, its curve no longer trades, and this price comes from simulating the real "
        + `swap as ${addr(holder)} through arcnow.io's router at ${router}.`),
      section("what you give and get", [
        ["venue", `Uniswap v4 pool, through arcnow.io's router ${router}`],
        ["you send", `${qty(quote.tokensIn, symbol)} — pulled by the router, which needs an `
        + "ERC-20 approval first (below)"],
        ["pool fee", `${lpFee(key.fee)} — Uniswap's LP fee, taken by the pool from the tokens `
        + `you sell and kept by its liquidity: about ${qty(sellLpFee(quote.tokensIn, key.fee), symbol)}`],
        ["arcnow.io fee", `${money(quote.feeQuote)} — the same flat 1% the curve charged, taken `
        + `by arcnow.io's fee hook out of the ${quoteToken.symbol} the pool pays`],
        ["you receive", `${money(quote.quoteOut)} — net of both fees`],
        ["average fill price", avg === undefined
          ? "n/a"
          : `${price(avg)} — what you receive, net of both fees, over what you give`],
      ]),
      againstSpot(spot, fill, "sell"),
      section("the approval a pool sell needs", [
        ["spender", `${router} — arcnow.io's v4 router`],
        ["holder", addr(holder)],
        ["approved now", qty(approved, symbol)],
        ["this sell needs", approved.lt(tokensIn)
          ? `an ERC-20 approval of ${qty(tokensIn, symbol)} first — a SEPARATE transaction that `
          + "grants the router the right to move that many tokens. arcnow_sell sends it only "
          + "when told to (approveRouter: true), for exactly the amount sold, and reports it."
          : "nothing more — the existing allowance already covers it"],
      ]),
      section(`minimum ${quoteToken.symbol} out, by tolerance`, TOLERANCES.map((bps) => [
        `${bps} bps (${Number(bps) / 100}%)`,
        money(minQuoteOutFromQuote(quote, Bps.of(bps)).ceilToRepresentable()),
      ] as [string, string])),
      note(spotNote(quoteToken)),
      note("A bonding-curve sell never needed an approval; a pool sell always does, because the "
        + "router has no privileged path. This quote is a snapshot of one block."),
    ),
  };
}
