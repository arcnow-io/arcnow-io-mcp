/**
 * The write tools: everything that can cost somebody something.
 *
 * # What guards these, in order
 *
 * 1. **The operator's opt-in.** These are not published at all unless the
 *    process was started with `--allow-writes` and a key in the environment.
 *    A model cannot turn them on, and asking for a key will not help it: see
 *    `config.ts`.
 * 2. **The operator's ceilings.** One per quote token — `ARCNOW_MCP_MAX_SPEND_USDC`
 *    for native USDC, `ARCNOW_MCP_MAX_SPEND_<SYMBOL>` for each other quote, in its
 *    own units — bound every single call, whatever an argument says. A quote with
 *    no cap is refused outright. See `./spend.ts`.
 * 3. **The caller's stated ceiling.** Every spending tool requires
 *    `maxTotalCost`, in the token's quote: the most the caller believes this call will cost. A
 *    fresh quote is taken inside the call and compared against it, so a quote
 *    that went stale between being shown to a person and being acted on is
 *    caught, and so is a model that was talked into a bigger number than the
 *    conversation agreed to.
 * 4. **Nothing that does not apply.** A buy or sell goes wherever the token
 *    trades — its curve or its pool, as `client.trade(token)` decides — and a
 *    parameter the venue has no notion of is refused before anything is
 *    quoted or sent, never silently dropped. See `./venue.ts`.
 * 5. **The report.** Every one of these states the exact cost and the exact,
 *    permanent effect before it sends anything, and says afterwards what
 *    actually happened — including the two things about graduation that are
 *    invisible from a receipt.
 *
 * # The one write here that grants rights rather than spending money
 *
 * A sell in a Uniswap v4 pool needs an ERC-20 approval to the router first: a
 * separate transaction giving the router the right to move the seller's
 * tokens. `arcnow_sell` never sends one unless the call says
 * `approveRouter: true`; never for more than the amount being sold; never when
 * the existing allowance already covers the sale; and always reports it —
 * token, owner, spender, amount, transaction, the allowance left afterwards —
 * including when the sell that followed it then failed.
 *
 * None of that makes an assistant trustworthy with money. It makes the blast
 * radius a number somebody chose.
 *
 * @module
 */

import type { Address, Hash } from "viem";
import type {
  QuoteAmount,
  Tokens as TokensType,
  TradeBuyQuote,
  TradeBuyResult,
  TradeSellQuote,
  TradeSellResult,
} from "@arcnow/sdk";
import {
  Bps,
  CurveTemplate,
  Deadline,
  GRADUATION_GAS_FLOOR,
  GRADUATION_GAS_LIMIT,
  minQuoteOutFromQuote,
  minTokensOutFromQuote,
  platformShareBps,
  Tokens,
  TRADE_FEE_BPS,
  validateNewPlatform,
} from "@arcnow/sdk";

import {
  addr,
  effectivePrice,
  money,
  note,
  price,
  progress,
  qty,
  quoteLine,
  report,
  section,
  share,
  venueOf,
  ZERO_ADDRESS,
} from "../format.js";
import {
  addressArg,
  decimalArg,
  defineTool,
  intArg,
  maxCostArg,
  metadataUriArg,
  slippageArg,
  textArg,
  z,
} from "./schema.js";
import type { AnyTool, ToolContext, ToolOutput } from "./schema.js";
import { renderError, renderPoolError } from "./errors.js";
import { launchParams } from "./launch-params.js";
import { lpFee } from "./pool.js";
import { chooseQuote, parseQuoteAmount } from "./quote.js";
import { GRADUATING_BUY_WARNING, quoteArg } from "./read.js";
import { refuseIfOverBudget, refuseWithoutCap } from "./spend.js";
import { resolveCurve } from "./resolve.js";
import type { Market } from "./venue.js";
import {
  payee,
  refuseCurveApproval,
  refuseCurveOnly,
  refusePoolOnlyRecipient,
  resolveMarket,
  routerName,
  strandedText,
  venueMovedText,
} from "./venue.js";

const TRADE_FEE = Bps.of(TRADE_FEE_BPS);

// GRADUATION_GAS_LIMIT (8,000,000) and GRADUATION_GAS_FLOOR (6,200,000) are the
// SDK's own since sdk#2, which gives a graduating launch the same explicit
// limit. One copy of the number that decides whether a market is created.

function deadlineArg() {
  return intArg(1, 60, 5,
    "Minutes until the transaction may no longer be executed. Five is the sensible default. "
    + "A transaction with no deadline can be held back and executed at a much later price, "
    + "on a curve or in a pool alike.");
}

/** arcnow.io's 1% as a pool trade's receipt records it, including a trade too small to charge. */
function poolFeeTaken(fee: QuoteAmount): string {
  if (fee.isZero()) {
    return "none — this trade was too small for arcnow.io's fee hook to charge: its 1% floors "
      + "to zero, and the receipt carries no fee log";
  }
  return `${money(fee)} — the 1% arcnow.io's fee hook took, from its own HookFeeTaken log in the `
    + "receipt; accrued by the hook as a PoolManager claim, and paid out to the fee recipients "
    + "at the start of a later swap";
}

/**
 * Fees from EARLIER trades that this swap paid out: the hook's `FeesDistributed`
 * logs for the pool. Never part of the trader's fill.
 */
function earlierFeesPaidOut(distributed: QuoteAmount): string {
  if (distributed.isZero()) return "none — nothing accrued by earlier trades was waiting";
  return `${money(distributed)} — fees earlier trades accrued, paid to the fee recipients by the `
    + "fee hook at the start of this swap. It moved the hook's claim, not your money, and is not "
    + "part of your fill";
}

/**
 * The ERC-20 approve an ERC-20 spend needed: sent (with its transaction) or not.
 * `undefined` for native USDC, which is msg.value and has no approval at all.
 */
function quoteApprovalSection(
  amount: QuoteAmount,
  spender: string,
  hash: Hash | undefined,
): string | undefined {
  if (amount.token.isNative) return undefined;
  const { symbol } = amount.token;
  return section(`${symbol} approval`, hash === undefined
    ? [["approve", `none sent — the existing ${symbol} allowance to ${spender} already covered `
    + `${money(amount)}, so no approval transaction was needed`]]
    : [
        ["approve", `SENT first, as its own transaction: exactly ${money(amount)} to ${spender} — `
        + "the spend itself, never unlimited, and used up by it"],
        ["transaction", hash],
      ]);
}

/** The "gas limit sent" row of a curve buy: what went out, and who chose it. */
function gasLimitSentLine(
  erc20: boolean,
  graduates: boolean,
  caller: bigint | undefined,
  sent: bigint | undefined,
): string {
  if (sent === undefined) {
    return erc20
      ? "estimated by the node, with the SDK's headroom for the ERC-20 fee-share transfers added "
      + "on top — max(20%, 150,000) more (this buy did not graduate the curve)"
      : "estimated by the node (this buy did not graduate the curve)";
  }
  if (erc20 && !graduates) {
    return `at least ${sent}, raised by the SDK to the node's estimate plus max(20%, 150,000) if `
      + "that is higher; a higher limit is kept — unused gas is not charged";
  }
  if (erc20 && caller !== undefined && caller < sent) {
    return `${sent}, explicitly — the ${caller} given was raised to GRADUATION_GAS_LIMIT so the `
      + "migration can run; unused gas is not charged";
  }
  return `${sent}, explicitly — unused gas is not charged`;
}

