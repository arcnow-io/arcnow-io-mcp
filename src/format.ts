/**
 * How numbers and addresses reach the model.
 *
 * # Every amount is printed with its own quote token, every time
 *
 * A curve is priced in one quote token for life: native USDC (18 decimals, the
 * gas currency) or an allowlisted ERC-20 such as EURC (6 decimals). An amount
 * is a `QuoteAmount` from the SDK, which carries the token it is denominated
 * in, so a figure is always printed as `1.5 EURC` or `25 USDC` — the symbol of
 * the quote it is actually in, never "USDC" for a EURC amount.
 *
 * On Arc, native USDC is 18-decimal and the USDC ERC-20 predeploy is the same
 * asset at **6**. A bare `1000000` is a dollar under one reading and a
 * millionth of a dollar under the other, which is why nothing here ever emits
 * a bare number for money.
 *
 * # Text, not structured content
 *
 * Every tool returns one readable report. There is no parallel
 * `structuredContent` payload, and that is a choice: two renderings of the same
 * numbers is two places for a unit to be wrong, and only one of them is the one
 * a person reads when they check what the assistant was told. The report
 * carries exact decimal strings, so nothing is lost to rounding on the way.
 *
 * @module
 */

import type { Address } from "viem";
import { getAddress } from "viem";
import type {
  Bps,
  CurveParams,
  FeeConfig,
  FeeSplit,
  NetworkConfig,
  PoolFees,
  QuoteTokenInfo,
  Tokens,
} from "@arcnow/sdk";
import { QuoteAmount, WAD } from "@arcnow/sdk";

/** The zero address, which on Arc is a real account, not a null. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** `123.75 USDC`, `1.5 EURC`: always with the symbol of the quote the amount is in. */
export function money(amount: QuoteAmount): string {
  return amount.format();
}

/** Money plus its raw integers, for anything that has to be exact. */
export function moneyExact(amount: QuoteAmount): string {
  const raw = amount.isRepresentable() ? `, ${amount.toRaw()} raw at ${amount.token.decimals} decimals` : "";
  return `${amount.format()} (${amount.wad} wad${raw})`;
}

export function qty(amount: Tokens, symbol?: string): string {
  return symbol === undefined ? amount.toString() : `${amount.toString()} ${symbol}`;
}

/** A price is the quote **per whole token**; saying so every time is the point. */
export function price(p: QuoteAmount): string {
  return `${p.toString()} ${p.token.symbol} per token`;
}

/**
 * One quote token, said in full: `EURC — ERC-20 0x89b5…, 6 decimals` or
 * `USDC — native (the gas currency, paid as msg.value), 18 decimals`.
 */
export function quoteLine(token: QuoteTokenInfo): string {
  return token.isNative
    ? `${token.symbol} — native, the gas currency, paid as msg.value (${addr(token.address)}), `
    + `${token.decimals} decimals`
    : `${token.symbol} (${token.name}) — ERC-20 at ${addr(token.address)}, ${token.decimals} decimals, `
      + "pulled with an exact ERC-20 approval";
}

/** Checksummed, because that is the form a person pastes back. */
export function addr(value: string): string {
  try {
    return getAddress(value);
  } catch {
    return value;
  }
}

/** A share of the fee, said both ways — the single easiest thing to misread. */
export function share(bps: Bps, tradeFeeBps: Bps): string {
  return `${bps.bps} bps of the fee (${bps.percentOfFee()}% of the fee, `
    + `${bps.percentOfTrade(tradeFeeBps)}% of a trade)`;
}

