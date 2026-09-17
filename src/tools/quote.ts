/**
 * Amounts in a quote token, and which quote token a launch is in.
 *
 * # An amount is parsed exactly, in its own quote's decimals
 *
 * Every amount a tool takes — `quoteIn`, `initialBuy`, `maxTotalCost` — is a
 * decimal string in the quote the token is priced in, and is parsed with the
 * SDK's `QuoteAmount.parse` in THAT quote's decimals. EURC has 6: `"1.0000001"`
 * is not an amount of EURC, and it is refused, naming the decimals, rather than
 * rounded to something nobody typed. A parsed amount is therefore always a whole
 * number of the quote's raw units, which is what an ERC-20 transfer moves.
 *
 * # A launch names its quote by symbol or address
 *
 * A symbol is looked up in the network's own `quoteTokens` (the SDK's
 * `networks.json`, or `ARCNOW_MCP_NETWORK_FILE`) and nowhere else. An address is
 * taken as given; one the network does not list is metadata the SDK can read,
 * but no spend cap can name it, so a launch in it is refused (see `./spend.ts`).
 *
 * @module
 */

import type { Address } from "viem";
import type { NetworkConfig, QuoteTokenInfo } from "@arcnow/sdk";
import { AmountParseError, findQuoteToken, NATIVE_USDC, QuoteAmount } from "@arcnow/sdk";

import { note, report } from "../format.js";

/** An argument that is not an amount of its quote, or names no quote. The message is the report. */
export class QuoteInputError extends Error {
  override readonly name = "QuoteInputError";
}

/**
 * `QuoteAmount.parse(token, value)`, with a refusal that names the field, the
 * quote and its decimals.
 *
 * @throws {QuoteInputError}
 */
export function parseQuoteAmount(token: QuoteTokenInfo, value: string, field: string): QuoteAmount {
  try {
    return QuoteAmount.parse(token, value);
  } catch (error) {
    if (!(error instanceof AmountParseError)) throw error;
    const [whole = "", fraction = ""] = value.split(".");
    if (fraction.length > token.decimals) {
      const nearest = token.decimals === 0 ? whole : `${whole}.${fraction.slice(0, token.decimals)}`;
      throw new QuoteInputError(report(
        `${field} "${value}" is not an amount of ${token.symbol}: ${token.symbol} has `
        + `${token.decimals} decimals, and this has ${fraction.length} decimal places.`,
        note(`Nothing was quoted and nothing was sent. An amount is read exactly, in the decimals `
          + `of the quote it is in, and never rounded: ${token.symbol} cannot hold a smaller unit `
          + `than 1e-${token.decimals}, so there is no such amount to send. The nearest amount below `
          + `it is "${nearest}"; ask the user which amount they mean rather than choosing one.`),
      ), { cause: error });
    }
    throw new QuoteInputError(report(
      `${field} "${value}" could not be read as an amount of ${token.symbol}.`,
      error.message,
      note("Nothing was quoted and nothing was sent. Amounts are decimal strings in whole units "
        + `of the quote — "25", "1.5" — with at most ${token.decimals} decimals for ${token.symbol}.`),
    ), { cause: error });
  }
}

/** The network's native quote: native USDC. */
export function nativeQuote(config: NetworkConfig): QuoteTokenInfo {
  return config.quoteTokens.find((token) => token.isNative) ?? NATIVE_USDC;
}

/** What a launch's `quote` argument named. */
export type QuoteChoice
  = | { readonly listed: true; readonly token: QuoteTokenInfo }
    | { readonly listed: false; readonly address: Address };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve a `quote` argument — a symbol of the network's quote tokens, or an
 * address — with no RPC. Omitted, it is native USDC.
 *
 * @throws {QuoteInputError} for a symbol the network does not list, or one two of its tokens share.
 */
export function chooseQuote(config: NetworkConfig, raw: string | undefined): QuoteChoice {
  if (raw === undefined) return { listed: true, token: nativeQuote(config) };
  if (ADDRESS.test(raw)) {
    const token = findQuoteToken(config, raw);
    return token === undefined
      ? { listed: false, address: raw.toLowerCase() as Address }
      : { listed: true, token };
  }
  const wanted = raw.toUpperCase();
  const matches = config.quoteTokens.filter((token) => token.symbol.toUpperCase() === wanted);
  const symbols = config.quoteTokens.map((token) => token.symbol).join(", ");
  if (matches.length === 1 && matches[0] !== undefined) return { listed: true, token: matches[0] };
  throw new QuoteInputError(report(
    matches.length === 0
      ? `${raw} is not a quote token of ${config.name}. Its quote tokens are ${symbols}.`
      : `${raw} names ${matches.length} quote tokens of ${config.name}; pass the address instead.`,
    note("Nothing was quoted and nothing was sent. A quote is named by a symbol from this "
      + "network's own quote tokens, or by its address. arcnow_quote_tokens lists them, with "
      + "which ones the quote registry currently accepts for a launch."),
  ));
}
