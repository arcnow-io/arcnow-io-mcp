/**
 * Turning launch arguments into the SDK's `LaunchParams`.
 *
 * Shared by `arcnow_quote_launch` and `arcnow_launch` on purpose: the quote a
 * user is shown and the transaction that is sent have to be built from the same
 * function, or the quote is describing something slightly different from what
 * happens. The only difference between the two is `minTokensOut`, which a quote
 * does not use and a launch must not omit.
 *
 * **The launch's quote is the initial buy's token.** The SDK has no separate
 * quote field to disagree with it: `initialBuy` is parsed, exactly, in the quote
 * the `quote` argument named, and a zero initial buy is zero of that quote.
 *
 * @module
 */

import type { Address } from "viem";
import type { LaunchParams, QuoteTokenInfo } from "@arcnow/sdk";
import { Tokens } from "@arcnow/sdk";

import { parseQuoteAmount } from "./quote.js";

export interface LaunchArgs {
  readonly name: string;
  readonly symbol: string;
  readonly metadataUri: string;
  readonly initialBuy: string;
  readonly platform?: string | undefined;
  readonly migrator?: string | undefined;
}

export function launchParams(
  args: LaunchArgs,
  quote: QuoteTokenInfo,
  minTokensOut: Tokens = Tokens.ZERO,
): LaunchParams {
  return {
    name: args.name,
    symbol: args.symbol,
    metadataUri: args.metadataUri,
    initialBuy: parseQuoteAmount(quote, args.initialBuy, "initialBuy"),
    minTokensOut,
    ...(args.platform === undefined ? {} : { platform: args.platform as Address }),
    ...(args.migrator === undefined ? {} : { migrator: args.migrator as Address }),
  };
}