/**
 * The "gas limit sent" row of a pool swap. A native pool swap goes out at the
 * node's estimate. An ERC-20 one gets the SDK's pool headroom, max(20%, 400,000):
 * more than a curve trade's, because the estimate can miss the fee hook paying out
 * an accrual that a front-running swap created, and each ERC-20 share it pushes
 * needs 111,587 gas left before it (contracts security review L-1).
 */
function poolSwapGasLine(native: boolean, side: "buy" | "sell"): string {
  return native
    ? `estimated by the node — a pool ${side} cannot graduate anything, so an estimate is safe here`
    : "estimated by the node, plus the SDK's headroom for a pool swap — max(20%, 400,000) more, "
      + "because the fee hook may pay out earlier fees in ERC-20 shares during the swap, each "
      + "needing gas an estimate can miss";
}

/** How a spend left the wallet, in a result: msg.value, or an ERC-20 pull by `puller`. */
function spentLine(amount: QuoteAmount, puller: string): string {
  return amount.token.isNative
    ? `${money(amount)} — as msg.value`
    : `${money(amount)} — pulled by ${puller}; the transaction carried no value`;
}

/** The SDK sent the trade to the other venue: the token migrated between quote and send. */
function sentElsewhere(tool: string, venue: string, hash: string): string {
  return report(
    `${tool}: the SDK sent this trade to the token's ${venue}, not the venue it was quoted `
    + `on — the token migrated between the quote and the send. Transaction ${hash}.`,
    note("The minimum-out floor from the quote still bound the fill. Read the result back with "
      + "arcnow_token and the holder's balance rather than trusting any figure from here."),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const launch = defineTool({
  name: "arcnow_launch",
  title: "Launch a new token (IRREVERSIBLE)",
  access: "write",
  destructive: true,
  description:
    "Launch a new token with its bonding curve. THIS SPENDS REAL MONEY AND CANNOT BE UNDONE.\n\n"
    + "What becomes permanent the moment this transaction mines, and can never be changed by "
    + "anyone — not the creator, not the platform, not arcnow.io: the name, the symbol, the "
    + "metadata URI, the total supply, the curve's shape and graduation target, and the venue "
    + "the token will graduate to. There is no setter for any of them. There is no admin key "
    + "that can fix a typo in the symbol. A token launched with the wrong name is wrong "
    + "forever and the only remedy is to launch another one and spend the fee again.\n\n"
    + "THE QUOTE is permanent too: `quote` (native USDC by default, or an ERC-20 such as EURC, by "
    + "symbol or address) prices the token for life. What it costs: a flat launch fee plus "
    + "whatever initial buy you specify, both in that quote, and the initial buy pays the "
    + "ordinary 1% trade fee on top — there is no fee-free entry into a curve. Native USDC is "
    + "sent as the exact msg.value; an ERC-20 is pulled by the launchpad, after an approve of "
    + "exactly the total, sent only when the allowance falls short and reported.\n\n"
    + "SPEND CAPS ARE PER QUOTE: the total is checked against the operator's cap for that quote "
    + "(ARCNOW_MCP_MAX_SPEND_USDC, or ARCNOW_MCP_MAX_SPEND_<SYMBOL>), and a quote with no cap — "
    + "or one this network does not list — is refused with nothing sent.\n\n"
    + "Call arcnow_quote_launch first, show the total and the permanent parameters to the "
    + "person whose money this is, and get their agreement to the specific name, symbol and "
    + "quote before calling this. Set maxTotalCost from the figure they agreed to.",
  input: {
    name: textArg(64, "The token's name. PERMANENT. Check the spelling with the user."),
    symbol: textArg(16, "The token's ticker. PERMANENT. Check the spelling with the user."),
    metadataUri: metadataUriArg(),
    initialBuy: decimalArg(
      "How much of the launch's quote to spend buying your own token in the same transaction, "
      + "as a string in whole units, with no more decimals than the quote has. \"0\" is allowed "
      + "and means launching without taking a position."),
    quote: quoteArg(),
    slippageBps: slippageArg(),
    maxTotalCost: maxCostArg("the whole launch — launch fee plus initial buy"),
    acknowledgeIrreversible: z.literal(true).describe(
      "Must be true. By setting it you assert that the user has been shown the total cost "
      + "and the permanent parameters — name, symbol, supply, curve, graduation venue — and "
      + "has agreed to those exact values. This is the one action on this server that cannot "
      + "be undone or adjusted afterwards in any way."),
    platform: addressArg(
      "Optional: the PlatformConfig to launch under. Defaults to arcnow.io's own.").optional(),
    migrator: addressArg(
      "Optional: the graduation venue, snapshotted into the curve and immutable thereafter. "
      + "Defaults to the platform's default, which is what almost every launch uses.").optional(),
  },
  async run(args, ctx) {
    const what = `launching ${args.symbol}`;
    // The quote and its cap first, before anything is read: a quote with no cap
    // is refused whatever it would cost, and one the network does not list is
    // refused without asking the chain anything about it.
    const choice = chooseQuote(ctx.port.config, args.quote);
    if (!choice.listed) {
      return { isError: true, text: refuseWithoutCap(ctx, { address: choice.address }, what) ?? "" };
    }
    const token = choice.token;
    const uncapped = refuseWithoutCap(ctx, token, what);
    if (uncapped !== undefined) return { isError: true, text: uncapped };

    const statedMax = parseQuoteAmount(token, args.maxTotalCost, "maxTotalCost");
    const quoteParams = launchParams(args, token);
    const quote = await ctx.port.launchpad.quoteLaunch(quoteParams);

    const refusal = refuseIfOverBudget(quote.totalCost, statedMax, ctx, what);
    if (refusal !== undefined) return { isError: true, text: refusal };

    const minTokensOut = minTokensOutFromQuote(quote, Bps.of(BigInt(args.slippageBps)));
    const launchpad = ctx.port.launchpad.address;
    let result;
    try {
      result = await ctx.port.launchpad.launch(launchParams(args, token, minTokensOut));
    } catch (error) {
      if (token.isNative || ctx.port.signerAddress === undefined) throw error;
      return { isError: true, text: await launchFailedAfterApprove(ctx, token, launchpad, error) };
    }
    const state = await ctx.port.curve(result.curve).state().catch(() => undefined);

    return {
      text: report(
        `Launched ${args.name} (${args.symbol}).`,
        section("what now exists, permanently", [
          ["token", addr(result.token)],
          ["curve", addr(result.curve)],
          ["creator", addr(ctx.port.signerAddress ?? ZERO_ADDRESS)],
          ["name / symbol", `${args.name} / ${args.symbol} — no setter exists for either`],
          ["graduation venue", state === undefined
            ? "(read it back with arcnow_token)"
            : `${addr(state.migrator)} — ${venueOf(state.migrator, ctx.port.config)}, `
              + "snapshotted at launch and immutable"],
        ]),
        section("what it cost", [
          ["total", `${money(quote.totalCost)} — exactly, ${token.isNative
            ? "sent as msg.value, as the launchpad requires"
            : "pulled by the launchpad; the launch transaction carried no value"}`],
          ["  launch fee", money(quote.launchFee)],
          ["  of which fee", `${money(quote.tradeFee)} on the initial buy`],
          ["quote", `${quoteLine(token)} — this token is priced in it for life`],
          ["tokens received", qty(result.tokensOut, args.symbol)],
          ["floor you set", `${qty(minTokensOut, args.symbol)} (${args.slippageBps} bps)`],
          ["transaction", result.txHash],
        ]),
        quoteApprovalSection(quote.totalCost, `the launchpad ${addr(launchpad)}`, result.approvalTxHash),
        result.graduated
          ? section("graduation", [
              ["graduated at launch", "YES — the initial buy filled the curve, so trading on it "
              + "is already over. The SDK sent the launch with an explicit gas limit for the "
              + "migration."],
              ["migrated here", result.migratedInThisTransaction
                ? "YES — the pool was created in the launch transaction; the token trades in it, "
                + "and the quote and trade tools route there"
                : "NO — the pool was not created in this transaction. The token has no market "
                  + "until somebody migrates it; migrate() is permissionless, and arcnow_migrate "
                  + "does it for the cost of gas."],
              ["instant migration", result.instantMigrationFailed
                ? "FAILED and was caught — the curve logged InstantMigrationFailed"
                : "did not fail"],
            ])
          : undefined,
        state === undefined
          ? undefined
          : section("the curve now", [
              ["price", price(state.spotPrice)],
              ["raised", `${money(state.realReserve)} of ${money(state.target)}`],
              ["progress", progress(state.progressBps)],
            ]),
        note(
          "Anyone can now buy this token. Nothing about it can be changed. If the name or "
          + "symbol is wrong, say so plainly rather than looking for a way to edit it: there "
          + "is none, and the only remedy is another launch and another fee.",
        ),
      ),
    };
  },
});

/**
 * An ERC-20 launch that failed after the SDK may already have approved the
 * launchpad. The SDK's error does not carry the approve's hash, so the standing
 * allowance is read back — one read, on this failure path only — and disclosed.
 */
async function launchFailedAfterApprove(
  ctx: ToolContext,
  token: QuoteAmount["token"],
  launchpad: Address,
  error: unknown,
): Promise<string> {
  const owner = ctx.port.signerAddress as Address;
  const state = await ctx.port.quoteSpendState(token, owner, launchpad).catch(() => undefined);
  const allowance = state?.allowance;
  return report(
    `arcnow_launch: the launch in ${token.symbol} did not go through.`,
    renderError("arcnow_launch", error),
    note(allowance === undefined
      ? `An ERC-20 launch approves the launchpad for the total before it launches, and the ${token.symbol} `
      + `allowance to the launchpad could not be read back afterwards. Check it before trying `
      + "again: an approve that went through still stands."
      : `An ERC-20 launch approves the launchpad for the total before it launches. The `
        + `${token.symbol} allowance to the launchpad now stands at ${money(allowance)}: if an approve `
        + "went through before the launch failed, it still stands, and the launchpad may pull up to "
        + "that much until a launch uses it or another approve replaces it. Nothing else was sent. "
        + "Tell the user. Calling arcnow_launch again uses this allowance and does not approve twice."),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface BuyArgs {
  quoteIn: string;
  slippageBps: number;
  maxTotalCost: string;
  deadlineMinutes: number;
  referrer?: string | undefined;
  developer?: string | undefined;
  gasLimit?: number | undefined;
  recipient?: string | undefined;
}

const buy = defineTool({
  name: "arcnow_buy",
  title: "Buy a token (spends USDC)",
  access: "write",
  description:
    "Buy a token wherever it currently trades — its bonding curve before graduation, its "
    + "Uniswap v4 pool after migration — through the SDK's client.trade(token), which decides "
    + "the venue. SPENDS REAL MONEY, in the token's own QUOTE — native USDC, or the ERC-20 such as "
    + "EURC it launched in (arcnow_token names it); quoteIn and maxTotalCost are amounts of that "
    + "quote.\n\n"
    + "A fresh quote is taken inside this call, on whichever venue the token is on, and "
    + "checked against maxTotalCost and the operator's cap for that quote before anything is "
    + "signed; the minimum-tokens-out floor is computed from that quote and your slippage "
    + "tolerance. SPEND CAPS ARE PER QUOTE: ARCNOW_MCP_MAX_SPEND_USDC for native USDC, "
    + "ARCNOW_MCP_MAX_SPEND_<SYMBOL> for each other quote, and a quote with no cap is refused.\n\n"
    + "NATIVE USDC is the transaction's value and needs no approval. AN ERC-20 QUOTE is pulled by "
    + "the curve or the router: an approve of EXACTLY quoteIn is sent first, only when the "
    + "allowance falls short, and the result reports it — or says none was needed.\n\n"
    + "ON A CURVE: if the quote shows this buy fills the curve, this tool sends an explicit "
    + "8,000,000 gas limit rather than letting the node estimate one. That is not tuning. An "
    + "estimate finds the lowest limit at which the transaction still SUCCEEDS, and a "
    + "graduating buy succeeds even when the migration it triggers runs out of gas and is "
    + "caught — so an estimated limit silently guarantees the token graduates with no market. "
    + "The result says whether the pool was actually created in this transaction, which is a "
    + "different question from whether the curve graduated.\n\n"
    + "IN A POOL (the token graduated and migrated): the buy goes through arcnow.io's v4 "
    + "router. arcnow.io's 1% is taken in the quote by its fee hook and the pool charges its own "
    + "LP fee on top; the result reports both. gasLimit, referrer and developer are "
    + "curve-only and are REFUSED here rather than ignored — a pool swap has no referrer or "
    + "developer and cannot graduate anything. recipient is pool-only: it sends the tokens "
    + "to another address, and is refused on a curve.\n\n"
    + "A token that graduated but never migrated has no market at all; this refuses and names "
    + "arcnow_migrate. A buy is not irreversible the way a launch is — the tokens can be sold "
    + "back, at whatever the price is then.",
  input: {
    address: addressArg("The curve address, or the token address. Either works."),
    quoteIn: decimalArg(
      "How much of the token's quote to spend, as a string in whole units — native USDC (18 "
      + "decimals) or the ERC-20 the token is priced in, such as EURC (6). Read exactly in that "
      + "quote's decimals: more decimal places than it has is refused, never rounded."),
    slippageBps: slippageArg(),
    maxTotalCost: maxCostArg("this buy"),
    deadlineMinutes: deadlineArg(),
    referrer: addressArg(
      "CURVE ONLY: credited with the referral share of the fee. Refused for a token in its "
      + "pool: a pool swap has no referrer, and that share goes to the platform.").optional(),
    developer: addressArg(
      "CURVE ONLY: credited with the developer share of the fee. Refused for a token in its "
      + "pool, for the same reason.").optional(),
    gasLimit: z.number().int().min(100_000).max(30_000_000).optional().describe(
      "CURVE ONLY. Optional override for the gas limit. Leave it out: this server already "
      + "sends 8,000,000 on a curve buy it can see will graduate and lets the node estimate "
      + "otherwise. FOR AN ERC-20 QUOTE a limit set here is raised to a safe minimum, never "
      + "refused: the node's estimate plus max(20%, 150,000) for the fee-share transfers, or "
      + "8,000,000 when the buy graduates the curve. A higher limit is kept. For native USDC it "
      + "is sent as given, and a value below 6,200,000 on a graduating buy is REFUSED, because the "
      + "migration would be starved and the failure would be silent. Refused for a token in "
      + "its pool, whose buy cannot graduate anything."),
    recipient: addressArg(
      "POOL ONLY: who receives the tokens. Defaults to the signing address. Refused for a "
      + "token still on its bonding curve, which always pays the sender. If it is not the "
      + "user's own address, check it with them: tokens sent to a wrong address are "
      + "gone.").optional(),
  },
  async run(args, ctx) {
    const market = await resolveMarket(ctx, args.address as Address);
    if (market.venue === "stranded") return { isError: true, text: strandedText("arcnow_buy") };

    if (market.venue === "pool") {
      const refused = (["gasLimit", "referrer", "developer"] as const)
        .filter((field) => args[field] !== undefined);
      if (refused.length > 0) {
        return { isError: true, text: refuseCurveOnly("arcnow_buy", refused, "sent") };
      }
    } else if (args.recipient !== undefined) {
      return { isError: true, text: refusePoolOnlyRecipient("arcnow_buy") };
    }

    const symbol = await ctx.port.token(market.state.token).symbol();
    // The quote comes with the curve's state, read already: no extra call.
    const quoteToken = market.state.quoteToken;
    const uncapped = refuseWithoutCap(ctx, quoteToken, `buying ${symbol}`);
    if (uncapped !== undefined) return { isError: true, text: uncapped };
    const quoteIn = parseQuoteAmount(quoteToken, args.quoteIn, "quoteIn");
    const statedMax = parseQuoteAmount(quoteToken, args.maxTotalCost, "maxTotalCost");

    const refusal = refuseIfOverBudget(quoteIn, statedMax, ctx, `buying ${symbol}`);
    if (refusal !== undefined) return { isError: true, text: refusal };

    return market.venue === "pool"
      ? buyInPool(args, ctx, market, symbol, quoteIn, statedMax)
      : buyOnCurve(args, ctx, market, symbol, quoteIn);
  },
});

async function buyOnCurve(
  args: BuyArgs,
  ctx: ToolContext,
  market: Market,
  symbol: string,
  quoteIn: QuoteAmount,
): Promise<ToolOutput> {
  const { state } = market;
  const quote = await market.trade.quoteBuy(quoteIn);
  if (quote.venue !== "curve") return { isError: true, text: venueMovedText("arcnow_buy") };

  const erc20 = !quoteIn.token.isNative;
  const callerGasLimit = args.gasLimit === undefined ? undefined : BigInt(args.gasLimit);
  // A graduating buy needs the migration's budget. For an ERC-20 quote a caller's
  // limit is only ever raised — to GRADUATION_GAS_LIMIT here, and on a buy that does
  // not graduate, by the SDK, to the estimate plus headroom — never refused or lowered.
  // Native USDC is unchanged: the caller's limit as given, refused below the floor.
  const gasLimit = quote.graduates
    ? erc20
      ? (callerGasLimit !== undefined && callerGasLimit > GRADUATION_GAS_LIMIT
          ? callerGasLimit
          : GRADUATION_GAS_LIMIT)
      : (callerGasLimit ?? GRADUATION_GAS_LIMIT)
    : callerGasLimit;

  if (!erc20 && quote.graduates && gasLimit !== undefined && gasLimit < GRADUATION_GAS_FLOOR) {
    return {
      isError: true,
      text: report(
        `Refused: this buy would graduate the curve and the gas limit you gave `
        + `(${gasLimit}) is below the ${GRADUATION_GAS_FLOOR} needed for the migration to `
        + "run. Nothing was sent.",
        note(GRADUATING_BUY_WARNING),
      ),
    };
  }

  const minTokensOut = minTokensOutFromQuote(quote, Bps.of(BigInt(args.slippageBps)));
  const result = await market.trade.buy({
    quoteIn,
    minTokensOut,
    deadline: Deadline.inMinutes(args.deadlineMinutes),
    ...(args.referrer === undefined ? {} : { referrer: args.referrer as Address }),
    ...(args.developer === undefined ? {} : { developer: args.developer as Address }),
    ...(gasLimit === undefined ? {} : { gasLimit }),
  });
  if (result.venue !== "curve") {
    return { isError: true, text: sentElsewhere("arcnow_buy", "pool", result.hash) };
  }

  const avg = effectivePrice(result.quoteSpent, result.tokensOut);
  return {
    text: report(
      `Bought ${qty(result.tokensOut, symbol)}.`,
      section("what happened", [
        ["venue", "its bonding curve"],
        ["you sent", spentLine(quoteIn, `the curve ${addr(market.curve.address)}`)],
        ["fee", `${money(result.fee)} — the flat 1%`],
        ["reached the curve", money(result.quoteSpent)],
        ["refunded", result.refund.isZero()
          ? "nothing"
          : `${money(result.refund)} — the buy was capped at the remaining inventory${
            quoteIn.token.isNative ? "" : "; an ERC-20 refund is simply never pulled"}`],
        ["tokens out", qty(result.tokensOut, symbol)],
        ["floor you set", `${qty(minTokensOut, symbol)} (${args.slippageBps} bps)`],
        ["average fill price", avg === undefined ? "n/a" : price(avg)],
        ["new spot price", price(result.newPrice)],
        ["gas limit sent", gasLimitSentLine(erc20, quote.graduates, callerGasLimit, gasLimit)],
        ["transaction", result.txHash],
      ]),
      quoteApprovalSection(quoteIn, `the curve ${addr(market.curve.address)}`, result.approvalTxHash),
      result.graduated
        ? section("graduation", [
            ["curve", "GRADUATED. Trading on it is over, permanently."],
            ["migrated here", result.migratedInThisTransaction
              ? "YES — the pool was created in this same transaction; the token now trades in "
              + "it, and the quote and trade tools route there"
              : "NO — the pool was not created in this transaction"],
            ["instant migration", result.instantMigrationFailed
              ? "FAILED and was caught. The curve logged InstantMigrationFailed. The token "
              + "has graduated and has no market until somebody migrates it — migrate() is "
              + "permissionless, and arcnow_migrate does it for the cost of gas. Do that "
              + "now, or tell the user it needs doing."
              : "succeeded"],
          ])
        : section("progress", [
            ["raised", `${money(state.realReserve)} → ${money(quote.newReserve)} of `
            + money(state.target)],
            ["graduates at", money(state.target)],
          ]),
    ),
  };
}

async function buyInPool(
  args: BuyArgs,
  ctx: ToolContext,
  market: Market,
  symbol: string,
  quoteIn: QuoteAmount,
  statedMax: QuoteAmount,
): Promise<ToolOutput> {
  let quote: TradeBuyQuote;
  try {
    quote = await market.trade.quoteBuy(quoteIn);
  } catch (error) {
    return { isError: true, text: renderPoolError("arcnow_buy", "buy", error) };
  }
  if (quote.venue !== "pool") return { isError: true, text: venueMovedText("arcnow_buy") };

  // The router settles exactly the amount sent, so this is the same number; it
  // is checked again against the quote anyway, so a quote that disagreed with
  // the order could not slip past either ceiling.
  const cost = quote.quoteIn.gt(quoteIn) ? quote.quoteIn : quoteIn;
  const refusal = refuseIfOverBudget(cost, statedMax, ctx, `buying ${symbol}`);
  if (refusal !== undefined) return { isError: true, text: refusal };

  const minTokensOut = minTokensOutFromQuote(quote, Bps.of(BigInt(args.slippageBps)));
  const signer = ctx.port.signerAddress;
  const recipient = (args.recipient ?? signer) as Address | undefined;
  let result: TradeBuyResult;
  try {
    result = await market.trade.buy({
      quoteIn,
      minTokensOut,
      deadline: Deadline.inMinutes(args.deadlineMinutes),
      ...(args.recipient === undefined ? {} : { recipient: args.recipient as Address }),
    });
  } catch (error) {
    return { isError: true, text: renderPoolError("arcnow_buy", "buy", error) };
  }
  if (result.venue !== "pool") {
    return { isError: true, text: sentElsewhere("arcnow_buy", "curve", result.txHash) };
  }

  const key = await market.trade.pool.key().catch(() => undefined);
  const avg = effectivePrice(result.quote, result.tokens);
  const router = routerName(ctx.port.config);
  return {
    text: report(
      `Bought ${qty(result.tokens, symbol)} in its Uniswap v4 pool.`,
      section("what happened", [
        ["venue", `Uniswap v4 pool, through arcnow.io's router ${router}`],
        ["you sent", `${money(result.quote)} — read from the PoolManager's Swap log in this `
        + `transaction's receipt, arcnow.io's fee included${quoteIn.token.isNative
          ? "; as msg.value"
          : "; pulled by the router, with no value sent"}`],
        ["arcnow.io fee", poolFeeTaken(result.feeQuote)],
        ["earlier fees paid out", earlierFeesPaidOut(result.feesDistributed)],
        ["pool fee", key === undefined
          ? "(the pool key could not be read back)"
          : `${lpFee(key.fee)} — Uniswap's LP fee, inside the price`],
        ["tokens out", `${qty(result.tokens, symbol)} — from the token's Transfer log in the `
        + "receipt"],
        ["tokens to", recipient === undefined ? "the signing address" : payee(recipient, signer)],
        ["floor you set", `${qty(minTokensOut, symbol)} (${args.slippageBps} bps)`],
        ["average fill price", avg === undefined ? "n/a" : price(avg)],
        ["gas limit sent", poolSwapGasLine(quoteIn.token.isNative, "buy")],
        ["transaction", result.hash],
      ]),
      quoteApprovalSection(quoteIn, `arcnow.io's router ${router}`, result.approvalTxHash),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

interface SellArgs {
  tokensIn: string;
  slippageBps: number;
  deadlineMinutes: number;
  referrer?: string | undefined;
  developer?: string | undefined;
  recipient?: string | undefined;
  approveRouter?: boolean | undefined;
}

const sell = defineTool({
  name: "arcnow_sell",
  title: "Sell a token",
  access: "write",
  description:
    "Sell a token wherever it currently trades, through the SDK's client.trade(token). "
    + "Spends nothing but gas; it receives the token's quote — native USDC, or the ERC-20 such as "
    + "EURC it is priced in.\n\n"
    + "A fresh quote is taken inside this call and the minimum-out floor, in that quote, is "
    + "computed from it and your slippage tolerance.\n\n"
    + "ON A CURVE there is no approval step, and this server will never emit one. The curve "
    + "pulls the tokens through a privileged path that reads no allowance at all: a holder "
    + "who has approved nobody can always sell, and an allowance granted to the curve is not "
    + "spent by selling. If a curve sell fails with InsufficientTokenBalance, the wallet does "
    + "not hold the tokens — an approval will not change that.\n\n"
    + "IN A POOL (the token graduated and migrated) it is different, and this is the one "
    + "place this server can GRANT SPENDING RIGHTS. The router pulls the tokens with "
    + "transferFrom, so it must be approved first, in a separate ERC-20 approval transaction. "
    + "This tool never sends one silently. Without approveRouter: true it checks the "
    + "allowance and, if it is short, refuses, sends nothing, and says exactly what the "
    + "approval would be. With approveRouter: true it approves EXACTLY the amount being sold "
    + "— never an unlimited allowance — and only if the existing allowance does not already "
    + "cover the sale; the result reports the approval, its transaction and the allowance "
    + "left, including when the sell that followed it failed. Tell the user about the "
    + "approval before setting approveRouter. referrer and developer are curve-only and "
    + "refused in a pool; recipient is pool-only and refused on a curve.\n\n"
    + "A token that graduated but never migrated cannot be sold anywhere; this refuses and "
    + "names arcnow_migrate.",
  input: {
    address: addressArg("The curve address, or the token address. Either works."),
    tokensIn: decimalArg("How many whole tokens to sell, as a string."),
    slippageBps: slippageArg(),
    deadlineMinutes: deadlineArg(),
    referrer: addressArg(
      "CURVE ONLY: credited with the referral share of the fee. Refused for a token in its "
      + "pool.").optional(),
    developer: addressArg(
      "CURVE ONLY: credited with the developer share of the fee. Refused for a token in its "
      + "pool.").optional(),
    recipient: addressArg(
      "POOL ONLY: who receives the proceeds, in the token's quote. Defaults to the signing "
      + "address. Refused for a token still on its bonding curve, which always pays the seller. If "
      + "it is not the user's own address, check it with them: money sent to a wrong address is "
      + "gone.").optional(),
    approveRouter: z.boolean().optional().describe(
      "POOL ONLY. Set true to let this call send the ERC-20 approval a pool sell needs, if "
      + "the router's existing allowance does not already cover the sale. The approval is a "
      + "separate transaction granting arcnow.io's router the right to move EXACTLY the "
      + "amount being sold — never more — and it is reported in the result. Omit it and a "
      + "sell that needs an approval is refused with nothing sent, saying what the approval "
      + "would be. Refused on a bonding curve, whose sells need no approval."),
  },
  async run(args, ctx) {
    const market = await resolveMarket(ctx, args.address as Address);
    if (market.venue === "stranded") return { isError: true, text: strandedText("arcnow_sell") };

    if (market.venue === "pool") {
      const refused = (["referrer", "developer"] as const)
        .filter((field) => args[field] !== undefined);
      if (refused.length > 0) {
        return { isError: true, text: refuseCurveOnly("arcnow_sell", refused, "sent") };
      }
    } else {
      if (args.recipient !== undefined) {
        return { isError: true, text: refusePoolOnlyRecipient("arcnow_sell") };
      }
      if (args.approveRouter === true) return { isError: true, text: refuseCurveApproval() };
    }

    const symbol = await ctx.port.token(market.state.token).symbol();
    const tokensIn = Tokens.parse(args.tokensIn);
    return market.venue === "pool"
      ? sellInPool(args, ctx, market, symbol, tokensIn)
      : sellOnCurve(args, market, symbol, tokensIn);
  },
});

async function sellOnCurve(
  args: SellArgs,
  market: Market,
  symbol: string,
  tokensIn: TokensType,
): Promise<ToolOutput> {
  const quote = await market.trade.quoteSell(tokensIn);
  if (quote.venue !== "curve") return { isError: true, text: venueMovedText("arcnow_sell") };
  const minQuoteOut = minQuoteOutFromQuote(quote, Bps.of(BigInt(args.slippageBps)));

  const result = await market.trade.sell({
    tokensIn,
    minQuoteOut,
    deadline: Deadline.inMinutes(args.deadlineMinutes),
    ...(args.referrer === undefined ? {} : { referrer: args.referrer as Address }),
    ...(args.developer === undefined ? {} : { developer: args.developer as Address }),
  });
  if (result.venue !== "curve") {
    return { isError: true, text: sentElsewhere("arcnow_sell", "pool", result.hash) };
  }

  return {
    text: report(
      `Sold ${qty(tokensIn, symbol)} for ${money(paidOut(result.quoteOut))}.`,
      section("what happened", [
        ["venue", "its bonding curve"],
        ["tokens in", qty(tokensIn, symbol)],
        ["fee", money(result.fee)],
        ["you received", result.quoteOut.token.isNative
          ? money(result.quoteOut)
          : `${money(paidOut(result.quoteOut))} — ${result.quoteOut.token.symbol} pays whole raw units, `
            + `so the ${money(result.quoteOut)} the curve accounted is paid down to that`],
        ["floor you set", `${money(minQuoteOut)} (${args.slippageBps} bps)`],
        ["new spot price", price(result.newPrice)],
        ["transaction", result.txHash],
      ]),
      note("No approval was needed and none was granted; the curve's pull path reads no "
        + "allowance. Any allowance that existed before this sell is untouched."),
    ),
  };
}

interface Approval {
  readonly hash: string;
  readonly amount: TokensType;
  readonly previous: TokensType;
}

interface ApprovalContext {
  readonly token: Address;
  readonly symbol: string;
  readonly router: string;
  readonly owner: Address;
  readonly left: TokensType | undefined;
}

function approvalSection(approval: Approval, at: ApprovalContext): string {
  return section("approval granted — a separate transaction, sent before the sell", [
    ["token", `${addr(at.token)} (${at.symbol})`],
    ["owner", addr(at.owner)],
    ["spender", `${at.router} — arcnow.io's v4 router`],
    ["amount", `${qty(approval.amount, at.symbol)} — exactly the amount sold, not unlimited`],
    ...(approval.previous.isZero()
      ? []
      : [["replaced", `a previous allowance of ${qty(approval.previous, at.symbol)}, which did `
      + "not cover this sale"] as [string, string]]),
    ["transaction", approval.hash],
    ["allowance now", at.left === undefined ? "(could not be read back)" : qty(at.left, at.symbol)],
  ]);
}

async function sellInPool(
  args: SellArgs,
  ctx: ToolContext,
  market: Market,
  symbol: string,
  tokensIn: TokensType,
): Promise<ToolOutput> {
  const signer = ctx.port.signerAddress;
  if (signer === undefined) {
    return { isError: true, text: "This server has no signer, so there is nobody to sell for." };
  }
  const pool = market.trade.pool;
  const router = routerName(ctx.port.config);
  const token = market.state.token;

  let quote: TradeSellQuote;
  try {
    quote = await market.trade.quoteSell(tokensIn, { from: signer });
  } catch (error) {
    return { isError: true, text: renderPoolError("arcnow_sell", "sell", error) };
  }
  if (quote.venue !== "pool") return { isError: true, text: venueMovedText("arcnow_sell") };
  // The pool pays whole raw units of its quote, and the SDK sends the floor
  // rounded UP to one; rounded here too, so the floor reported is the one sent.
  const minQuoteOut = minQuoteOutFromQuote(quote, Bps.of(BigInt(args.slippageBps)))
    .ceilToRepresentable();

  const before = await pool.routerAllowance(signer);
  let approval: Approval | undefined;
  if (before.lt(tokensIn)) {
    if (args.approveRouter !== true) {
      return {
        isError: true,
        text: report(
          `Refused: selling ${qty(tokensIn, symbol)} in its Uniswap v4 pool needs an ERC-20 `
          + `approval to arcnow.io's router first, and ${addr(signer)} has approved it for `
          + `${qty(before, symbol)}. Nothing was sent.`,
          section("the approval this sell would need", [
            ["token", `${addr(token)} (${symbol})`],
            ["owner", addr(signer)],
            ["spender", `${router} — arcnow.io's v4 router`],
            ["amount", `${qty(tokensIn, symbol)} — exactly the amount to be sold, never unlimited`],
            ["what it is", "a SEPARATE transaction, paid for in gas, granting the router the "
            + "right to move that many of these tokens. The sell then uses it up."],
          ]),
          note("To go ahead, tell the person whose tokens these are that selling in the pool "
            + "takes this approval, and call arcnow_sell again with approveRouter: true. It is "
            + "then sent only if it is still needed, for exactly the amount sold, and reported "
            + "in the result. A bonding-curve sell never needed this; a pool sell always does, "
            + "because the router has no privileged path to the tokens."),
        ),
      };
    }
    const hash = await pool.approveRouter(tokensIn);
    approval = { hash, amount: tokensIn, previous: before };
  }

  let result: TradeSellResult;
  try {
    result = await market.trade.sell({
      tokensIn,
      minQuoteOut,
      deadline: Deadline.inMinutes(args.deadlineMinutes),
      ...(args.recipient === undefined ? {} : { recipient: args.recipient as Address }),
    });
  } catch (error) {
    if (approval === undefined) {
      return { isError: true, text: renderPoolError("arcnow_sell", "sell", error) };
    }
    const left = await pool.routerAllowance(signer).catch(() => undefined);
    return {
      isError: true,
      text: report(
        "arcnow_sell: the router approval went through, and the sell did not.",
        approvalSection(approval, { token, symbol, router, owner: signer, left }),
        note(`That approval still stands: arcnow.io's router may move up to `
          + `${qty(left ?? approval.amount, symbol)} of ${addr(signer)}'s ${symbol} until a sell `
          + "uses it or another approval replaces it. Nothing else was sent. Tell the user. "
          + "Calling arcnow_sell again uses this allowance and does not approve a second time."),
        renderPoolError("arcnow_sell", "sell", error),
      ),
    };
  }
  if (result.venue !== "pool") {
    return { isError: true, text: sentElsewhere("arcnow_sell", "curve", result.txHash) };
  }

  const left = await pool.routerAllowance(signer).catch(() => undefined);
  const recipient = (args.recipient ?? signer) as Address;
  const key = await pool.key().catch(() => undefined);

  return {
    text: report(
      `Sold ${qty(result.tokens, symbol)} in its Uniswap v4 pool for ${money(result.quote)}.`,
      approval === undefined
        ? section("approval", [
            ["approval", `No approval was sent: the router's existing allowance of `
            + `${qty(before, symbol)} already covered this sale.`],
            ["allowance now", left === undefined
              ? "(could not be read back)"
              : `${qty(left, symbol)}${left.isZero()
                ? ""
                : " — a standing allowance remains: the router can move that many of these "
                  + "tokens until a sell uses it or another approval replaces it"}`],
          ])
        : approvalSection(approval, { token, symbol, router, owner: signer, left }),
      section("what happened", [
        ["venue", `Uniswap v4 pool, through arcnow.io's router ${router}`],
        ["tokens in", `${qty(result.tokens, symbol)} — from the token's Transfer log in the `
        + "receipt"],
        ["pool fee", key === undefined
          ? "(the pool key could not be read back)"
          : `${lpFee(key.fee)} — Uniswap's LP fee, taken from the tokens sold`],
        ["arcnow.io fee", poolFeeTaken(result.feeQuote)],
        ["earlier fees paid out", earlierFeesPaidOut(result.feesDistributed)],
        ["you received", `${money(result.quote)} — read from the PoolManager's Swap log in this `
        + "transaction's receipt, net of both fees"],
        [`${result.quote.token.symbol} to`, payee(recipient, signer)],
        ["floor you set", `${money(minQuoteOut)} (${args.slippageBps} bps)`],
        ["gas limit sent", poolSwapGasLine(result.quote.token.isNative, "sell")],
        ["transaction", result.hash],
      ]),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const migrate = defineTool({
  name: "arcnow_migrate",
  title: "Finish a stranded graduation",
  access: "write",
  description:
    "Create the pool for a curve that graduated without one. Costs only gas and spends "
    + "nothing; it is the rescue path, not a normal step.\n\n"
    + "When a graduating buy is sent with an estimated gas limit, the migration it triggers "
    + "runs out of gas and the curve CATCHES that failure rather than reverting. The buy "
    + "succeeds, the curve graduates, the refund is correct, and the pool is never created — "
    + "with no revert and no error anywhere. Until it is, the token trades NOWHERE. "
    + "migrate() is deliberately permissionless and unbounded in gas so that anybody, not "
    + "just the buyer, can finish the job. That is what this does; afterwards the token trades "
    + "in its Uniswap v4 pool and the quote and trade tools route there.\n\n"
    + "If the curve already migrated, this reports that and sends nothing. If it has not "
    + "graduated yet, this reports that and sends nothing: migration is not something you can "
    + "bring forward.",
  input: {
    address: addressArg("The curve address, or the token address. Either works."),
  },
  async run(args, ctx) {
    const { curve, state } = await resolveCurve(ctx.port, args.address as Address);
    if (!state.graduated) {
      return {
        isError: true,
        text: report(
          "Nothing to do: this curve has not graduated, so there is nothing to migrate.",
          section("where it is", [
            ["raised", `${money(state.realReserve)} of ${money(state.target)}`],
            ["progress", progress(state.progressBps)],
          ]),
          note("Migration happens when the curve collects its target, in the buy that fills "
            + "it. It cannot be triggered early."),
        ),
      };
    }
    if (state.migrated) {
      const manager = await ctx.port.token(state.token).migratedPool().catch(() => undefined);
      return {
        text: report(
          "Nothing to do: this curve has already migrated, and nothing was sent.",
          section("where it went", [
            ["venue", `${addr(state.migrator)} — ${venueOf(state.migrator, ctx.port.config)}`],
            ["pool manager", manager === undefined
              ? "(could not be read)"
              : `${addr(manager)} — a v4 pool has no address of its own; this is the manager `
                + "it lives in"],
          ]),
        ),
      };
    }

    const result = await curve.migrate();
    return {
      text: report(
        "Migrated. The token now has a market: its Uniswap v4 pool.",
        section("what moved", [
          [`${result.quote.token.symbol} into the pool`, money(result.quote)],
          ["tokens into the pool", qty(result.tokens)],
          ["recorded pool", result.pool === undefined
            ? "(not reported in the receipt)"
            : `${addr(result.pool)} — for a v4 pool this is the PoolManager, not a per-token `
              + "address"],
          ["venue", `${addr(state.migrator)} — ${venueOf(state.migrator, ctx.port.config)}`],
          ["transaction", result.txHash],
        ]),
        note("This cost gas and nothing else. Anyone could have called it; there is no reward "
          + "for doing so, which is why a stranded curve can sit unmigrated until somebody "
          + "notices. arcnow_quote_buy and arcnow_buy now route to the pool."),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const withdraw = defineTool({
  name: "arcnow_withdraw_refund",
  title: "Claim what a curve is holding for you",
  access: "write",
  description:
    "Claim the quote token (native USDC, or the ERC-20 such as EURC the curve is priced in) that "
    + "a curve credited to an address because a direct transfer to it failed — "
    + "a refund on a graduating buy, or a fee payout. Costs only gas and receives money; it "
    + "cannot spend anything.\n\n"
    + "This is the only write tool here that recovers funds rather than committing them. It "
    + "claims for the address this server signs with, and sends the proceeds wherever you "
    + "say. If there is nothing owed, it reports that and sends nothing.",
  input: {
    address: addressArg("The curve address, or the token address. Either works."),
    to: addressArg(
      "Where to send the claimed money. Defaults to the signing address. Check this with the "
      + "user if it is not their own — money sent to a wrong address is gone.").optional(),
  },
  async run(args, ctx) {
    const signer = ctx.port.signerAddress;
    if (signer === undefined) {
      return { isError: true, text: "This server has no signer, so there is no account to claim for." };
    }
    const { curve } = await resolveCurve(ctx.port, args.address as Address);
    const owed = await curve.pendingWithdrawal(signer);
    if (owed.isZero()) {
      return {
        text: `This curve owes ${addr(signer)} nothing, and nothing was sent. A balance here `
          + "only appears when a transfer to the address failed and the curve credited it "
          + "instead.",
      };
    }
    const to = (args.to ?? signer) as Address;
    const result = await curve.withdraw(to);
    return {
      text: report(
        `Claimed ${money(result.amount)}.`,
        section("where it went", [
          ["amount", money(result.amount)],
          ["to", `${addr(to)}${to.toLowerCase() === signer.toLowerCase()
            ? " (the signing address)"
            : " — NOT the signing address"}`],
          ["transaction", result.txHash],
        ]),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const registerPlatform = defineTool({
  name: "arcnow_register_platform",
  title: "Register a new platform (protocol admin only)",
  access: "write",
  destructive: true,
  description:
    "Register a new platform: a fee split, a curve template and a default graduation venue. "
    + "Costs only gas, and deploys a new PlatformConfig contract that will exist forever.\n\n"
    + "READ THIS BEFORE OFFERING IT. Registration is callable ONLY by the registry's "
    + "protocolAdmin; every other caller gets NotProtocolAdmin. The registry deploys each "
    + "PlatformConfig itself, so that membership certifies code rather than a claim, and it "
    + "will not deploy one on behalf of an arbitrary caller. If someone just wants to launch "
    + "a token, they do NOT need a platform — they launch under arcnow.io's, which is the "
    + "default.\n\n"
    + "The shares you give are basis points OF THE FEE, not of the trade: 3000 means 30% of "
    + "the 1% fee, which is 0.30% of a trade. The platform's own share is not an input and "
    + "cannot be one — it is the residual, 10000 minus the protocol's maximum share and the "
    + "three you set, and this tool tells you what you are actually choosing before it sends. "
    + "Creator, referrer and developer may claim at most 7500 between them.\n\n"
    + "The curve template is arcnow.io's shipped constant-product one, whose constants were "
    + "solved to 80 "
    + "digits and placed rather than rounded. This tool does not accept a custom template: a "
    + "recomputed Y0 or R0 lands a few wei out, the contracts' own validator refuses it, and "
    + "the failure reads like a bug in the contracts rather than in the arithmetic.",
  input: {
    admin: addressArg("The address that will administer the new platform."),
    feeRecipient: addressArg("Where the platform's residual share of every fee is paid."),
    creatorShareBps: intArg(0, 7500, 3000,
      "The creator's share, in basis points OF THE FEE. arcnow.io's own platform uses 3000 "
      + "— 30% of the fee, 0.30% of a trade."),
    refShareBps: intArg(0, 7500, 1000,
      "The referrer's share, in basis points of the fee. Paid to the platform when a trade "
      + "names no referrer."),
    devShareBps: intArg(0, 7500, 1000,
      "The developer's share, in basis points of the fee. Paid to the platform when a trade "
      + "names no developer."),
    defaultMigrator: addressArg(
      "The graduation venue every token launched under this platform gets by default. It is "
      + "snapshotted into each curve at launch and immutable from then on. Use a migrator "
      + "this deployment actually has — arcnow_network lists them."),
  },
  async run(args, ctx) {
    const newPlatform = {
      admin: args.admin as Address,
      feeRecipient: args.feeRecipient as Address,
      creatorShareBps: Bps.of(BigInt(args.creatorShareBps)),
      refShareBps: Bps.of(BigInt(args.refShareBps)),
      devShareBps: Bps.of(BigInt(args.devShareBps)),
      defaultMigrator: args.defaultMigrator as Address,
      curve: CurveTemplate.arcnowDefaults(),
    };

    // The SDK checks the 7500 allowance client-side and names the residual you
    // are actually choosing. Letting it reject here costs nothing and produces
    // a better sentence than a revert would.
    const { platformShare } = validateNewPlatform(newPlatform);
    const residual = platformShareBps(
      newPlatform.creatorShareBps, newPlatform.refShareBps, newPlatform.devShareBps);

    const result = await ctx.port.platforms.registerPlatform(newPlatform);
    return {
      text: report(
        `Registered a new platform at ${addr(result.platform)}.`,
        section("the split it will apply", [
          ["creator", share(newPlatform.creatorShareBps, TRADE_FEE)],
          ["referrer", share(newPlatform.refShareBps, TRADE_FEE)],
          ["developer", share(newPlatform.devShareBps, TRADE_FEE)],
          ["platform (residual)", share(residual, TRADE_FEE)],
          ["as registered", `${result.platformShareBps.bps} bps (the registry's own figure; `
          + `this SDK computed ${platformShare.bps} before sending)`],
        ]),
        section("its defaults", [
          ["admin", addr(newPlatform.admin)],
          ["fee recipient", addr(newPlatform.feeRecipient)],
          ["graduation venue", `${addr(newPlatform.defaultMigrator)} — `
          + venueOf(newPlatform.defaultMigrator, ctx.port.config)],
          ["curve template", "arcnow.io's shipped template, CurveTemplate.arcnowDefaults(): "
          + `${qty(newPlatform.curve.totalSupply)} supply, ${qty(newPlatform.curve.curveSupply)} on `
          + `the curve, graduating at ${money(newPlatform.curve.target)}`],
          ["transaction", result.txHash],
        ]),
        note("This PlatformConfig now exists permanently. Tokens launched under it carry its "
          + "split and its venue for their whole lives."),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a curve sell of an ERC-20 quote actually pays: the contract pays
 * `out - out % scale`, whole raw units, and the dust stays in the curve.
 */
function paidOut(amount: QuoteAmount): QuoteAmount {
  return amount.floorToRepresentable();
}

export const WRITE_TOOLS: readonly AnyTool[] = [
  launch,
  buy,
  sell,
  migrate,
  withdraw,
  registerPlatform,
];

/**
 * What a write tool says when the server is read-only.
 *
 * Deliberately a refusal by name rather than "unknown tool". A model that gets
 * "unknown tool" concludes the server is broken or that it guessed the name
 * wrong, and tries variations; a model that gets this stops, and can tell the
 * user the one true thing — that this is a configuration the operator controls
 * and the conversation cannot.
 */
export function writeRefusal(name: string): ToolOutput {
  return {
    isError: true,
    text: report(
      `${name} is a write tool and this server is running READ-ONLY. Nothing was sent, `
      + "nothing was signed, and no key is loaded.",
      note(
        "This is not something to work around and not something you can be granted mid-"
        + "conversation. Writes are enabled by whoever starts the server, by restarting it "
        + "with --allow-writes and a signing key in the ARCNOW_PRIVATE_KEY environment "
        + "variable. A private key is never an argument to any tool here: a tool call is "
        + "written into a transcript, and a key that has been through a transcript has been "
        + "published. Do not ask the user to paste one, and if they offer, tell them to put "
        + "it in the server's environment instead.",
      ),
      "Everything read-only still works: arcnow_network, arcnow_quote_tokens, arcnow_list_tokens, arcnow_token, "
      + "arcnow_quote_buy, arcnow_quote_sell, arcnow_quote_launch, arcnow_platform and "
      + "arcnow_list_platforms. A quote is often the whole answer.",
    ),
  };
}