// ── fees ───────────────────────────────────────────────────────────────────
//
// Two venues, two fee shapes, and every report says which it is showing.
//
// On a CURVE the trade fee is a flat 1% of the trade, split FOUR ways — creator,
// platform, referrer, protocol — on the split the token's platform configured.
// There is no developer share: the earlier stack carried one that nothing used,
// and it fell to the platform. A share whose address is zero at swap time (no
// referrer named) is paid to the platform as well.
//
// In a POOL the trade costs the same 1.00% in all, but as two charges by two
// parties: arcnow.io's fee hook takes 0.80% of the trade in the pool's quote and
// splits it creator / platform / protocol (a pool swap names no referrer), and
// the pool itself keeps a 0.20% LP fee inside its price, which is Uniswap's and
// not arcnow.io's. Every pool figure here is the SDK's `Pool.fees()`, read off
// the hook and the pool key — never a constant of this server.

/** `0.8%` — a rate in basis points OF THE TRADE, as a percentage of the trade. */
export function bpsPercent(bps: Bps): string {
  return `${Number(bps.bps) / 100}%`;
}

/**
 * A v4 LP fee, in hundredths of a bip (pips), said both ways:
 * `0.2% (2000 hundredths of a bip)`.
 */
export function lpFee(pips: number): string {
  return `${pips / 10_000}% (${pips} hundredths of a bip)`;
}

/**
 * What a pool trade costs, in one line, from `Pool.fees()`:
 * `1% of the trade in all — 0.8% (80 bps) taken by arcnow.io's fee hook in EURC,
 * plus 0.2% (2000 hundredths of a bip) the pool keeps as its LP fee; the same
 * 1% the curve charged`.
 */
export function poolFeesLine(fees: PoolFees, quote: QuoteTokenInfo): string {
  return `${bpsPercent(fees.totalBps)} of the trade in all — ${bpsPercent(fees.hookFeeBps)} `
    + `(${fees.hookFeeBps.bps} bps) taken by arcnow.io's fee hook in ${quote.symbol}, plus `
    + `${lpFee(fees.lpFeePips)} the pool keeps as its LP fee, inside its price. Both read off `
    + "the chain: the hook's own feeBps() and the pool key's fee";
}

/** The hook's rate, said for a row: `0.8% of the trade (80 bps), read from the hook`. */
export function hookFeeRate(fees: PoolFees): string {
  return `${bpsPercent(fees.hookFeeBps)} of the trade (${fees.hookFeeBps.bps} bps), read from the hook`;
}

/**
 * Where a curve fee goes: the four parties, each with its amount and the address
 * that receives it. An absent referrer is said to go to the platform, because it
 * does.
 */
export function curveFeeSplitSection(
  fee: QuoteAmount,
  split: FeeSplit,
  referrer: string | undefined,
): string {
  return section(`fee split — where the ${money(fee)} goes, four ways`, [
    ["creator", `${money(split.creatorAmount)}  → ${addr(split.creator)}`],
    ["platform", `${money(split.platformAmount)}  → ${addr(split.platform)} — the residual share, `
    + "plus any share nobody was named for, plus the rounding dust"],
    ["referrer", referrer === undefined
      ? `${money(split.refAmount)}  → no referrer given, so this goes to the platform`
      : `${money(split.refAmount)}  → ${addr(split.ref)}`],
    ["protocol", `${money(split.protocolAmount)}  → ${addr(split.protocol)}`],
    ["developer", "none — the fee has four parties; there is no developer share"],
  ]);
}

/**
 * How a pool's hook splits its 0.80%: three parties, read off the hook. A pool
 * swap names no referrer, so its share is stated as zero rather than omitted.
 */
export function poolFeeSplitSection(fees: PoolFees): string {
  const { split } = fees;
  const hook = fees.hookFeeBps;
  return section(`how the fee hook splits its ${bpsPercent(hook)} — read from the hook`, [
    ["creator", share(split.creatorShareBps, hook)],
    ["platform", `${share(split.platformShareBps, hook)}  → ${addr(split.platformRecipient)}`],
    ["protocol", `${share(split.protocolShareBps, hook)}  → ${addr(split.protocolRecipient)}`],
    ["referrer", `${split.refShareBps.bps} bps — a pool swap names no referrer, so there is no `
    + "referral share here; the LP fee is the pool's own and is not split by anyone"],
  ]);
}

