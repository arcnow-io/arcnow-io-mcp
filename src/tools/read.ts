/**
 * The read-only tools: everything that cannot cost anybody anything.
 *
 * These are always published, on every server, in every mode, and they are the
 * part worth getting excellent. An assistant that can answer "what is this
 * token, what would 50 USDC buy me, and how close is it to graduating" without
 * being able to sign anything is useful to far more people than one that can
 * trade, and it is useful with no key anywhere near it.
 *
 * A quote answers for wherever the token trades now: its bonding curve before
 * graduation, its Uniswap v4 pool after migration (see `./pool.ts`), and
 * nowhere in between — which is said, not glossed.
 *
 * @module
 */

import type { Address } from "viem";
import type { FeeSplit, QuoteRegistryEntry, QuoteTokenInfo } from "@arcnow/sdk";
import {
  Bps,
  isArcNowError,
  QuoteAmount,
  TRADE_FEE_BPS,
  Tokens,
} from "@arcnow/sdk";

import {
  addr,
  curveParamsLine,
  effectivePrice,
  money,
  note,
  price,
  priceMove,
  progress,
  qty,
  quoteLine,
  report,
  section,
  share,
  venueOf,
  ZERO_ADDRESS,
} from "../format.js";
import { renderError } from "./errors.js";
import { addressArg, boolArg, decimalArg, defineTool, intArg, metadataUriArg, textArg, z } from "./schema.js";
import type { AnyTool, ToolContext } from "./schema.js";
import { launchParams } from "./launch-params.js";
import { buyPaymentLine, lpFee, quotePoolBuy, quotePoolSell } from "./pool.js";
import { chooseQuote, parseQuoteAmount } from "./quote.js";
import { capText } from "./spend.js";
import type { Market } from "./venue.js";
import { configuredRouter, resolveMarket, strandedText } from "./venue.js";

const TRADE_FEE = Bps.of(TRADE_FEE_BPS);

/** The tolerances a quote is shown at, so a floor is a choice and not a guess. */
const TOLERANCES = [50n, 100n, 300n, 1000n];

// ─────────────────────────────────────────────────────────────────────────────

