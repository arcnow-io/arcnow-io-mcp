/**
 * The seam between the tools and `@arcnow/sdk`.
 *
 * # Why there is a seam at all
 *
 * Every chain interaction in this server goes through the SDK. Nothing here
 * encodes a call, computes a curve, or knows an address: the SDK owns all of
 * that, it is pinned to a commit in `pins.json`, and it is the thing the
 * project's forked-chain suite actually tests. Reimplementing any of it here
 * would produce a second, unpinned, untested copy of the most expensive code in
 * the project to get wrong.
 *
 * What this file adds is a set of **interfaces the SDK's handles already
 * satisfy**. The SDK's `Curve`, `Token`, `Trade`, `Pool`, `Launchpad` and `PlatformRegistry` are
 * classes with private fields, which means a test cannot construct a stand-in
 * for one — not because faking them is difficult, but because a class with a
 * `private` member is nominally typed and nothing else is assignable to it. So
 * the tools depend on {@link ArcNowPort}, {@link CurveHandle} and friends, and
 * {@link createSdkPort} is the one place that mentions the SDK's classes.
 *
 * That buys the whole suite: a fake port drives every tool through every
 * branch — a graduating buy, a stale quote, a cost over the ceiling, a curve
 * that already migrated — with no chain, no container and no key. The seam is
 * type-level only; it wraps nothing and computes nothing.
 *
 * The types crossing it are the SDK's own: {@link QuoteAmount}, {@link Tokens},
 * {@link Bps}, `CurveState`, `BuyQuote`. Re-describing those would be exactly
 * the reimplementation this file exists to avoid, and the amount types in
 * particular are the reason an amount of EURC cannot be read as USDC, and the
 * 18-decimal native USDC cannot be confused with the 6-decimal ERC-20 view.
 *
 * @module
 */

import type { Address, Hash } from "viem";
import type { AbiEvent } from "viem";

import { getAbiItem } from "viem";
import {
  abi,
  type ArcNowClient,
  type Bps,
  findQuoteToken,
  type BuyQuote,
  type BuyRequest,
  type BuyResult,
  type CurveState,
  type CurveTemplateParams,
  type FeeConfig,
  type FeeSplit,
  type LaunchParams,
  type LaunchQuote,
  type LaunchResult,
  type MigrateResult,
  type NetworkConfig,
  type NewPlatform,
  type PlatformSettings,
  type PoolBuyQuote,
  type PoolFees,
  type PoolKeyStruct,
  QuoteAmount,
  type QuoteFrom,
  type QuoteRegistryEntry,
  type QuoteTokenInfo,
  type RegisterPlatformResult,
  type SellQuote,
  type SellRequest,
  type SellResult,
  type SpendState,
  Tokens,
  type TradeBuyQuote,
  type TradeBuyRequest,
  type TradeBuyResult,
  type TradeSellQuote,
  type TradeSellRequest,
  type TradeSellResult,
  type Venue,
} from "@arcnow/sdk";

/**
 * One graduated token's Uniswap v4 pool: `client.pool(token)`, and the `pool`
 * half of `client.trade(token)`.
 *
 * Only what the tools read or do. Notably absent: `buy` and `sell`, which the
 * tools reach through {@link TradeHandle} so that the venue is decided by the
 * SDK, in one place, and never by this server.
 */