/** A platform's four-way curve split, one row per party, every share both ways. */
export function curveSplitRows(config: FeeConfig, tradeFee: Bps): [string, string][] {
  return [
    ["creator", share(config.creatorShareBps, tradeFee)],
    ["referrer", `${share(config.refShareBps, tradeFee)} — paid to the platform when a trade `
    + "names no referrer"],
    ["protocol", `${share(config.protocolShareBps, tradeFee)} — protocol-controlled; no platform `
    + "sets it"],
    ["platform", `${share(config.platformShareBps, tradeFee)} — the RESIDUAL: 10000 minus the `
    + "three above, never an input anywhere in the contracts"],
  ];
}

/** Graduation progress. `progressBps` is out of 10,000, not out of 100. */
export function progress(bps: Bps): string {
  const percent = Number(bps.bps) / 100;
  return `${percent.toFixed(2)}% (${bps.bps} / 10000 bps)`;
}

/**
 * The average price a whole order actually filled at.
 *
 * Not the same number as `spotPrice`, which is the marginal price of the next
 * infinitesimal token. The curve integrates price across an order, so a buyer
 * pays a rising price over their own trade and this is what they paid.
 */
export function effectivePrice(spent: QuoteAmount, received: Tokens): QuoteAmount | undefined {
  if (received.wad === 0n) return undefined;
  return QuoteAmount.fromWad(spent.token, (spent.wad * WAD) / received.wad);
}

/** Percentage difference between two prices in the same quote, as a signed string. */
export function priceMove(from: QuoteAmount, to: QuoteAmount): string {
  if (from.wad === 0n) return "n/a (the curve had no price to move from)";
  const deltaBps = ((to.wad - from.wad) * 10_000n) / from.wad;
  const percent = Number(deltaBps) / 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(4)}%`;
}

/**
 * Which venue a migrator address is, by asking the deployment rather than
 * assuming. A token graduates to the migrator **its own curve snapshotted at
 * launch**, which need not be the one this network would choose today.
 */
export function venueOf(migrator: Address, config: NetworkConfig): string {
  const known: [Address | undefined, string][] = [
    [config.contracts.v4Migrator, "Uniswap v4"],
    [config.contracts.v3Migrator, "Uniswap v3"],
    [config.contracts.v2Migrator, "Uniswap v2"],
    [config.contracts.escrowMigrator, "escrow (custodial)"],
  ];
  const lower = migrator.toLowerCase();
  for (const [address, name] of known) {
    if (address !== undefined && address.toLowerCase() === lower) return name;
  }
  if (migrator.toLowerCase() === ZERO_ADDRESS) {
    return "none — the zero address, which on Arc is a real account and not a null";
  }
  return "an address this deployment's preset does not name — verify it before trusting it";
}

// ── the curve ──────────────────────────────────────────────────────────────

/**
 * A curve's immutable parameters. arcnow.io has one curve, the constant-product
 * `arcnow/bonding-curve@4.x.x`, and the SDK prices no other: `r0Wad` is its
 * virtual quote reserve at launch, in 18-decimal WAD of its quote token, and
 * `y0Wad` its virtual token reserve at launch.
 */
export function curveParamsLine(params: CurveParams, quote: QuoteTokenInfo): string {
  return `r0Wad ${params.r0Wad} (the virtual ${quote.symbol} reserve at launch, in WAD), `
    + `y0Wad ${params.y0Wad} (the virtual token reserve at launch) — immutable`;
}

/** A titled block of `label  value` lines. */
export function section(title: string, rows: readonly (readonly [string, string])[]): string {
  const width = rows.reduce((w, [label]) => Math.max(w, label.length), 0);
  const body = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n");
  return `${title}\n${body}`;
}

/** Joins sections with a blank line, dropping the ones that had nothing to say. */
export function report(...parts: readonly (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined && p !== "").join("\n\n");
}

/** A paragraph the model is meant to act on, set apart from the figures. */
export function note(text: string): string {
  return wrap(text, 88);
}

function wrap(text: string, width: number): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