const network = defineTool({
  name: "arcnow_network",
  title: "Network and server mode",
  access: "read",
  description:
    "Which chain this server is pointed at, which arcnow.io contracts are deployed there, "
    + "which graduation venues exist, whether a Uniswap v4 router is configured for trading "
    + "graduated tokens, and — the part that decides what else you can do — whether this "
    + "server is READ-ONLY or has writes enabled.\n\n"
    + "Call this first in any session that might trade. It tells you the spend ceilings the "
    + "operator set — one per quote token, and a quote with none is refused — the address that "
    + "would sign, and whether the write tools exist at all. It lists the network's quote tokens: "
    + "a token is priced for life in native USDC (the gas currency, 18 decimals) or an ERC-20 "
    + "such as EURC (6 decimals), and every amount is in that quote. The 6-decimal USDC ERC-20 "
    + "predeploy is a separate view of native USDC that pays for nothing. Takes no arguments and "
    + "touches no chain state; arcnow_quote_tokens asks the registry which quotes a launch accepts.",
  input: {},
  run(_args, ctx) {
    const { config } = ctx.port;
    const c = config.contracts;
    const router = configuredRouter(config);
    const deployed: [string, string][] = [
      ["launchpad", addr(c.launchpad)],
      ["tokenFactory", addr(c.tokenFactory)],
      ["curveFactory", addr(c.curveFactory)],
      ["migratorRegistry", addr(c.migratorRegistry)],
      ["platformRegistry", addr(c.platformRegistry)],
      ["arcnowPlatform", addr(c.arcnowPlatform)],
    ];
    const optional: [string, string][] = ([
      ["escrowMigrator", c.escrowMigrator],
      ["v2Migrator", c.v2Migrator],
      ["v3Migrator", c.v3Migrator],
      ["v4Migrator", c.v4Migrator],
      ["feeHook", c.feeHook],
      ["v4Router", router],
    ] as const).map(([name, address]) => [
      name,
      address === undefined ? "not deployed on this chain" : addr(address),
    ]);

    const venues = Object.entries(config.venues)
      .filter(([, present]) => present)
      .map(([name]) => name);

    const mode = ctx.config.mode === "write"
      ? `WRITES ENABLED — signing as ${addr(ctx.port.signerAddress ?? ZERO_ADDRESS)}`
      : "READ-ONLY — no tool on this server can sign, spend or launch anything";

    return Promise.resolve({
      text: report(
        section("arcnow.io MCP server", [
          ["mode", mode],
          ...(ctx.config.mode === "write"
            ? ([["spend ceilings", "per quote token, per write call, set by the operator and "
            + "enforced before any transaction is built — below, with the quote tokens"]] as [string, string][])
            : ([["to enable writes", "the operator restarts this server with --allow-writes and "
            + "a key in ARCNOW_PRIVATE_KEY. A key is never a tool argument and asking for "
            + "one will not help."]] as [string, string][])),
          ["network", ctx.config.networkFile === undefined
            ? config.name
            : `${config.name} — from the operator's ARCNOW_MCP_NETWORK_FILE, not an SDK preset`],
          ["chain id", String(config.chainId)],
          ["endpoint", ctx.config.rpcUrl],
          ["contracts commit", config.contractsCommit ?? "not recorded"],
          ["first block", config.deployedAtBlock === undefined
            ? "not recorded"
            : String(config.deployedAtBlock)],
        ]),
        section("money on this chain", [
          ["native", "USDC, 18 decimals. This is msg.value and what gas is paid in, and one of "
          + "the quote tokens a token can be priced in."],
          ["ERC-20 view", config.usdcErc20 === undefined
            ? "none recorded"
            : `${addr(config.usdcErc20)}, 6 decimals — the SAME asset through an ERC-20 `
              + "interface. It does not pay for gas and no arcnow.io contract touches it. "
              + "The two raw integers differ by 1e12."],
          ["trade fee", `${TRADE_FEE.bps} bps — a flat 1% on every buy and sell, in the token's `
          + "quote, not a platform's to change. What a platform configures is how that 1% is divided."],
        ]),
        section("quote tokens — what a token can be priced in, for life", [
          ...config.quoteTokens.map((token) => [
            token.symbol,
            `${quoteLine(token)}${ctx.config.mode === "write" ? `. Spend cap: ${capText(ctx, token)}` : ""}`,
          ] as [string, string]),
          ["caveat", "metadata from this network's configuration, not the allowlist: "
          + "arcnow_quote_tokens asks the quote registry which of them a launch accepts now. A "
          + "token's own quote is on arcnow_token."],
        ]),
        section("contracts (required)", deployed),
        section("contracts (present only where the chain supports them)", optional),
        section("graduation venues", [
          ["available", venues.length === 0 ? "none" : venues.join(", ")],
          ["caveat", "a token graduates to the migrator ITS OWN CURVE snapshotted at launch, "
          + "which is immutable and need not be the one this list would suggest. Ask the "
          + "curve with arcnow_token, never this list, for a particular token."],
        ]),
        section("trading after graduation", router === undefined
          ? [
              ["v4 router", "NONE configured for this network"],
              ["what that means", "graduated tokens cannot be quoted or traded through this "
              + "server, however healthy their pools are. Bonding curves are unaffected."],
            ]
          : [
              ["v4 router", `${addr(router)} — arcnow.io's UniswapV4Router04, the only route `
              + "into a graduated token's pool"],
              ["pool manager", config.v4?.poolManager === undefined
                ? "not recorded"
                : `${addr(config.v4.poolManager)} — where arcnow.io's pools hold their `
                  + "liquidity. A v4 pool has no address of its own."],
              ["what that means", "graduated tokens trade: once a token has migrated, "
              + "arcnow_quote_buy, arcnow_quote_sell, arcnow_buy and arcnow_sell route to its "
              + "pool on their own. Whether this router reaches a particular token's pool is "
              + "checked per token by arcnow_token. A pool sell needs an ERC-20 approval to "
              + "this router first."],
            ]),
      ),
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const listTokens = defineTool({
  name: "arcnow_list_tokens",
  title: "Recent token launches",
  access: "read",
  description:
    "Recent arcnow.io launches, newest first, read from the launchpad's `Launched` log.\n\n"
    + "There is no index and no backend behind this: it walks the chain backwards from the "
    + "tip in bounded chunks, so it sees a WINDOW of recent history and the result says "
    + "exactly which blocks it covered. If it stopped on its budget before finding what you "
    + "asked for, that is reported and is not the same as 'there are no more' — do not tell "
    + "a user a token does not exist on the strength of this tool.\n\n"
    + "Filter by `creator` to find what one address launched. Set `includeState` to false "
    + "when you only need the addresses; each token's curve state is an extra round trip.",
  input: {
    limit: intArg(1, 25, 10,
      "How many launches to return. Each one with includeState costs a round trip."),
    creator: addressArg("Only launches by this creator address.").optional(),
    includeState: boolArg(true,
      "Also read each curve's live state: price, reserve, progress to graduation, whether "
      + "it graduated. Off is faster and tells you only what the launch log recorded."),
  },
  async run(args, ctx) {
    const scan = await ctx.port.listLaunches({
      limit: args.limit,
      ...(args.creator === undefined ? {} : { creator: args.creator as Address }),
    });

    if (scan.launches.length === 0) {
      return {
        text: report(
          `No launches found in blocks ${scan.scannedFromBlock}–${scan.scannedToBlock}.`,
          note(scan.reachedDeployment
            ? "That scan reached the block this deployment starts at, so for the filter you "
            + "gave, there really are none."
            : "That scan stopped on its block budget with history still unread, so this is "
              + "NOT evidence that none exist — only that none are recent. Say so rather "
              + "than reporting an absence."),
        ),
      };
    }

    const blocks: string[] = [];
    for (const launch of scan.launches) {
      const rows: [string, string][] = [
        ["token", addr(launch.token)],
        ["curve", addr(launch.curve)],
        ["creator", addr(launch.creator)],
        ["platform", addr(launch.platform)],
        ["graduates to", `${addr(launch.migrator)} — ${venueOf(launch.migrator, ctx.port.config)}`],
        ["quote", quoteLine(launch.quoteToken)],
        ["at launch", `${money(launch.initialBuy)} initial buy, ${money(launch.launchFee)} `
        + `launch fee, ${qty(launch.tokensOut)} tokens to the creator`],
        ["block", `${launch.blockNumber} (tx ${launch.txHash})`],
      ];
      if (args.includeState) {
        try {
          const [state, symbol, name] = await Promise.all([
            ctx.port.curve(launch.curve).state(),
            ctx.port.token(launch.token).symbol(),
            ctx.port.token(launch.token).name(),
          ]);
          rows.unshift(["name", `${name} (${symbol})`]);
          rows.push(
            ["price now", price(state.spotPrice)],
            ["raised", `${money(state.realReserve)} of ${money(state.target)}`],
            ["progress", progress(state.progressBps)],
            ["status", statusLine(state.graduated, state.migrated)],
          );
        } catch (error) {
          rows.push(["state", `could not be read: ${describe(error)}`]);
        }
      }
      blocks.push(section(`launch at block ${launch.blockNumber}`, rows));
    }

    return {
      text: report(
        `${scan.launches.length} launch(es), newest first.`,
        ...blocks,
        section("what this scan covered", [
          ["blocks", `${scan.scannedFromBlock}–${scan.scannedToBlock} (tip is ${scan.tipBlock})`],
          ["complete", scan.reachedDeployment
            ? "yes — the scan reached the first block of this deployment"
            : scan.stoppedOnBudget
              ? "NO — it stopped on its block budget with history unread. There may be more."
              : "the limit was reached before the budget was; there is more history below this."],
        ]),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const tokenTool = defineTool({
  name: "arcnow_token",
  title: "Inspect a token and where it trades",
  access: "read",
  description:
    "Everything about one arcnow.io token: its metadata, its bonding curve's live state, "
    + "the price, how far it is from graduation, whether it has graduated — and WHERE IT "
    + "TRADES NOW: its bonding curve, its Uniswap v4 pool, or nowhere.\n\n"
    + "For a token in its pool this reports the router this server would trade through, "
    + "whether that router can actually reach the pool, the PoolManager the liquidity is in "
    + "(a v4 pool has no address of its own), and the pool's own LP fee, which is charged on "
    + "top of arcnow.io's 1%.\n\n"
    + "It names the token's QUOTE TOKEN — native USDC or an ERC-20 such as EURC, fixed at "
    + "launch — with its address and decimals: every amount here, and every amount the trade "
    + "tools take for this token, is in that quote.\n\n"
    + "Pass either the token address or its curve address; this works out which it got. "
    + "Pass `holder` to include that address's balance and any refund the curve is holding "
    + "for it.\n\n"
    + "Two things this tool reports that are easy to misread. The spot price is the marginal "
    + "price of the next infinitesimal token, NOT the price a trade of any size fills at — "
    + "use arcnow_quote_buy for that. And 'graduated' and 'migrated' are different states: a "
    + "curve can have graduated (trading on it is over, permanently) while its pool was never "
    + "created, which leaves the token tradeable nowhere until somebody runs migrate().",
  input: {
    address: addressArg("The token address, or its curve address. Either works."),
    holder: addressArg(
      "Optional: also report this address's token balance and any of the token's quote the "
      + "curve is holding for it after a failed payout.").optional(),
  },
  async run(args, ctx) {
    const market = await resolveMarket(ctx, args.address as Address);
    const { curve, state, viaToken } = market;
    const token = ctx.port.token(state.token);
    const [name, symbol, metadataUri, totalSupply, canonical] = await Promise.all([
      token.name(), token.symbol(), token.metadataUri(), token.totalSupply(),
      token.canonicalRouter(),
    ]);

    const venueBlock = await whereItTrades(ctx, market);

    const graduationBlock = state.graduated
      ? section("graduation", [
          ["trading on the curve", "OVER, permanently. Every further buy, sell and quote on "
          + "this curve reverts with CurveGraduated. There is no way to reopen it."],
          ["graduated to", `${addr(state.migrator)} — ${venueOf(state.migrator, ctx.port.config)}`],
          ["pool", state.migrated
            ? "created — see where it trades, above"
            : "NOT CREATED YET. The curve graduated and the pool was never recorded, which "
              + "happens when the graduating buy's instant migration ran out of gas and was "
              + "caught. migrate() is permissionless and anyone can finish it; on this server "
              + "that is arcnow_migrate, and it costs only gas."],
          ["canonical router", canonical.toLowerCase() === ZERO_ADDRESS
            ? "none (the zero address) — no holder has a standing allowance to anybody, which "
            + "is why a pool sell needs its own approval to the v4 router"
            : `${addr(canonical)}, auto-approved for every holder after migration`],
        ])
      : section("progress to graduation", [
          ["raised", `${money(state.realReserve)} of ${money(state.target)}`],
          ["progress", progress(state.progressBps)],
          ["remaining", money(state.target.subSaturating(state.realReserve))],
          ["will graduate to", `${addr(state.migrator)} — ${venueOf(state.migrator, ctx.port.config)}`],
          ["how", "the buy that fills the curve migrates it in ITS OWN transaction, is capped "
          + `at the remaining inventory, and does not take the unspent ${state.quoteToken.symbol}.`],
        ]);

    const holderBlock = args.holder === undefined
      ? undefined
      : await (async () => {
          const holder = args.holder as Address;
          const [balance, pending] = await Promise.all([
            token.balanceOf(holder),
            curve.pendingWithdrawal(holder).catch(() => QuoteAmount.zero(state.quoteToken)),
          ]);
          return section(`holder ${addr(holder)}`, [
            ["balance", qty(balance, symbol)],
            ["curve owes", pending.isZero()
              ? "nothing"
              : `${money(pending)} — a payout or refund whose transfer failed and was credited `
                + "instead. It is claimable by whoever owns the address."],
          ]);
        })();

    return {
      text: report(
        `${name} (${symbol})`,
        section("addresses", [
          ["token", addr(state.token)],
          ["curve", addr(curve.address)],
          ["creator", `${addr(state.creator)} — a transferable seat that earns a share of the `
          + "fee. It carries no power over the token."],
          ["metadata", metadataUri === "" ? "(none set)" : metadataUri],
          ["resolved from", viaToken ? "the token address you gave" : "the curve address you gave"],
        ]),
        section("curve", [
          ["status", statusLine(state.graduated, state.migrated)],
          ["quote token", `${quoteLine(state.quoteToken)} — fixed at launch; every amount below `
          + "is in it"],
          ["curve parameters", curveParamsLine(state.params, state.quoteToken)],
          ["spot price", `${price(state.spotPrice)} — the marginal price of the next `
          + "infinitesimal token, not what an order of any size fills at"],
          ["tokens sold", qty(state.tokensSold, symbol)],
          ["tokens left on the curve", qty(state.tokensRemaining, symbol)],
          ["total supply", qty(totalSupply, symbol)],
          ["real reserve", money(state.realReserve)],
          ["virtual reserve", `${money(state.virtualReserve)} — part of the curve's shape, `
          + "not money anybody holds"],
        ]),
        venueBlock,
        graduationBlock,
        holderBlock,
      ),
    };
  },
});

/** The "where it trades" block of arcnow_token. */
async function whereItTrades(ctx: ToolContext, market: Market): Promise<string> {
  const router = configuredRouter(ctx.port.config);
  const routerLine = router === undefined
    ? "none — no v4 router is configured for this network, so this server cannot quote or "
    + "trade any graduated token"
    : `${addr(router)} — arcnow.io's UniswapV4Router04 (contracts.v4Router)`;

  if (market.venue === "curve") {
    return section("where it trades", [
      ["venue", "its bonding curve. The quote and trade tools trade it there; once it "
      + "graduates and migrates, the same tools route to its Uniswap v4 pool."],
      ["router, after that", routerLine],
    ]);
  }
  if (market.venue === "stranded") {
    return section("where it trades", [
      ["venue", "NONE — graduated and never migrated. Not tradeable anywhere until somebody "
      + "calls migrate(), which is permissionless; arcnow_migrate does it for the cost of gas."],
      ["router, after that", routerLine],
    ]);
  }

  const pool = market.trade.pool;
  const [reachable, manager, id, key, quote, quoteIsCurrency0] = await Promise.all([
    settle(pool.isReachable()),
    settle(pool.poolManager()),
    settle(pool.poolId()),
    settle(pool.key()),
    settle(pool.quoteToken()),
    settle(pool.quoteIsCurrency0()),
  ]);
  // The SDK checks the hook's VERSION() before it reads the accrual, and refuses
  // any hook but arcnow/arc-now-fee-hook@3.x.x as UnknownHookVersion.
  const accrued = await settle(pool.accruedHookFee());
  return section("where it trades", [
    ["venue", "its Uniswap v4 pool — graduated and migrated. The quote and trade tools route "
    + "there on their own, and every pool quote says it is one."],
    ["router", routerLine],
    ["reachable", reachable instanceof Error
      ? `could not be checked: ${reachable.message}`
      : reachable
        ? "yes — the router's own PoolManager is the one this pool is in"
        : router === undefined
          ? "no — there is no router to reach it through"
          : "no — the router serves a different PoolManager, so it cannot see this pool, and "
            + "never will: both are immutable"],
    ["pool manager", manager instanceof Error
      ? `could not be read: ${manager.message}`
      : `${addr(manager)} — the Uniswap v4 PoolManager holding the liquidity. A v4 pool has no `
        + "address of its own: it is a pool id inside this manager, and token.migratedPool() "
        + "reports this same address for every token that migrated into it."],
    ["pool id", id instanceof Error ? `could not be read: ${id.message}` : id],
    ["quote currency", quote instanceof Error
      ? `could not be read: ${quote.message}`
      : quoteIsCurrency0 instanceof Error
        ? `${quote.symbol}; which currency of the key it is could not be read: ${quoteIsCurrency0.message}`
        : `${quote.symbol} — currency${quoteIsCurrency0 ? 0 : 1} of the pool key, with the token as `
          + `currency${quoteIsCurrency0 ? 1 : 0}, as the SDK reads the key. The key orders its `
          + "currencies by address, so an ERC-20 quote can be either; every amount here is already "
          + `in ${quote.symbol}`],
    ["pool fee", key instanceof Error
      ? `could not be read: ${key.message}`
      : `${lpFee(key.fee)} — Uniswap's LP fee, on top of arcnow.io's 1%, which the fee hook `
        + `at ${addr(key.hooks)} takes in ${market.state.quoteToken.symbol}`],
    ["fee hook", "accrues arcnow.io's 1% as a PoolManager claim and pays it out to the fee "
    + "recipients at the start of a later swap in this pool, or when anyone calls distributeFees"],
    ["hook fees accrued", accrued instanceof Error
      ? isArcNowError(accrued) && accrued.code === "UnknownHookVersion"
        ? `refused: UnknownHookVersion — ${accrued.message}`
        : `could not be read: ${accrued.message}`
      : accrued.isZero()
        ? "none — nothing charged and not yet paid out"
        : `${money(accrued)} — charged by earlier swaps and not yet paid out. The next swap in `
          + "this pool, or anyone's distributeFees, pays it to the fee recipients; it is never "
          + "part of a trader's fill"],
    ["selling", "needs an ERC-20 approval to the router first, a separate transaction. "
    + "arcnow_sell grants one only when asked, for exactly the amount sold."],
  ]);
}

async function settle<T>(promise: Promise<T>): Promise<T | Error> {
  try {
    return await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const quoteBuy = defineTool({
  name: "arcnow_quote_buy",
  title: "Quote a buy",
  access: "read",
  description:
    "What a given amount of the token's quote would buy right now, wherever the token trades: "
    + "tokens out, "
    + "every fee and who receives it, the average price the order would fill at, and the "
    + "minimum-out floor at several slippage tolerances.\n\n"
    + "Costs nothing and signs nothing. Use it before every buy, and use it INSTEAD of a spot "
    + "price whenever someone asks what an amount would get them — an order moves the price "
    + "across its own size, so the spot price is only ever its first infinitesimal slice.\n\n"
    + "ON A BONDING CURVE: if the buy would fill the curve, this says so, reports the refund, "
    + "and explains the gas-limit trap that decides whether the token's market is created in "
    + "that same transaction or never. Read that part before quoting a graduating buy to "
    + "anyone.\n\n"
    + "IN A UNISWAP V4 POOL (the token graduated and migrated): the quote says it is a pool "
    + "quote, priced by simulating the real swap through arcnow.io's router. It shows "
    + "arcnow.io's 1% and the pool's own LP fee as two separate charges, the average fill "
    + "price against the pool's spot price, and the price impact. referrer and developer do "
    + "not exist on a pool swap and are refused.\n\n"
    + "A token that graduated but never migrated trades nowhere; this says so and names "
    + "arcnow_migrate. A quote is a snapshot of one block. Anyone else's trade changes it.\n\n"
    + "THE AMOUNT IS IN THE TOKEN'S QUOTE: native USDC, or the ERC-20 (such as EURC) it was "
    + "launched in — arcnow_token names it. Every figure in the answer is labelled with that "
    + "quote's symbol. An ERC-20 quote is pulled with an exact approval, which the answer says.",
  input: {
    address: addressArg("The curve address, or the token address. Either works."),
    quoteIn: decimalArg(
      "How much of the token's quote to spend, in whole units as a person writes it — \"25\", "
      + "\"1.5\" — in the quote the token is priced in: native USDC (18 decimals) or an ERC-20 such "
      + "as EURC (6). It is read exactly in that quote's decimals; more decimal places than the "
      + "quote has is refused, never rounded. A string, because a JSON number cannot hold 18 "
      + "decimals."),
    referrer: addressArg(
      "CURVE ONLY: the address credited with the referral share of the fee. With no referrer "
      + "that share goes to the platform instead. Refused for a token in its pool, whose swap "
      + "has no referrer.").optional(),
    developer: addressArg(
      "CURVE ONLY: the address credited with the developer share of the fee. With none, it "
      + "goes to the platform. Refused for a token in its pool.").optional(),
  },
  async run(args, ctx) {
    const market = await resolveMarket(ctx, args.address as Address);
    const { curve, state } = market;
    const symbol = await ctx.port.token(state.token).symbol();
    if (market.venue === "stranded") {
      return { isError: true, text: strandedText("arcnow_quote_buy") };
    }
    if (market.venue === "pool") return quotePoolBuy(args, ctx, market, symbol);

    const quoteIn = parseQuoteAmount(state.quoteToken, args.quoteIn, "quoteIn");
    const quote = await curve.quoteBuy(quoteIn);
    const split = await curve.previewFeeSplit(
      quote.fee,
      args.referrer as Address | undefined,
      args.developer as Address | undefined,
    );
    const avg = effectivePrice(quote.quoteSpent, quote.tokensOut);

    return {
      text: report(
        `Buy quote — ${money(quoteIn)} into ${symbol} (curve ${addr(curve.address)})`,
        section("what you pay and get", [
          ["venue", "its bonding curve"],
          ["you send", buyPaymentLine(quoteIn, `the curve ${addr(curve.address)}`)],
          ["trade fee", `${money(quote.fee)} — a flat 1% of the input, taken before anything `
          + "reaches the reserve"],
          ["reaches the curve", money(quote.quoteSpent)],
          ["tokens out", qty(quote.tokensOut, symbol)],
          ["refund", quote.refund.isZero()
            ? "none"
            : `${money(quote.refund)} — this buy fills the curve and is capped at the `
              + (state.quoteToken.isNative
                ? "remaining inventory, so the rest comes back"
                : "remaining inventory, so the rest is never pulled")],
          ["average fill price", avg === undefined ? "n/a" : price(avg)],
        ]),
        section("the curve after this buy", [
          ["spot price", `${price(state.spotPrice)} → ${price(quote.newPrice)} `
          + `(${priceMove(state.spotPrice, quote.newPrice)})`],
          ["real reserve", `${money(state.realReserve)} → ${money(quote.newReserve)} `
          + `of ${money(state.target)}`],
          ["tokens sold", `${qty(state.tokensSold)} → ${qty(quote.newTokensSold)}`],
          ["graduates", quote.graduates ? "YES — this is the buy that ends trading" : "no"],
        ]),
        feeSplitSection(quote.fee, split, args.referrer, args.developer),
        section("minimum tokens out, by tolerance", TOLERANCES.map((bps) => {
          const floor = Bps.of(10_000n - bps).applyToTokens(quote.tokensOut);
          return [`${bps} bps (${Number(bps) / 100}%)`, qty(floor, symbol)] as [string, string];
        })),
        quote.graduates ? note(GRADUATING_BUY_WARNING) : undefined,
        note(
          "This quote is one block old the moment it is returned. Any other trade against "
          + "this curve moves it, which is what the minimum-out floor is for.",
        ),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const quoteSell = defineTool({
  name: "arcnow_quote_sell",
  title: "Quote a sell",
  access: "read",
  description:
    "What a given quantity of tokens would fetch right now, wherever the token trades: "
    + "gross proceeds, every fee and who receives it, net proceeds in the token's quote (native "
    + "USDC or an ERC-20 such as EURC), and the minimum-out floor at several tolerances.\n\n"
    + "Costs nothing and signs nothing.\n\n"
    + "ON A BONDING CURVE: selling needs NO approval, ever. The curve pulls the tokens "
    + "through a privileged path that reads no allowance at all, so a holder who has "
    + "approved nobody can always sell. If you find yourself suggesting an approve step "
    + "before a curve sell, you are fixing the wrong problem.\n\n"
    + "IN A UNISWAP V4 POOL (the token graduated and migrated) it is the other way round, and "
    + "worth telling a user before they sell: the router pulls the tokens with transferFrom, "
    + "so a pool sell needs an ERC-20 APPROVAL to the router first — a separate transaction. "
    + "This quote says it is a pool quote, shows arcnow.io's 1% and the pool's own LP fee "
    + "separately, the average fill against the pool's spot price, the price impact, and "
    + "how much `holder` has approved the router for already. A pool sell is priced as a "
    + "real holder, so `holder` must actually hold the tokens; on a writing server it "
    + "defaults to the signing address. referrer and developer are refused on a pool.\n\n"
    + "A token that graduated but never migrated trades nowhere; this says so and names "
    + "arcnow_migrate.",
  input: {
    address: addressArg("The curve address, or the token address. Either works."),
    tokensIn: decimalArg(
      "How many whole tokens to sell, as a string — \"1000\", \"12.5\". Tokens are 18-decimal."),
    holder: addressArg(
      "POOL: the address whose tokens would be sold. A pool sell is priced by simulating the "
      + "real swap as that address, so it must actually hold the tokens. Defaults to the "
      + "signing address on a writing server; required on a read-only one. Not needed on a "
      + "bonding curve, where a sell is priced for nobody in particular.").optional(),
    referrer: addressArg(
      "CURVE ONLY: credited with the referral share of the fee. Refused for a token in its "
      + "pool.").optional(),
    developer: addressArg(
      "CURVE ONLY: credited with the developer share of the fee. Refused for a token in its "
      + "pool.").optional(),
  },
  async run(args, ctx) {
    const market = await resolveMarket(ctx, args.address as Address);
    const { curve, state } = market;
    const symbol = await ctx.port.token(state.token).symbol();
    if (market.venue === "stranded") {
      return { isError: true, text: strandedText("arcnow_quote_sell") };
    }
    if (market.venue === "pool") return quotePoolSell(args, ctx, market, symbol);

    const tokensIn = Tokens.parse(args.tokensIn);
    const quote = await curve.quoteSell(tokensIn);
    const split = await curve.previewFeeSplit(
      quote.fee,
      args.referrer as Address | undefined,
      args.developer as Address | undefined,
    );
    const avg = effectivePrice(quote.gross, tokensIn);

    return {
      text: report(
        `Sell quote — ${qty(tokensIn, symbol)} into curve ${addr(curve.address)}`,
        section("what you give and get", [
          ["venue", "its bonding curve"],
          ["you send", `${qty(tokensIn, symbol)} — no approval needed, and none will be asked for`],
          ["gross", money(quote.gross)],
          ["trade fee", `${money(quote.fee)} — the same flat 1%, taken from the proceeds`],
          ["you receive", money(quote.quoteOut.floorToRepresentable())],
          ["average fill price", avg === undefined ? "n/a" : price(avg)],
        ]),
        section("the curve after this sell", [
          ["spot price", `${price(state.spotPrice)} → ${price(quote.newPrice)} `
          + `(${priceMove(state.spotPrice, quote.newPrice)})`],
          ["real reserve", `${money(state.realReserve)} → ${money(quote.newReserve)}`],
          ["tokens sold", `${qty(state.tokensSold)} → ${qty(quote.newTokensSold)}`],
        ]),
        feeSplitSection(quote.fee, split, args.referrer, args.developer),
        section(`minimum ${state.quoteToken.symbol} out, by tolerance`, TOLERANCES.map((bps) => {
          const floor = Bps.of(10_000n - bps).applyToQuote(quote.quoteOut);
          return [`${bps} bps (${Number(bps) / 100}%)`, money(floor)] as [string, string];
        })),
        args.holder === undefined
          ? undefined
          : note("holder was not needed for this quote: a bonding-curve sell is priced for "
            + "nobody in particular, and needs no approval from anybody."),
        note(
          "A sell moves the price down across your own order the same way a buy moves it up. "
          + "This quote is a snapshot of one block.",
        ),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const quoteLaunch = defineTool({
  name: "arcnow_quote_launch",
  title: "Quote a launch",
  access: "read",
  description:
    "What launching a token would cost, before anything is spent: the flat launch fee, the "
    + "initial buy, the 1% trade fee the initial buy itself pays, the tokens the creator "
    + "would receive, and — given a creator address — the exact addresses the token and its "
    + "curve would land at.\n\n"
    + "Costs nothing and signs nothing. Always call this before arcnow_launch and show the "
    + "user the total, because a launch is irreversible: the name, symbol, supply, curve "
    + "shape and graduation venue are fixed at that transaction and can never be changed "
    + "afterwards, by anyone, including whoever launched it.\n\n"
    + "THE QUOTE. A token is priced for life in the quote it launches in: `quote` names it by "
    + "symbol or address — native USDC by default, or an ERC-20 such as EURC that the quote "
    + "registry accepts (arcnow_quote_tokens). The launch fee and the initial buy are both in that "
    + "quote, and so is every trade in the token afterwards. Native USDC is paid as msg.value; an "
    + "ERC-20 is pulled by the launchpad after an exact approval.\n\n"
    + "The total is EXACTLY what a launch requires, not a minimum — for native USDC the launchpad "
    + "reverts on an overpayment as readily as an underpayment, because it has no refund path.",
  input: {
    name: textArg(64,
      "The token's name. Permanent — there is no setter for it, on any contract, ever."),
    symbol: textArg(16,
      "The token's ticker. Permanent, and not unique: two tokens may share a symbol, so an "
      + "address is the only identifier that means anything."),
    metadataUri: metadataUriArg(),
    initialBuy: decimalArg(
      "How much of the launch's quote the creator spends buying their own token in the launch "
      + "transaction, in whole units, with no more decimals than the quote has. It is an "
      + "ORDINARY buy: it runs through the curve and pays the 1% trade fee on top of the flat "
      + "launch fee. There is no fee-free entry into a curve. \"0\" is allowed."),
    quote: quoteArg(),
    creator: addressArg(
      "Optional: the address that would launch. Given one, this also predicts the token and "
      + "curve addresses — valid only for that address's CURRENT launch nonce and exactly "
      + "these parameters.").optional(),
    platform: addressArg(
      "Optional: the PlatformConfig to launch under. Defaults to arcnow.io's own, which is "
      + "what almost every launch uses.").optional(),
    migrator: addressArg(
      "Optional: where this token graduates to, snapshotted into the curve at launch and "
      + "immutable thereafter. Defaults to the platform's default migrator.").optional(),
  },
  async run(args, ctx) {
    const choice = chooseQuote(ctx.port.config, args.quote);
    // A quote the network does not list is metadata the SDK can read, once and
    // cached — but no spend cap can name it, so arcnow_launch will refuse it.
    const quoteToken: QuoteTokenInfo = choice.listed
      ? choice.token
      : await ctx.port.quoteTokenInfo(choice.address);
    const params = launchParams(args, quoteToken);
    const quote = await ctx.port.launchpad.quoteLaunch(params);
    const predicted = args.creator === undefined
      ? undefined
      : await ctx.port.launchpad.predictAddresses(args.creator as Address, params);

    const platform = (args.platform ?? ctx.port.config.contracts.arcnowPlatform) as Address;
    const [settings, template] = await Promise.all([
      ctx.port.platforms.settings(platform).catch(() => undefined),
      ctx.port.platforms.curveParametersFor(platform, quoteToken).catch(() => undefined),
    ]);
    const migrator = (args.migrator ?? settings?.defaultMigrator) as Address | undefined;
    const launchpad = addr(ctx.port.launchpad.address);

    return {
      text: report(
        `Launch quote — ${args.name} (${args.symbol}), in ${quoteToken.symbol}`,
        section("what it would cost", [
          ["total, exactly", quoteToken.isNative
            ? `${money(quote.totalCost)} — this is the exact value the launch transaction must `
            + "carry. Overpaying reverts; there is no refund path."
            : `${money(quote.totalCost)} — exactly what the launchpad pulls, no more`],
          ["  launch fee", `${money(quote.launchFee)} — flat, to the launchpad, as the quote registry `
          + `sets it for ${quoteToken.symbol} now`],
          ["  initial buy", money(quote.initialBuy)],
          ["  of which fee", `${money(quote.tradeFee)} — the initial buy's own 1%`],
          ["paid as", quoteToken.isNative
            ? `msg.value: exactly ${money(quote.nativeValue)}`
            : `an ERC-20 pull by the launchpad — the transaction carries no value. An exact approve `
              + `of ${money(quote.totalCost)} to the launchpad ${launchpad} is sent first when the `
              + "allowance falls short: a separate transaction, never for more"],
          ["quote", quoteLine(quoteToken)],
          ["tokens received", qty(quote.tokensOut, args.symbol)],
          ["plus gas", "paid in native USDC, the gas currency, whatever the quote"],
          ["graduates at launch", quote.graduates
            ? "YES — the initial buy fills the curve, so the token graduates and migrates in "
            + "the launch transaction itself. The SDK sends it with an explicit 8,000,000 gas "
            + "limit, because an estimated limit starves the migration silently."
            : "no"],
        ]),
        section("what would be fixed forever", [
          ["name / symbol", `${args.name} / ${args.symbol}`],
          ["metadata", args.metadataUri],
          ["platform", `${addr(platform)}${args.platform === undefined ? " (the default)" : ""}`],
          ["graduation venue", migrator === undefined
            ? "the platform's default"
            : `${addr(migrator)} — ${venueOf(migrator, ctx.port.config)}`],
          ["curve shape", template === undefined
            ? `the platform's ${quoteToken.symbol} template, which could not be read`
            : `${qty(template.totalSupply)} total supply, `
              + `${qty(template.curveSupply)} on the curve, `
              + `graduating at ${money(template.target)}, `
              + `y0 ${qty(template.y0)} (the virtual token reserve)`],
        ]),
        predicted === undefined
          ? undefined
          : section("where it would land", [
              ["token", addr(predicted.token)],
              ["curve", addr(predicted.curve)],
              ["valid for", `${addr(args.creator as Address)} at its current launch nonce, with `
              + "exactly these parameters. Any other launch by that address first, and these "
              + "move."],
            ]),
        choice.listed
          ? undefined
          : note(`${quoteToken.symbol} at ${addr(quoteToken.address)} is not one of this network's `
            + "quote tokens, so this server's operator can set no spend cap for it and "
            + "arcnow_launch will refuse to launch in it. Whether the chain would accept it is "
            + "arcnow_quote_tokens' answer."),
        note(
          "Nothing has been spent and nothing has been signed. A launch is irreversible and "
          + "none of the parameters above can be changed afterwards — not by the creator, not "
          + "by the platform, not by anyone. Show this total to the person whose money it is "
          + "before calling arcnow_launch.",
        ),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

/** The launch tools' `quote` argument. */
export function quoteArg() {
  return z.string().min(1).max(64).optional().describe(
    "Optional: the quote token to launch in, by symbol (\"USDC\", \"EURC\") or by address. "
    + "Defaults to native USDC. The token is priced in it FOR LIFE: its launch fee, its initial "
    + "buy, and every trade in it afterwards. A symbol is looked up in this network's own quote "
    + "tokens only. arcnow_quote_tokens lists them with whether the quote registry accepts each "
    + "and this server's spend cap for it; a quote with no cap cannot be launched in here.");
}

const platform = defineTool({
  name: "arcnow_platform",
  title: "Inspect a platform's fees and defaults",
  access: "read",
  description:
    "One platform's configuration: who administers it, who receives its cut, how the 1% "
    + "trade fee is divided between creator, referrer, developer, the platform and the "
    + "protocol, which migrator it launches tokens into by default, and the curve template "
    + "it stamps onto every token it launches.\n\n"
    + "With no address, reports arcnow.io's own platform — the default a launch uses.\n\n"
    + "The single easiest thing to misread here is what a share means. Every share is basis "
    + "points OF THE FEE, never of the trade. A creator share of 3000 bps is 30% of the fee "
    + "and 0.30% of the trade. This tool prints both, every time. The platform's own share "
    + "is never configured: it is the residual, whatever is left after the protocol, "
    + "creator, referrer and developer shares.",
  input: {
    address: addressArg(
      "Optional: the PlatformConfig address. Defaults to arcnow.io's own platform.").optional(),
  },
  async run(args, ctx) {
    const address = (args.address ?? ctx.port.config.contracts.arcnowPlatform) as Address;
    const isPlatform = await ctx.port.platforms.isPlatform(address);
    if (!isPlatform) {
      return {
        isError: true,
        text: `${addr(address)} is not a platform this registry certifies. The registry `
          + "deploys every PlatformConfig itself, precisely so that membership certifies code "
          + "rather than a claim — so an address that answers 'no' here is not a platform, "
          + "whatever it says about itself.",
      };
    }
    const [settings, fees, protocol, template] = await Promise.all([
      ctx.port.platforms.settings(address),
      ctx.port.platforms.feeConfigFor(address),
      ctx.port.platforms.protocolSummary(),
      ctx.port.platforms.curveParametersFor(address),
    ]);
    const isDefault = address.toLowerCase()
      === ctx.port.config.contracts.arcnowPlatform.toLowerCase();

    return {
      text: report(
        `Platform ${addr(address)}${isDefault ? " — arcnow.io's own, the launch default" : ""}`,
        section("who runs it", [
          ["admin", addr(settings.admin)],
          ["fee recipient", addr(settings.feeRecipient)],
          ["certified", "yes — this registry deployed this PlatformConfig itself"],
        ]),
        section("how the 1% trade fee is divided", [
          ["creator", share(settings.creatorShareBps, TRADE_FEE)],
          ["referrer", share(settings.refShareBps, TRADE_FEE)],
          ["developer", share(settings.devShareBps, TRADE_FEE)],
          ["protocol", share(fees.protocolShareBps, TRADE_FEE)],
          ["platform", `${share(settings.platformShareBps, TRADE_FEE)} — the RESIDUAL. Not an `
          + "input anywhere in the contracts; it is 10000 minus the four above, computed on "
          + "demand."],
          ["", "A share whose address is zero at swap time — no referrer, no developer — is "
          + "paid to the platform instead, as is the rounding dust."],
        ]),
        section("defaults it stamps on a launch", [
          ["migrator", `${addr(settings.defaultMigrator)} — `
          + `${venueOf(settings.defaultMigrator, ctx.port.config)}. Snapshotted into each `
          + "curve at launch and immutable from then on."],
          ["platform version", settings.version],
          ["template", `${template.quoteToken.symbol}'s — a platform serves one template per quote `
          + "token it enables; arcnow_quote_launch with `quote` shows another quote's"],
          ["total supply", qty(template.totalSupply)],
          ["on the curve", qty(template.curveSupply)],
          ["held back for the pool", qty(template.totalSupply.sub(template.curveSupply))],
          ["graduation target", money(template.target)],
          ["initial price", price(template.initialPrice)],
          ["y0 (virtual token reserve)", `${qty(template.y0)} — y0Wad ${template.y0.wad}`],
        ]),
        section("the protocol, above every platform", [
          ["share", share(protocol.protocolShareBps, TRADE_FEE)],
          ["recipient", addr(protocol.protocolRecipient)],
          ["launch fee", `${money(protocol.launchFee)} — flat, per launch in native USDC, on top of `
          + "any initial buy. Each quote token has its own: arcnow_quote_tokens"],
        ]),
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const listPlatforms = defineTool({
  name: "arcnow_list_platforms",
  title: "List registered platforms",
  access: "read",
  description:
    "Every platform the registry has deployed, with its fee split and default graduation "
    + "venue. Unlike arcnow_list_tokens this is a real enumeration held in contract storage, "
    + "so it is complete — there is no scan window and nothing is missed.\n\n"
    + "Use it to answer 'what can I launch under' or 'who else builds on this'. Launching "
    + "does not require your own platform; arcnow.io's is the default and is one entry here "
    + "among the others, not a privileged one.",
  input: {
    limit: intArg(1, 50, 20, "How many platforms to return."),
    offset: intArg(0, 1_000_000, 0, "How many to skip, for paging through a long registry."),
  },
  async run(args, ctx) {
    const count = await ctx.port.platforms.platformCount();
    const start = BigInt(args.offset);
    if (start >= count) {
      return {
        text: `This registry has ${count} platform(s); offset ${args.offset} is past the end.`,
      };
    }
    const end = start + BigInt(args.limit) > count ? count : start + BigInt(args.limit);
    const blocks: string[] = [];
    for (let i = start; i < end; i += 1n) {
      const address = await ctx.port.platforms.platformAt(i);
      const isDefault = address.toLowerCase()
        === ctx.port.config.contracts.arcnowPlatform.toLowerCase();
      try {
        const settings = await ctx.port.platforms.settings(address);
        blocks.push(section(`#${i} ${addr(address)}${isDefault ? "  (arcnow.io's own)" : ""}`, [
          ["fee recipient", addr(settings.feeRecipient)],
          ["creator / ref / dev / platform", `${settings.creatorShareBps.bps} / `
          + `${settings.refShareBps.bps} / ${settings.devShareBps.bps} / `
          + `${settings.platformShareBps.bps} bps of the fee`],
          ["default venue", `${addr(settings.defaultMigrator)} — `
          + venueOf(settings.defaultMigrator, ctx.port.config)],
          ["graduation target", "per quote token — arcnow_platform shows it"],
        ]));
      } catch (error) {
        blocks.push(section(`#${i} ${addr(address)}`, [
          ["settings", `could not be read: ${describe(error)}`],
        ]));
      }
    }
    return {
      text: report(
        `${count} platform(s) registered; showing ${start}–${end - 1n}.`,
        ...blocks,
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────

const quoteTokens = defineTool({
  name: "arcnow_quote_tokens",
  title: "Quote tokens a launch may use",
  access: "read",
  description:
    "The quote tokens a token can be launched in — what its bonding curve, and later its pool, "
    + "is priced in for life: native USDC (the gas currency, 18 decimals, paid as msg.value) and "
    + "the ERC-20s arcnow.io's quote registry allowlists, such as EURC (6 decimals, pulled with "
    + "an exact ERC-20 approval). For each: symbol, name, decimals, address, whether it is "
    + "native, its flat launch fee in its own units, whether the registry accepts it for new "
    + "launches now, and this server's spend cap for it.\n\n"
    + "SPEND CAPS ARE PER QUOTE, AND FAIL CLOSED. The operator caps native USDC with "
    + "ARCNOW_MCP_MAX_SPEND_USDC (default 100) and every other quote with "
    + "ARCNOW_MCP_MAX_SPEND_<SYMBOL>, in that quote's own units (ARCNOW_MCP_MAX_SPEND_EURC=50). "
    + "A quote with no cap is REFUSED for every launch and buy, and a quote this network does not "
    + "list can have no cap at all. Tell the user which quotes they can actually spend here "
    + "before offering a launch or a buy in one.\n\n"
    + "Reads the registry in at most three eth_calls. If the chain has no quote registry to ask "
    + "— the 2.x contracts Arc testnet ran until the multi-quote reset have none — this says so, "
    + "shows the error, "
    + "and lists this network's own quote-token metadata instead, with NOTHING known to be "
    + "accepted. Takes no arguments and spends nothing.",
  input: {},
  async run(_args, ctx) {
    let entries: readonly QuoteRegistryEntry[];
    try {
      entries = await ctx.port.quoteRegistry.list();
    } catch (error) {
      return {
        text: report(
          "The quote registry could not be read, so which quote tokens a launch accepts is NOT "
          + "known. Below is this network's own quote-token metadata: what a token could be "
          + "priced in, not what the launchpad takes.",
          renderError("arcnow_quote_tokens", error),
          note("Do not tell a user a quote is accepted on the strength of this list. A launch in "
            + "a quote the registry does not accept reverts QuoteTokenNotSupported; the 2.x "
            + "contracts Arc testnet ran until the multi-quote reset have no registry at all and "
            + "accept only native USDC."),
          ...ctx.port.config.quoteTokens.map((token) => section(`${token.symbol} — ${token.name}`, [
            ...quoteTokenRows(token),
            ["launch fee", "unknown — the registry could not be read"],
            ["accepted", "unknown — the registry could not be read"],
            ["spend cap", capText(ctx, token)],
          ])),
        ),
      };
    }
    return {
      text: report(
        `${entries.length} quote token(s) registered with this launchpad's quote registry.`,
        ...entries.map(({ token, launchFee, active }) => section(`${token.symbol} — ${token.name}`, [
          ...quoteTokenRows(token),
          ["launch fee", `${money(launchFee)} — flat, per launch in ${token.symbol}`],
          ["active", active
            ? "yes — a launch may use it"
            : "NO — deregistered: no new launch may use it. Curves already priced in it keep "
              + "trading"],
          ["spend cap", capText(ctx, token)],
        ])),
        ctx.config.mode === "write"
          ? undefined
          : note("This server is read-only, so it spends nothing in any quote; the caps above are "
            + "what it would enforce with writes enabled."),
      ),
    };
  },
});

function quoteTokenRows(token: QuoteTokenInfo): [string, string][] {
  return [
    ["address", addr(token.address)],
    ["decimals", String(token.decimals)],
    ["kind", token.isNative
      ? "native — the gas currency, paid as msg.value, needing no approval"
      : "ERC-20 — pulled with an exact ERC-20 approval of each spend, never unlimited"],
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers shared with the write tools

export const GRADUATING_BUY_WARNING
  = "THIS BUY GRADUATES THE CURVE, AND THE GAS LIMIT DECIDES WHETHER A MARKET EXISTS. "
    + "The graduating buy migrates the curve in its own transaction, under a bounded gas "
    + "budget whose failure the curve CATCHES rather than reverting. So eth_estimateGas — "
    + "which searches for the lowest limit at which the transaction still succeeds — converges "
    + "on exactly the limit at which the migration is starved. The buy fills, the curve "
    + "graduates, the refund is correct, and the pool is simply never created. There is no "
    + "revert and no error anywhere. The curve budgets 6,000,000 for the migrator and keeps "
    + "100,000 back, so a graduating buy needs comfortably more than 6.1M; this server sends "
    + "8,000,000 on a buy it can see will graduate. If a pool ends up missing anyway, "
    + "migrate() is permissionless and arcnow_migrate finishes it for the cost of gas.";

export function statusLine(graduated: boolean, migrated: boolean): string {
  if (!graduated) return "trading on the curve";
  if (migrated) {
    return "graduated and migrated — trades in its Uniswap v4 pool, and the quote and trade "
      + "tools route there";
  }
  return "GRADUATED but NOT MIGRATED — trading is over and the pool was never created, so it "
    + "trades nowhere. migrate() is permissionless; anyone can finish it.";
}

export function feeSplitSection(
  fee: QuoteAmount,
  split: FeeSplit,
  referrer: string | undefined,
  developer: string | undefined,
): string {
  const rows: [string, string][] = [
    ["creator", `${money(split.creatorAmount)}  → ${addr(split.creator)}`],
    ["platform", `${money(split.platformAmount)}  → ${addr(split.platform)}`],
    ["referrer", referrer === undefined
      ? `${money(split.refAmount)}  → no referrer given, so this goes to the platform`
      : `${money(split.refAmount)}  → ${addr(split.ref)}`],
    ["developer", developer === undefined
      ? `${money(split.devAmount)}  → no developer given, so this goes to the platform`
      : `${money(split.devAmount)}  → ${addr(split.dev)}`],
    ["protocol", `${money(split.protocolAmount)}  → ${addr(split.protocol)}`],
  ];
  return section(`fee split — where the ${money(fee)} goes`, rows);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const READ_TOOLS: readonly AnyTool[] = [
  network,
  quoteTokens,
  listTokens,
  tokenTool,
  quoteBuy,
  quoteSell,
  quoteLaunch,
  platform,
  listPlatforms,
];