export interface PoolHandle {
  readonly token: Address;
  key(): Promise<PoolKeyStruct>;
  poolId(): Promise<`0x${string}`>;
  /** The PoolManager the liquidity is in. A v4 pool has no address of its own. */
  poolManager(): Promise<Address>;
  /** False with no router configured, or when the router serves another manager. */
  isReachable(): Promise<boolean>;
  /**
   * The pool's quote token: the key's currency that is not the token, whichever
   * of `currency0` and `currency1` that is. Never assume it is `currency0`.
   */
  quoteToken(): Promise<QuoteTokenInfo>;
  /** True when the quote is the key's `currency0`: always for native USDC, either for an ERC-20. */
  quoteIsCurrency0(): Promise<boolean>;
  quoteBuy(quoteIn: QuoteAmount, opts?: QuoteFrom): Promise<PoolBuyQuote>;
  routerAllowance(owner: Address): Promise<Tokens>;
  /** A separate transaction, granting the router spending rights over `amount`. */
  approveRouter(amount: Tokens): Promise<`0x${string}`>;
  /**
   * What the pool's fee hook has charged and not yet paid out, in the pool's quote.
   * `UnknownHookVersion` for a hook that is not `arcnow/arc-now-fee-hook@4.x.x`.
   */
  accruedHookFee(): Promise<QuoteAmount>;
  /**
   * What a trade in this pool costs, **read off the chain**: the hook's 0.80%
   * (`feeBps()`), the pool's 0.20% LP fee (the key's `fee`, in hundredths of a
   * bip), their total in bps of the trade — 100, the same as the curve charged —
   * and how the hook splits its part (creator / platform / protocol; a pool has
   * no referrer share). Every fee figure a pool report prints comes from this,
   * never from a constant here.
   */
  fees(): Promise<PoolFees>;
}

/**
 * `client.trade(token)`: a token traded wherever it currently trades.
 *
 * The write tools send every buy and sell through this, curve or pool, so the
 * SDK's own refusals — a `recipient` on a curve, a `referrer` or `gasLimit` on
 * a pool — stand behind this server's.
 */
export interface TradeHandle {
  readonly token: Address;
  readonly pool: PoolHandle;
  venue(): Promise<Venue>;
  /** The quote token this token trades against for life, read off its curve. */
  quoteToken(): Promise<QuoteTokenInfo>;
  quoteBuy(
    quoteIn: QuoteAmount,
    opts?: { readonly from?: Address | undefined },
  ): Promise<TradeBuyQuote>;
  quoteSell(
    tokensIn: Tokens,
    opts?: { readonly from?: Address | undefined },
  ): Promise<TradeSellQuote>;
  buy(request: TradeBuyRequest): Promise<TradeBuyResult>;
  sell(request: TradeSellRequest): Promise<TradeSellResult>;
}

/** One `Launchpad.Launched` log, decoded. */
export interface LaunchRecord {
  readonly token: Address;
  readonly curve: Address;
  readonly creator: Address;
  readonly platform: Address;
  readonly migrator: Address;
  /**
   * The quote the token launched in, from the log's own `quoteToken` field and
   * labelled from the network's `quoteTokens` — no RPC — or, for a quote the
   * network does not list, the SDK's per-process cached metadata read.
   */
  readonly quoteToken: QuoteTokenInfo;
  readonly launchFee: QuoteAmount;
  readonly initialBuy: QuoteAmount;
  readonly tokensOut: Tokens;
  readonly blockNumber: bigint;
  readonly txHash: Hash;
}

/** What a launch scan looked at, so a caller is never told more than was seen. */
export interface LaunchScan {
  readonly launches: readonly LaunchRecord[];
  readonly tipBlock: bigint;
  readonly scannedFromBlock: bigint;
  readonly scannedToBlock: bigint;
  /** True when the scan reached the block the deployment starts at. */
  readonly reachedDeployment: boolean;
  /** True when the scan stopped on its chunk budget with history left unread. */
  readonly stoppedOnBudget: boolean;
}

export interface ListLaunchesOptions {
  readonly limit: number;
  readonly creator?: Address | undefined;
  readonly token?: Address | undefined;
}

export interface CurveHandle {
  readonly address: Address;
  state(): Promise<CurveState>;
  quoteBuy(quoteIn: QuoteAmount): Promise<BuyQuote>;
  quoteSell(tokensIn: Tokens): Promise<SellQuote>;
  /**
   * The four amounts and addresses a curve fee resolves to: creator, platform,
   * referrer, protocol.
   */
  previewFeeSplit(fee: QuoteAmount, referrer?: Address): Promise<FeeSplit>;
  feeConfig(): Promise<FeeConfig>;
  pendingWithdrawal(account: Address): Promise<QuoteAmount>;
  buy(request: BuyRequest): Promise<BuyResult>;
  sell(request: SellRequest): Promise<SellResult>;
  migrate(): Promise<MigrateResult>;
  withdraw(to: Address): Promise<{ amount: QuoteAmount; txHash: Hash }>;
}

