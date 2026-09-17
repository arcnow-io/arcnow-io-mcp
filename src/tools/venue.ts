/**
 * Where a token trades, and what a tool has to refuse because of it.
 *
 * A token's market moves exactly once, irreversibly, in the middle of its life.
 * Before graduation it is its bonding curve. After graduation **and
 * migration** it is a Uniswap v4 pool, reached only through arcnow.io's router.
 * And in between there is a third state that is easy to miss and expensive to
 * misreport: **graduated but never migrated**, where the curve has stopped for
 * good and no pool exists, so the token trades nowhere at all until somebody
 * runs the permissionless `migrate()`.
 *
 * # The venue is the SDK's answer, not this server's
 *
 * `client.trade(token).venue()` decides curve or pool, and every buy and sell
 * this server sends goes through that same handle. The curve's own state is
 * read only to tell "on the curve" apart from "stranded", which the SDK's venue
 * cannot: a stranded token's venue is still `"curve"`, and a curve that has
 * graduated reverts on every trade.
 *
 * # Parameters that do not apply are refused, never dropped
 *
 * The two venues take different arguments. A curve pays `msg.sender` and has
 * no recipient; a pool swap has no referrer or developer and cannot graduate
 * anything, so a gas limit guards nothing there. The SDK refuses each of these
 * on the wrong venue, and so does this server — earlier, before anything is
 * quoted or sent, and in words that say why. A parameter silently ignored is a
 * referrer promised a share the chain never saw, or a payout sent to an address
 * nobody named.
 *
 * @module
 */

import type { Address } from "viem";
import type { CurveState, NetworkConfig } from "@arcnow/sdk";

import { addr, note, report, ZERO_ADDRESS } from "../format.js";
import type { CurveHandle, TradeHandle } from "../sdk-port.js";
import { resolveCurve } from "./resolve.js";
import type { ToolContext } from "./schema.js";

/** Where a token can be traded right now. */
export type MarketVenue = "curve" | "pool" | "stranded";

export interface Market {
  readonly curve: CurveHandle;
  readonly state: CurveState;
  /** True when the caller gave the token address and it was followed to the curve. */
  readonly viaToken: boolean;
  /** `client.trade(state.token)`: what every quote and trade goes through. */
  readonly trade: TradeHandle;
  readonly venue: MarketVenue;
}

/**
 * Resolve a token-or-curve address to its curve, its trade handle, and where it
 * trades now.
 */
export async function resolveMarket(ctx: ToolContext, address: Address): Promise<Market> {
  const resolved = await resolveCurve(ctx.port, address);
  const trade = ctx.port.trade(resolved.state.token);
  const venue = await trade.venue();
  if (venue === "pool") return { ...resolved, trade, venue: "pool" };
  return { ...resolved, trade, venue: resolved.state.graduated ? "stranded" : "curve" };
}

/** The network's v4 router, or `undefined` — and on Arc the zero address is a real account. */
export function configuredRouter(config: NetworkConfig): Address | undefined {
  const router = config.contracts.v4Router;
  if (router === undefined || router.toLowerCase() === ZERO_ADDRESS) return undefined;
  return router;
}

export function routerName(config: NetworkConfig): string {
  const router = configuredRouter(config);
  return router === undefined ? "(no v4 router configured)" : addr(router);
}

/** The refusal for a token that graduated and never migrated. */
export function strandedText(tool: string): string {
  return report(
    `${tool}: this token has GRADUATED but has NOT MIGRATED, so it is not tradeable anywhere.`,
    note(
      "Its bonding curve stopped trading permanently when it reached its target, and its "
      + "Uniswap v4 pool was never created — the migration that should have run inside the "
      + "graduating buy ran out of gas and was caught, which happens with no revert and no "
      + "error. Until somebody calls migrate() there is no market to quote, buy or sell in. "
      + "migrate() is permissionless and costs only gas: on this server it is arcnow_migrate, "
      + "available when the operator has enabled writes. Once it has run, the token trades in "
      + "its pool and this tool routes there. Nothing was quoted and nothing was sent.",
    ),
  );
}

/** Refuse `referrer`, `developer` or `gasLimit` on a token that trades in its pool. */
export function refuseCurveOnly(
  tool: string,
  fields: readonly string[],
  nothing: "sent" | "quoted",
): string {
  const list = fields.join(" and ");
  const one = fields.length === 1;
  return report(
    `Refused: ${list} ${one ? "is a curve-only parameter" : "are curve-only parameters"}, and `
    + "this token has graduated — it trades in its Uniswap v4 pool, through arcnow.io's "
    + `router. Nothing was ${nothing}.`,
    note(
      "A pool swap has no argument for a referrer or a developer: arcnow.io's fee hook pays "
      + "those two shares of its 1% to the platform recipient, deliberately, because a hook "
      + "that took them from the trade would let any trader name themselves the referrer and "
      + "skim the share. And gasLimit guards a bonding curve's graduation, which a pool buy "
      + `cannot trigger. ${list} ${one ? "is" : "are"} refused rather than ignored, so that `
      + "nobody is told a share was credited, or a limit was set, that the chain was never "
      + `asked for. Call ${tool} again without ${one ? "it" : "them"}.`,
    ),
  );
}

/** Refuse `recipient` on a token still on its curve. */
export function refusePoolOnlyRecipient(tool: string): string {
  return report(
    "Refused: recipient is a pool-only parameter, and this token is still on its bonding "
    + "curve. Nothing was sent.",
    note(
      "A bonding-curve trade always pays msg.sender — the signing address — and has no "
      + "recipient argument anywhere in it, so there is no way to honour one. It is refused "
      + "rather than ignored, because a trade that paid somebody other than the address named "
      + `is the worst possible way to find that out. Call ${tool} again without recipient and `
      + "move the proceeds afterwards; once the token graduates and migrates, its pool trades "
      + "can pay another address.",
    ),
  );
}

/** Refuse `approveRouter` on a curve sell, which needs no approval at all. */
export function refuseCurveApproval(): string {
  return report(
    "Refused: approveRouter is a pool-only parameter, and this token is still on its bonding "
    + "curve. Nothing was sent and nothing was approved.",
    note(
      "A bonding-curve sell needs no approval, ever: the curve pulls the tokens through a "
      + "privileged path that reads no allowance at all. This server will not grant spending "
      + "rights that nothing is going to use. Call arcnow_sell again without approveRouter.",
    ),
  );
}

/** The venue changed between the read and the quote: the token migrated mid-call. */
export function venueMovedText(tool: string): string {
  return report(
    `${tool}: this token's venue changed while the call was running — it was on one venue `
    + "when it was read and on the other when it was quoted. Nothing was sent.",
    note("A token moves from its curve to its pool once, at migration. Call again and it will "
      + "be quoted where it trades now."),
  );
}

/** "0x… (the signing address)", or the same address flagged as somebody else's. */
export function payee(recipient: Address, signer: Address | undefined): string {
  return signer !== undefined && recipient.toLowerCase() === signer.toLowerCase()
    ? `${addr(recipient)} (the signing address)`
    : `${addr(recipient)} — NOT the signing address. Whatever reaches a wrong address is gone.`;
}
