/**
 * The operator's spend caps, enforced per quote token and fail-closed.
 *
 * Every write that spends — a launch (its whole `totalCost`, the launch fee
 * plus the initial buy), a buy (its `quoteIn`) — is checked here before
 * anything is built or signed. For an ERC-20 quote the SDK's approve is exactly
 * that spend, so the same check covers it.
 *
 * Three refusals, in order:
 *
 * 1. **A quote the network does not list.** No variable can cap it — caps are
 *    keyed by the network's own quote tokens, by address — so it is refused.
 * 2. **A listed quote with no cap set.** Refused, naming the variable that would
 *    set one. Non-native quotes have no default, so a cap can never be got round
 *    by moving a trade to another quote.
 * 3. **Over a ceiling.** The caller's own stated `maxTotalCost`, then the
 *    operator's cap for that quote.
 *
 * @module
 */

import type { Address } from "viem";
import type { QuoteAmount, QuoteTokenInfo } from "@arcnow/sdk";

import { addr, money, note, report } from "../format.js";
import type { ToolContext } from "./schema.js";

const CAPS_ARE_PER_QUOTE
  = "Every spending write on this server is capped per quote token, by the operator, and a "
    + "quote with no cap is refused rather than left uncapped — so moving a trade to another "
    + "quote can never get round a cap.";

/**
 * Refuse a spend in a quote this server has no cap for. `undefined` when a cap exists.
 * No RPC: the network's quote tokens are configuration.
 */
export function refuseWithoutCap(
  ctx: ToolContext,
  quote: QuoteTokenInfo | { readonly address: Address; readonly symbol?: undefined },
  what: string,
): string | undefined {
  const cap = ctx.config.spendCapFor(quote.address);
  if (cap === undefined) {
    const label = quote.symbol === undefined ? "a quote token" : quote.symbol;
    return report(
      `Refused: ${what} would spend ${label} (${addr(quote.address)}), which is not one of this `
      + "network's quote tokens, so no spend cap can be configured for it. Nothing was sent and "
      + "nothing was signed.",
      note(`${CAPS_ARE_PER_QUOTE} A cap is named by a symbol of the network's own quote tokens `
        + "(the SDK's networks.json, or the operator's ARCNOW_MCP_NETWORK_FILE) and matched by "
        + "address — never by what a token says its own symbol is, so no token can borrow another "
        + "quote's cap. A quote outside that list is never spent from here. Tell the user; "
        + "arcnow_quote_tokens lists the quotes this network knows."),
    );
  }
  if (cap.cap === undefined) {
    const { symbol } = cap.token;
    return report(
      `Refused: ${what} would spend ${symbol}, and this server's operator set no spend cap for `
      + `${symbol}. Nothing was sent and nothing was signed.`,
      note(`${CAPS_ARE_PER_QUOTE} The cap for ${symbol} is ${cap.variable}, in whole ${symbol}, in `
        + "the environment the server is started with: the operator restarts the server with, for "
        + `example, ${cap.variable}=50. It is not an argument and cannot be set from here — tell the `
        + "user that, rather than looking for another quote to trade in."),
    );
  }
  return undefined;
}

/**
 * The two ceilings, checked together, before anything is built: the caller's
 * stated maximum and the operator's cap, both in the spend's own quote.
 *
 * Returns the refusal text, or `undefined` when the spend is allowed.
 */
export function refuseIfOverBudget(
  actual: QuoteAmount,
  statedMax: QuoteAmount,
  ctx: ToolContext,
  what: string,
): string | undefined {
  const uncapped = refuseWithoutCap(ctx, actual.token, what);
  if (uncapped !== undefined) return uncapped;
  if (actual.gt(statedMax)) {
    return report(
      `Refused: ${what} would cost ${money(actual)}, and this call said it should cost at `
      + `most ${money(statedMax)}.`,
      note(
        "Nothing was sent and nothing was signed. The quote is taken inside this call, so "
        + "this is the current cost and not the one you were shown earlier — a price moves as "
        + "people trade, and somebody else's trade between your quote and your order is "
        + "enough to move it. Re-quote, show the new number to the person whose money it is, "
        + "and call again with a ceiling they agreed to. Do not simply raise the ceiling to "
        + "whatever makes the call go through.",
      ),
    );
  }
  const cap = ctx.config.spendCapFor(actual.token.address);
  if (cap?.cap !== undefined && actual.gt(cap.cap)) {
    return report(
      `Refused: ${what} would cost ${money(actual)}, and this server's operator capped any `
      + `single write in ${cap.token.symbol} at ${money(cap.cap)}.`,
      note(
        "Nothing was sent and nothing was signed. This ceiling is not an argument and cannot "
        + `be raised from here — it is ${cap.variable} in the environment the server was started `
        + "with, and changing it means the operator restarting the server on purpose. Tell the "
        + "user that, rather than looking for another way through.",
      ),
    );
  }
  return undefined;
}

/** One quote's cap, said for a report: the amount and its variable, or why there is none. */
export function capText(ctx: { readonly config: ToolContext["config"] }, token: QuoteTokenInfo): string {
  const cap = ctx.config.spendCapFor(token.address);
  if (cap === undefined) {
    return "cannot be set — not one of this network's quote tokens, so every launch or buy in it is "
      + "refused";
  }
  if (cap.cap === undefined) {
    return `NONE — every launch or buy in ${token.symbol} is refused until the operator sets `
      + `${cap.variable}`;
  }
  return `${money(cap.cap)} per write call (${cap.variable})`;
}

/** Every cap on one line: `100 USDC; EURC none (refused)`. */
export function capsSummary(config: ToolContext["config"]): string {
  return config.spendCaps
    .map(({ token, cap }) => (cap === undefined ? `${token.symbol} none (refused)` : money(cap)))
    .join("; ");
}