export interface TokenHandle {
  readonly address: Address;
  name(): Promise<string>;
  symbol(): Promise<string>;
  metadataUri(): Promise<string>;
  totalSupply(): Promise<Tokens>;
  balanceOf(account: Address): Promise<Tokens>;
  creator(): Promise<Address>;
  curve(): Promise<Address>;
  migratedPool(): Promise<Address>;
  canonicalRouter(): Promise<Address>;
}

export interface LaunchpadHandle {
  readonly address: Address;
  /**
   * The launch fee in `quote` (native USDC when omitted), read from the quote
   * registry. Zero for every quote arcnow.io registers — launching is free — but
   * read, never assumed.
   */
  launchFee(quote?: Address): Promise<QuoteAmount>;
  quoteLaunch(params: LaunchParams): Promise<LaunchQuote>;
  predictAddresses(creator: Address, params: LaunchParams): Promise<{
    token: Address;
    curve: Address;
  }>;
  launch(params: LaunchParams): Promise<LaunchResult>;
}

export interface PlatformsHandle {
  readonly address: Address;
  isPlatform(platform: Address): Promise<boolean>;
  platformCount(): Promise<bigint>;
  platformAt(index: bigint): Promise<Address>;
  settings(platform: Address): Promise<PlatformSettings>;
  feeConfigFor(platform: Address): Promise<FeeConfig>;
  checkCurveTemplate(template: CurveTemplateParams, platform?: Address): Promise<void>;
  /**
   * The template `platform` serves launches in `quote`. `NoCurveParameters` when
   * the platform has not enabled that quote.
   */
  curveParametersFor(
    platform: Address,
    quote?: Address | QuoteTokenInfo,
  ): Promise<CurveTemplateParams>;
  registerPlatform(platform: NewPlatform): Promise<RegisterPlatformResult>;
  protocolSummary(): Promise<{
    protocolShareBps: Bps;
    protocolRecipient: Address;
    launchFee: QuoteAmount;
  }>;
}

/** `client.quoteRegistry`: the allowlist of quote tokens a launch may use. */
export interface QuoteRegistryHandle {
  /** Every registered quote, in at most three `eth_call`s. */
  list(): Promise<readonly QuoteRegistryEntry[]>;
}

/** Everything the tools are allowed to reach. */
export interface ArcNowPort {
  readonly config: NetworkConfig;
  readonly canWrite: boolean;
  readonly signerAddress: Address | undefined;
  curve(address: Address): CurveHandle;
  token(address: Address): TokenHandle;
  /** The token wherever it trades: `client.trade(token)`. Every buy and sell goes through it. */
  trade(token: Address): TradeHandle;
  readonly launchpad: LaunchpadHandle;
  readonly platforms: PlatformsHandle;
  readonly quoteRegistry: QuoteRegistryHandle;
  /**
   * What `owner` holds of a quote token and, for an ERC-20 with a `spender`
   * named, what it has approved that spender for — in ONE Multicall3 `eth_call`
   * (`client.quoteToken(token).spendState`). Native USDC is the account's native
   * balance and has no allowance.
   */
  quoteSpendState(token: QuoteTokenInfo, owner: Address, spender?: Address): Promise<SpendState>;
  /**
   * A quote token's metadata: the network's `quoteTokens` with no RPC, otherwise
   * one cached Multicall3 read of `symbol`, `name` and `decimals`.
   */
  quoteTokenInfo(address: Address): Promise<QuoteTokenInfo>;
  listLaunches(options: ListLaunchesOptions): Promise<LaunchScan>;
  verifyChain(): Promise<void>;
}

/** How far back and in what steps a launch scan walks. */
export interface ScanLimits {
  readonly chunkBlocks: bigint;
  readonly maxChunks: number;
}

const LAUNCHED_EVENT = getAbiItem({ abi: abi.launchpadAbi, name: "Launched" }) as AbiEvent;

/**
 * Wrap a live {@link ArcNowClient}. The only function in this repository that
 * names the SDK's classes.
 */
