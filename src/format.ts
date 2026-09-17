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
import type { Bps, CurveParams, NetworkConfig, QuoteTokenInfo, Tokens } from "@arcnow/sdk";
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
 * `arcnow/bonding-curve@3.x.x`, and the SDK prices no other: `r0Wad` is its
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