export function createSdkPort(client: ArcNowClient, limits: ScanLimits): ArcNowPort {
  return {
    config: client.config,
    canWrite: client.canWrite,
    signerAddress: client.walletClient?.account?.address,
    curve: (address) => client.curve(address),
    token: (address) => client.token(address),
    trade: (address) => client.trade(address),
    launchpad: client.launchpad,
    platforms: client.platforms,
    quoteRegistry: client.quoteRegistry,
    quoteSpendState: (token, owner, spender) => client.quoteToken(token).spendState(owner, spender),
    quoteTokenInfo: (address) => client.quoteTokenInfo(address),
    verifyChain: () => client.verifyChain(),
    async listLaunches(options) {
      return scanLaunches(client, limits, options);
    },
  };
}

/**
 * Walk `Launchpad.Launched` backwards from the tip.
 *
 * **This is the one thing the SDK does not do for us.** There is no enumeration
 * anywhere in `@arcnow/sdk` — deliberately, per its `networks.json`: a token and
 * its curve come from this log, one pair per launch, and there are as many as
 * there have been launches, so a network preset cannot carry them. That leaves
 * "show me the recent tokens", which is the first thing anyone asks an
 * assistant, with nowhere to come from.
 *
 * So this reads the log directly — with the SDK's own pinned ABI, through the
 * SDK's own configured client, at the SDK's own launchpad address. Nothing is
 * re-derived; the only thing added is the scan. It is written down in the
 * README as a gap in the SDK rather than a feature of this server, because that
 * is what it is: a `launchpad.recentLaunches()` belongs there, where the fork
 * suite could test it against a real chain.
 *
 * Backwards from the tip, in chunks, with a budget — because a public endpoint
 * will refuse an unbounded range and the deployment starts six million blocks
 * back. What it could not reach is reported rather than implied.
 */
async function scanLaunches(
  client: ArcNowClient,
  limits: ScanLimits,
  options: ListLaunchesOptions,
): Promise<LaunchScan> {
  const tip = await client.publicClient.getBlockNumber();
  const floor = BigInt(client.config.deployedAtBlock ?? 0);
  const found: LaunchRecord[] = [];

  let upper = tip;
  let chunks = 0;
  let lowest = tip;

  while (upper >= floor && chunks < limits.maxChunks && found.length < options.limit) {
    const lower = upper + 1n > limits.chunkBlocks
      ? bigMax(floor, upper - limits.chunkBlocks + 1n)
      : floor;
    const logs = await client.publicClient.getLogs({
      address: client.config.contracts.launchpad,
      event: LAUNCHED_EVENT,
      args: {
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.creator === undefined ? {} : { creator: options.creator }),
      },
      fromBlock: lower,
      toBlock: upper,
    });
    // Newest first, which is the order a person means by "recent".
    for (const log of [...logs].reverse()) {
      const args = log.args as Record<string, unknown>;
      // The quote is in the log itself: labelling it costs nothing for a quote
      // the network lists, and one cached read per process for one it does not.
      const quoteAddress = args.quoteToken as Address;
      const quoteToken = findQuoteToken(client.config, quoteAddress)
        ?? await client.quoteTokenInfo(quoteAddress);
      found.push({
        token: args.token as Address,
        curve: args.curve as Address,
        creator: args.creator as Address,
        platform: args.platform as Address,
        migrator: args.migrator as Address,
        quoteToken,
        launchFee: QuoteAmount.fromWad(quoteToken, args.launchFeeWad as bigint),
        initialBuy: QuoteAmount.fromWad(quoteToken, args.initialBuyWad as bigint),
        tokensOut: Tokens.fromWad(args.tokensOutWad as bigint),
        blockNumber: log.blockNumber ?? 0n,
        txHash: log.transactionHash ?? ("0x"),
      });
      if (found.length >= options.limit) break;
    }
    lowest = lower;
    chunks += 1;
    if (lower <= floor) break;
    upper = lower - 1n;
  }

  return {
    launches: found.slice(0, options.limit),
    tipBlock: tip,
    scannedFromBlock: lowest,
    scannedToBlock: tip,
    reachedDeployment: lowest <= floor,
    stoppedOnBudget: lowest > floor && found.length < options.limit,
  };
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
