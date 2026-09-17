/**
 * A chain that does exactly what a test says it does.
 *
 * Every tool in this server takes an {@link ArcNowPort} rather than the SDK's
 * classes (see `src/sdk-port.ts` for why), so the whole suite runs against this
 * — no RPC, no container, no key, no funds. What that buys is the ability to
 * test the states that actually matter and are hardest to reach on a real
 * chain: a buy that graduates, a curve that graduated and never migrated, a
 * cost that moved between the quote and the order, a pool sell whose approval
 * went through and whose swap then did not, a curve priced in EURC.
 *
 * It also **records every write**, so a test can assert the thing that matters
 * most about a refusal: that nothing was sent. An ERC-20 quote approval is a
 * write too (`write:quote.approve`), recorded exactly when the SDK would send
 * one: the allowance to that spender falls short of the spend.
 *
 * # The trade handle behaves like the SDK's, refusals included
 *
 * `trade(token)` dispatches on the curve state's `migrated` flag the way
 * `client.trade(token).venue()` dispatches on `token.migratedPool()`, and it
 * refuses what the SDK refuses — a `recipient` on the curve, a `referrer` or
 * `gasLimit` on the pool, a pool sell with too small an allowance, an amount in
 * another quote (`QuoteTokenMismatch`), an ERC-20 amount below one raw unit
 * (`QuoteAmountNotRepresentable`).
 *
 * # Quote tokens
 *
 * The curve's quote is `script.quote`, native USDC by default. Every amount the
 * fake returns is a `QuoteAmount` of it. The pool key is ordered the way v4
 * orders it — `currency0 = min(quote, token)`, native always first — unless a
 * test forces an orientation with `quoteIsCurrency0`.
 *
 * # One curve, and versions checked the way the SDK checks them
 *
 * arcnow.io has one bonding curve, the constant-product
 * `arcnow/bonding-curve@4.x.x` of the fee-model stack. Before every read, quote
 * and trade this fake runs the SDK's own `assertCurveVersion` on the scripted
 * version, before a platform read or a launch its `assertPlatformVersion`, and
 * before anything is read off the pool's hook its `assertHookVersion`, so any
 * other version — the retired multi-quote `@3.x.x` stack included — throws the
 * SDK's own refusal. The pool's fee hook is `arcnow/arc-now-fee-hook@4.x.x`.
 *
 * # Fees, the way the live stack charges them
 *
 * The curve's 1% is split four ways — creator 3000 / ref 1000 / platform 3500 /
 * protocol 2500, arcnow.io's own — and there is no developer share anywhere.
 * The pool's hook takes {@link POOL_TRADE_FEE_BPS} (0.80%) off a buy's input
 * or out of a sell's payout and splits it creator 5000 / platform 1875 /
 * protocol 3125; the pool key carries {@link POOL_LP_FEE_PIPS} (0.20%) unless a
 * test scripts another LP fee, and `fees()` reports whatever the key carries,
 * as the SDK's does. Launching is free: every launch fee this fake reports is
 * zero, as the quote registry's is on both live networks.
 */

import type { Address, Hash } from "viem";
import type {
  BuyQuote,
  BuyRequest,
  BuyResult,
  CurveParams,
  CurveState,
  CurveTemplateParams,
  FeeConfig,
  FeeSplit,
  LaunchParams,
  LaunchQuote,
  LaunchResult,
  MigrateResult,
  NetworkConfig,
  NewPlatform,
  PlatformSettings,
  PoolBuyQuote,
  PoolSellQuote,
  PoolTradeResult,
  QuoteRegistryEntry,
  QuoteTokenInfo,
  RegisterPlatformResult,
  SellQuote,
  SellRequest,
  SellResult,
  SpendState,
  TradeBuyRequest,
  TradeSellRequest,
} from "@arcnow/sdk";
import {
  ArcNowError,
  assertCurveVersion,
  assertHookVersion,
  assertPlatformVersion,
  Bps,
  buyFeeFromQuoteIn,
  CurveTemplate,
  erc20GasLimit,
  findQuoteToken,
  NATIVE_USDC,
  POOL_CREATOR_SHARE_BPS,
  POOL_LP_FEE_PIPS,
  POOL_PLATFORM_SHARE_BPS,
  POOL_PROTOCOL_SHARE_BPS,
  POOL_TRADE_FEE_BPS,
  QuoteAmount,
  quoteTokenInfo,
  requireSameQuote,
  resolveNetwork,
  sellFeeFromQuoteOut,
  withPoolQuoteTransferHeadroom,
  Tokens,
  Usdc,
  WAD,
} from "@arcnow/sdk";

import type {
  ArcNowPort,
  CurveHandle,
  LaunchpadHandle,
  LaunchScan,
  ListLaunchesOptions,
  PlatformsHandle,
  PoolHandle,
  QuoteRegistryHandle,
  TokenHandle,
  TradeHandle,
} from "../../src/sdk-port.js";

export const NETWORK = resolveNetwork("arc-testnet");

export const CURVE = "0x1111111111111111111111111111111111111111" as Address;
export const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
export const SIGNER = "0x3333333333333333333333333333333333333333" as Address;
export const CREATOR = "0x4444444444444444444444444444444444444444" as Address;
export const PAYEE = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const TX = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hash;
export const POOL_TX
  = "0xabc0000000000000000000000000000000000000000000000000000000000002" as Hash;
export const APPROVE_TX
  = "0xabc0000000000000000000000000000000000000000000000000000000000003" as Hash;
/** The ERC-20 quote approve the SDK sends before pulling a EURC spend. */
export const QUOTE_APPROVE_TX
  = "0xabc0000000000000000000000000000000000000000000000000000000000004" as Hash;
export const POOL_ID
  = "0xfb4d91443a9b700371ff88a0c86c171b541aed24920922593a2d314e6a48d083" as `0x${string}`;

// Read from the SDK's own preset, so a test asserting "the router is named"
// asserts the address the SDK would really trade through.
export const ROUTER: Address = NETWORK.contracts.v4Router ?? ZERO;
export const POOL_MANAGER: Address = NETWORK.v4?.poolManager ?? ZERO;
export const FEE_HOOK: Address = NETWORK.contracts.feeHook ?? ZERO;

/** Native USDC, as the network lists it. */
export const USDC: QuoteTokenInfo = NETWORK.quoteTokens.find((q) => q.isNative) ?? NATIVE_USDC;
/** EURC, 6 decimals, as the SDK's networks.json lists it for Arc testnet. */
export const EURC: QuoteTokenInfo = (() => {
  const eurc = NETWORK.quoteTokens.find((q) => q.symbol === "EURC");
  if (eurc === undefined) throw new Error("the SDK's arc-testnet preset lists no EURC");
  return eurc;
})();
/**
 * An 18-decimal ERC-20 quote that Arc testnet's networks.json does NOT list. Its
 * address sorts below {@link TOKEN}, so its pool has the quote as currency0 —
 * the other orientation from EURC's.
 */
export const WETHX: QuoteTokenInfo = quoteTokenInfo({
  address: "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
  symbol: "WETHX",
  name: "Test Eighteen",
  decimals: 18,
});

/** The one bonding curve the SDK prices: the fee-model stack's. */
export const CURVE_VERSION = "arcnow/bonding-curve@4.0.0";
/** The retired multi-quote stack's curve, refused by name and never priced. */
export const RETIRED_CURVE_VERSION = "arcnow/bonding-curve@3.0.0";
/** What an arcnow.io token answers to VERSION(), which the SDK reads when asked for a curve. */
export const TOKEN_VERSION = "arcnow/arc-token@2.0.0";
export const HOOK_VERSION = "arcnow/arc-now-fee-hook@4.0.0";
/** The retired multi-quote stack's hook, which charged the curve's 1% in the pool. */
export const RETIRED_HOOK_VERSION = "arcnow/arc-now-fee-hook@3.0.0";
export const PLATFORM_VERSION = "arcnow/platform-config@4.0.0";
export const RETIRED_PLATFORM_VERSION = "arcnow/platform-config@3.0.0";

/** What the testnet template snapshots onto a curve: the SDK's own figures. */
export const CURVE_PARAMS: CurveParams = CurveTemplate.params(CurveTemplate.arcnowDefaults());

/** The hook's rate, as `Pool.fees()` reads it: 80 bps of the trade. */
export const HOOK_FEE = Bps.of(POOL_TRADE_FEE_BPS);

/** Orders below this fill at the spot price: the probe a spot price is read from. */
const IMPACT_FREE_BELOW_WAD = WAD / 20n;

export interface FakeScript {
  /** The quote token the curve (and its pool) is priced in. Native USDC by default. */
  quote?: QuoteTokenInfo | undefined;
  /** Force the pool key's orientation. By default, v4's: `currency0 = min(quote, token)`. */
  quoteIsCurrency0?: boolean | undefined;
  /** What the signer has already approved EVERY spender for, in the quote. Zero by default. */
  quoteAllowance?: string | undefined;
  /** What the signer holds of the quote. 500 by default. */
  quoteBalance?: string | undefined;
  /** What `client.quoteRegistry.list()` answers. Native USDC and EURC, both active, by default. */
  quoteRegistry?: readonly QuoteRegistryEntry[] | undefined;
  /** Thrown by `client.quoteRegistry.list()`: a chain with no registry to ask. */
  quoteRegistryThrows?: unknown;
  /** Quotes the platform serves no template for: `NoCurveParameters`. */
  noTemplateFor?: readonly Address[] | undefined;
  /** Quote tokens `quoteTokenInfo` can resolve that the network does not list. */
  unlistedQuotes?: readonly QuoteTokenInfo[] | undefined;
  state?: Partial<CurveState> | undefined;
  buyQuote?: Partial<BuyQuote> | undefined;
  sellQuote?: Partial<SellQuote> | undefined;
  launchQuote?: Partial<LaunchQuote> | undefined;
  buyResult?: Partial<BuyResult> | undefined;
  launchResult?: Partial<LaunchResult> | undefined;
  /** Thrown by a curve buy before anything is recorded as sent: the SDK's simulation rejecting. */
  curveBuyThrows?: unknown;
  /** The node's gas estimate for an ERC-20 curve buy or pool swap. 300,000 by default. */
  gasEstimate?: bigint | undefined;
  /** Thrown by a curve sell before anything is recorded as sent. */
  curveSellThrows?: unknown;
  /** Thrown by a launch, after any quote approval went through. */
  launchThrows?: unknown;
  migratedPool?: Address | undefined;
  pendingWithdrawal?: string | undefined;
  /** Thrown by every curve read, to exercise "this is not an arcnow.io address". */
  curveThrows?: unknown;
  /** Thrown by a curve read of THIS address only: the "you gave me the token" case. */
  notACurve?: Address | undefined;
  tokenCurveThrows?: unknown;
  /** The platform's `VERSION()`. Defaults to the one the SDK accepts. */
  platformVersion?: string | undefined;

  /** The pool's spot price, in the quote per token. */
  poolPrice?: string | undefined;
  /** The pool key's LP fee, in hundredths of a bip. The migrator's 2000 (0.20%) by default. */
  poolFee?: number | undefined;
  /** How far an order worse than the spot price fills, in bps. */
  poolImpactBps?: bigint | undefined;
  poolReachable?: boolean | undefined;
  /** What the signer has already approved the router for, in the token. */
  routerAllowance?: Tokens | undefined;
  /** Thrown by a pool sell after any approval has gone through. */
  poolSellThrows?: unknown;
  /** Thrown by every pool buy quote, the spot-price probe included. */
  poolQuoteBuyThrows?: unknown;
  /** Thrown by a pool buy before anything is recorded as sent. */
  poolBuyThrows?: unknown;
  /** The pool's fee hook `VERSION()`. Defaults to the one the SDK accepts. */
  hookVersion?: string | undefined;
  /** What the hook holds accrued for the pool before the first swap here, in the quote. */
  accruedHookFee?: string | undefined;
}

export interface RecordedCall {
  readonly what: string;
  readonly args: unknown;
}

export function defaultState(
  over: Partial<CurveState> = {},
  quote: QuoteTokenInfo = USDC,
): CurveState {
  const q = (value: string): QuoteAmount => QuoteAmount.parse(quote, value);
  return {
    version: CURVE_VERSION,
    quoteToken: quote,
    params: CURVE_PARAMS,
    curveSupply: Tokens.parse("741000000"),
    tradeFeeBps: Bps.of(100n),
    token: TOKEN,
    creator: CREATOR,
    migrator: NETWORK.contracts.v4Migrator ?? CURVE,
    spotPrice: q("0.0001"),
    tokensSold: Tokens.parse("100000000"),
    tokensRemaining: Tokens.parse("641000000"),
    realReserve: q("12000"),
    virtualReserve: q("3000"),
    target: q("50000"),
    progressBps: Bps.of(2400n),
    graduated: false,
    migrated: false,
    ...over,
  };
}

/** The SDK's own check, on the scripted curve: anything but `@4.x.x` throws its refusal. */
function checkCurve(state: CurveState, address: Address): void {
  assertCurveVersion(state.version, `the curve at ${address}`, address);
}

function defaultBuyQuote(quote: QuoteTokenInfo, over: Partial<BuyQuote> = {}): BuyQuote {
  const q = (value: string): QuoteAmount => QuoteAmount.parse(quote, value);
  return {
    tokensOut: Tokens.parse("250000"),
    fee: q("1"),
    quoteSpent: q("99"),
    refund: QuoteAmount.zero(quote),
    newReserve: q("12099"),
    newTokensSold: Tokens.parse("100250000"),
    newPrice: q("0.000102"),
    graduates: false,
    ...over,
  };
}

function defaultSellQuote(quote: QuoteTokenInfo, over: Partial<SellQuote> = {}): SellQuote {
  const q = (value: string): QuoteAmount => QuoteAmount.parse(quote, value);
  return {
    quoteOut: q("97.9"),
    fee: q("0.99"),
    gross: q("98.89"),
    newReserve: q("11901"),
    newTokensSold: Tokens.parse("99750000"),
    newPrice: q("0.000098"),
    ...over,
  };
}

export const PLATFORM_RECIPIENT = "0x5555555555555555555555555555555555555555" as Address;
export const PROTOCOL_RECIPIENT = "0x6666666666666666666666666666666666666666" as Address;

/** arcnow.io's own curve split: creator 3000 / ref 1000 / platform 3500 / protocol 2500. */
export function feeConfig(): FeeConfig {
  return {
    creatorShareBps: Bps.of(3000n),
    platformShareBps: Bps.of(3500n),
    refShareBps: Bps.of(1000n),
    protocolShareBps: Bps.of(2500n),
    platformRecipient: PLATFORM_RECIPIENT,
    protocolRecipient: PROTOCOL_RECIPIENT,
  };
}

/** The hook's split of its 0.80%, as it is written at graduation: no referrer share. */
export function poolFeeConfig(): FeeConfig {
  return {
    creatorShareBps: Bps.of(POOL_CREATOR_SHARE_BPS),
    platformShareBps: Bps.of(POOL_PLATFORM_SHARE_BPS),
    refShareBps: Bps.ZERO,
    protocolShareBps: Bps.of(POOL_PROTOCOL_SHARE_BPS),
    platformRecipient: PLATFORM_RECIPIENT,
    protocolRecipient: PROTOCOL_RECIPIENT,
  };
}

/**
 * Four amounts that total the fee: the three proportional shares floored, the
 * platform the residual.
 */
function feeSplit(fee: QuoteAmount, referrer?: Address): FeeSplit {
  const cfg = feeConfig();
  const creatorAmount = cfg.creatorShareBps.applyToQuote(fee);
  const refAmount = cfg.refShareBps.applyToQuote(fee);
  const protocolAmount = cfg.protocolShareBps.applyToQuote(fee);
  return {
    creator: CREATOR,
    platform: cfg.platformRecipient,
    ref: referrer ?? cfg.platformRecipient,
    protocol: cfg.protocolRecipient,
    creatorAmount,
    platformAmount: fee.sub(creatorAmount).sub(refAmount).sub(protocolAmount),
    refAmount,
    protocolAmount,
  };
}

export function platformSettings(over: Partial<PlatformSettings> = {}): PlatformSettings {
  return {
    admin: "0x7777777777777777777777777777777777777777" as Address,
    feeRecipient: PLATFORM_RECIPIENT,
    creatorShareBps: Bps.of(3000n),
    refShareBps: Bps.of(1000n),
    platformShareBps: Bps.of(3500n),
    defaultMigrator: NETWORK.contracts.v4Migrator ?? CURVE,
    version: PLATFORM_VERSION,
    ...over,
  };
}

/** arcnow.io's shipped template, re-denominated in `quote` for a fake platform that enables it. */
export function templateIn(quote: QuoteTokenInfo): CurveTemplateParams {
  const native = CurveTemplate.arcnowDefaults();
  return {
    ...native,
    quoteToken: quote,
    r0: QuoteAmount.fromWad(quote, native.r0.wad),
    target: QuoteAmount.fromWad(quote, native.target.wad),
    initialPrice: QuoteAmount.fromWad(quote, native.initialPrice.wad),
  };
}

/** The same refusal the SDK's `Trade` makes, so a forwarded parameter cannot pass unnoticed. */
function refuseCurveOnly(request: {
  referrer?: Address | undefined;
  gasLimit?: bigint | undefined;
}): void {
  const named = (["referrer", "gasLimit"] as const)
    .filter((field) => request[field] !== undefined);
  if (named.length === 0) return;
  throw new ArcNowError({
    code: "InvalidArgument",
    message: `(fake SDK) ${named.join(" and ")} is a curve-only option and this token trades in its pool`,
  });
}

function refusePoolOnly(recipient: Address | undefined): void {
  if (recipient === undefined) return;
  throw new ArcNowError({
    code: "InvalidArgument",
    message: "(fake SDK) recipient is a pool-only option and this token is still on its curve",
  });
}

type FakePool = PoolHandle & {
  quoteSell(
    tokensIn: Tokens,
    opts?: { readonly from?: Address | undefined },
  ): Promise<PoolSellQuote>;
  buy(request: TradeBuyRequest): Promise<PoolTradeResult>;
  sell(request: TradeSellRequest): Promise<PoolTradeResult>;
};

export class FakePort implements ArcNowPort {
  readonly config: NetworkConfig;
  readonly calls: RecordedCall[] = [];
  canWrite: boolean;
  signerAddress: Address | undefined;
  /** The signer's allowance to the router, which approvals and pool sells move. */
  allowance: Tokens;
  /** The signer's quote allowance to each spender (lower-cased), which approves and spends move. */
  readonly quoteAllowances = new Map<string, QuoteAmount>();
  /** The hook's accrued fee for the pool: charged, not yet paid out. */
  accrued: QuoteAmount;
  /** The curve's quote token. */
  readonly quote: QuoteTokenInfo;

  constructor(private readonly script: FakeScript = {}, options: {
    canWrite?: boolean | undefined;
    signerAddress?: Address | undefined;
    config?: NetworkConfig | undefined;
  } = {}) {
    this.canWrite = options.canWrite ?? true;
    // `in`, not `??`: a read-only port is built with signerAddress explicitly
    // undefined, and `undefined ?? SIGNER` quietly handed it a signer anyway.
    this.signerAddress = "signerAddress" in options ? options.signerAddress : SIGNER;
    this.config = options.config ?? NETWORK;
    this.quote = script.quote ?? USDC;
    this.allowance = script.routerAllowance ?? Tokens.ZERO;
    this.accrued = QuoteAmount.parse(this.quote, script.accruedHookFee ?? "0");
  }

  /** Every write this port was asked to perform. Empty is the assertion. */
  get writes(): readonly RecordedCall[] {
    return this.calls.filter((c) => c.what.startsWith("write:"));
  }

  private record(what: string, args: unknown): void {
    this.calls.push({ what, args });
  }

  /** The SDK's platform check, on the scripted platform version. */
  private checkPlatform(platform: Address): void {
    assertPlatformVersion(
      this.script.platformVersion ?? PLATFORM_VERSION, `the platform at ${platform}`, platform);
  }

  private quoteAllowanceTo(spender: Address, token: QuoteTokenInfo): QuoteAmount {
    return this.quoteAllowances.get(spender.toLowerCase())
      ?? QuoteAmount.parse(token, this.script.quoteAllowance ?? "0");
  }

  /**
   * The SDK's `ensureAllowance`: nothing for native USDC; for an ERC-20, an exact
   * approve of the spend when the allowance to `spender` falls short.
   */
  private ensureQuoteAllowance(spender: Address, amount: QuoteAmount): Hash | undefined {
    if (amount.token.isNative) return undefined;
    amount.toRaw();
    if (!this.quoteAllowanceTo(spender, amount.token).lt(amount)) return undefined;
    this.record("write:quote.approve", {
      token: amount.token.address, spender, amount: amount.toString(),
    });
    this.quoteAllowances.set(spender.toLowerCase(), amount);
    return QUOTE_APPROVE_TX;
  }

  /** What a pull of `amount` leaves of the allowance to `spender`. */
  private spendQuoteAllowance(spender: Address, amount: QuoteAmount): void {
    if (amount.token.isNative) return;
    const left = this.quoteAllowanceTo(spender, amount.token).subSaturating(amount);
    this.quoteAllowances.set(spender.toLowerCase(), left);
  }

  verifyChain(): Promise<void> {
    return Promise.resolve();
  }

  quoteSpendState(token: QuoteTokenInfo, owner: Address, spender?: Address): Promise<SpendState> {
    this.record("read:quote.spendState", { token: token.address, owner, spender });
    const balance = QuoteAmount.parse(token, this.script.quoteBalance ?? "500");
    if (token.isNative || spender === undefined) return Promise.resolve({ balance });
    return Promise.resolve({ balance, allowance: this.quoteAllowanceTo(spender, token) });
  }

  quoteTokenInfo(address: Address): Promise<QuoteTokenInfo> {
    this.record("read:quoteTokenInfo", { address });
    const known = findQuoteToken(this.config, address)
      ?? this.script.unlistedQuotes?.find((q) => q.address === address.toLowerCase());
    if (known === undefined) {
      return Promise.reject(new ArcNowError({
        code: "RpcFailure",
        message: `(fake SDK) ${address} answered no symbol(), name() or decimals()`,
      }));
    }
    return Promise.resolve(known);
  }

  get quoteRegistry(): QuoteRegistryHandle {
    const port = this;
    return {
      list() {
        port.record("read:quoteRegistry.list", {});
        if (port.script.quoteRegistryThrows !== undefined) {
          return Promise.reject(port.script.quoteRegistryThrows as Error);
        }
        // The network's own quotes — mainnet's EURC on a mainnet port — each free to launch in.
        return Promise.resolve(port.script.quoteRegistry
          ?? port.config.quoteTokens.map((token) => (
            { token, launchFee: QuoteAmount.zero(token), active: true })));
      },
    };
  }

  curve(address: Address): CurveHandle {
    const port = this;
    const script = this.script;
    const quote = this.quote;
    const state = (): CurveState => defaultState(script.state, quote);
    return {
      address,
      state() {
        if (script.curveThrows !== undefined) throw script.curveThrows;
        if (script.notACurve !== undefined && script.notACurve === address) {
          // What the SDK really does with a token address: every arcnow.io
          // contract answers VERSION(), and a token's is not a curve's.
          assertCurveVersion(TOKEN_VERSION, `the curve at ${address}`, address);
        }
        const current = state();
        checkCurve(current, address);
        return Promise.resolve(current);
      },
      quoteBuy(quoteIn: QuoteAmount) {
        checkCurve(state(), address);
        requireSameQuote(quoteIn, quote, `the curve at ${address}`);
        port.record("read:quoteBuy", { quoteIn: quoteIn.toString(), symbol: quoteIn.token.symbol });
        if (state().graduated) {
          return Promise.reject(new Error("execution reverted: CurveGraduated()"));
        }
        return Promise.resolve(defaultBuyQuote(quote, script.buyQuote));
      },
      quoteSell(tokensIn: Tokens) {
        checkCurve(state(), address);
        port.record("read:quoteSell", { tokensIn: tokensIn.toString() });
        if (state().graduated) {
          return Promise.reject(new Error("execution reverted: CurveGraduated()"));
        }
        return Promise.resolve(defaultSellQuote(quote, script.sellQuote));
      },
      previewFeeSplit(fee: QuoteAmount, referrer?: Address) {
        requireSameQuote(fee, quote, `the curve at ${address}`);
        return Promise.resolve(feeSplit(fee, referrer));
      },
      feeConfig() {
        return Promise.resolve(feeConfig());
      },
      pendingWithdrawal() {
        return Promise.resolve(QuoteAmount.parse(quote, script.pendingWithdrawal ?? "0"));
      },
      buy(request: BuyRequest) {
        checkCurve(state(), address);
        if (script.curveBuyThrows !== undefined) {
          return Promise.reject(script.curveBuyThrows as Error);
        }
        // The SDK's order: representable first, the quote's own token, then the allowance.
        request.quoteIn.toRaw();
        requireSameQuote(request.quoteIn, quote, `the curve at ${address}`);
        const approvalTxHash = port.ensureQuoteAllowance(address, request.quoteIn);
        port.record("write:buy", {
          quoteIn: request.quoteIn.toString(),
          symbol: request.quoteIn.token.symbol,
          minTokensOut: request.minTokensOut.toString(),
          gasLimit: request.gasLimit,
          // What the SDK sends: a native buy the caller's limit or the node's
          // estimate; an ERC-20 buy max(caller's limit, estimate plus headroom).
          gasSent: request.quoteIn.token.isNative
            ? request.gasLimit
            : erc20GasLimit(script.gasEstimate ?? 300_000n, request.gasLimit),
          deadline: request.deadline.unixSeconds,
        });
        port.spendQuoteAllowance(address, request.quoteIn);
        const bought = defaultBuyQuote(quote, script.buyQuote);
        return Promise.resolve({
          tokensOut: bought.tokensOut,
          quoteSpent: bought.quoteSpent,
          refund: bought.refund,
          fee: bought.fee,
          newPrice: bought.newPrice,
          graduated: bought.graduates,
          instantMigrationFailed: false,
          migratedInThisTransaction: bought.graduates,
          approvalTxHash,
          txHash: TX,
          receipt: {} as BuyResult["receipt"],
          ...script.buyResult,
        });
      },
      sell(request: SellRequest) {
        checkCurve(state(), address);
        if (script.curveSellThrows !== undefined) {
          return Promise.reject(script.curveSellThrows as Error);
        }
        requireSameQuote(request.minQuoteOut, quote, `the curve at ${address}`);
        port.record("write:sell", {
          tokensIn: request.tokensIn.toString(),
          minQuoteOut: request.minQuoteOut.toString(),
        });
        const sold = defaultSellQuote(quote, script.sellQuote);
        return Promise.resolve({
          quoteOut: sold.quoteOut,
          fee: sold.fee,
          newPrice: sold.newPrice,
          txHash: TX,
          receipt: {} as SellResult["receipt"],
        });
      },
      migrate() {
        checkCurve(state(), address);
        port.record("write:migrate", { curve: address });
        return Promise.resolve({
          quote: QuoteAmount.parse(quote, "50000"),
          tokens: Tokens.parse("259000000"),
          pool: "0x8888888888888888888888888888888888888888" as Address,
          txHash: TX,
          receipt: {} as MigrateResult["receipt"],
        });
      },
      withdraw(to: Address) {
        port.record("write:withdraw", { to });
        return Promise.resolve({
          amount: QuoteAmount.parse(quote, script.pendingWithdrawal ?? "0"),
          txHash: TX,
        });
      },
    };
  }

  token(address: Address): TokenHandle {
    const script = this.script;
    return {
      address,
      name: () => Promise.resolve("Example Token"),
      symbol: () => Promise.resolve("EXAM"),
      metadataUri: () => Promise.resolve("ipfs://example"),
      totalSupply: () => Promise.resolve(Tokens.parse("1000000000")),
      balanceOf: () => Promise.resolve(Tokens.parse("4200")),
      creator: () => Promise.resolve(CREATOR),
      curve: () => {
        if (script.tokenCurveThrows !== undefined) throw script.tokenCurveThrows;
        return Promise.resolve(CURVE);
      },
      // Like the real token: the PoolManager once migrated, never a pool address.
      migratedPool: () => Promise.resolve(
        script.migratedPool ?? (script.state?.migrated === true ? POOL_MANAGER : ZERO)),
      canonicalRouter: () => Promise.resolve(ZERO),
    };
  }

  pool(token: Address): FakePool {
    const port = this;
    const script = this.script;
    const quote = this.quote;
    const fee = script.poolFee ?? POOL_LP_FEE_PIPS;
    const price = QuoteAmount.parse(quote, script.poolPrice ?? "0.0002");
    const impact = script.poolImpactBps ?? 150n;
    const worse = (wad: bigint): bigint => (wad * (10_000n - impact)) / 10_000n;
    const hookVersion = script.hookVersion ?? HOOK_VERSION;
    /** As the SDK does before reading the hook: its VERSION() first, anything but @4 refused. */
    const checkHook = (): void => {
      port.record("read:pool.hookVersion", { hooks: FEE_HOOK });
      assertHookVersion(hookVersion, `${token}'s pool's fee hook`, FEE_HOOK);
    };
    // v4's own order unless a test forces one: native first, otherwise the lower address.
    const quoteIsCurrency0 = script.quoteIsCurrency0
      ?? (quote.isNative || quote.address.toLowerCase() < token.toLowerCase());
    /** Settle one swap's fee on the hook, and return what it paid out from earlier ones. */
    const settleHookFee = (charged: QuoteAmount): QuoteAmount => {
      const distributed = port.accrued;
      port.accrued = charged;
      return distributed;
    };

    const buyQuote = (quoteIn: QuoteAmount): PoolBuyQuote => {
      requireSameQuote(quoteIn, quote, `${token}'s pool`);
      quoteIn.toRaw();
      // The hook's 0.80% comes off the input, then the pool's LP fee, then the price.
      const afterHook = quoteIn.wad - buyFeeFromQuoteIn(quoteIn).wad;
      const net = (afterHook * (1_000_000n - BigInt(fee))) / 1_000_000n;
      const atSpot = (net * WAD) / price.wad;
      return {
        venue: "pool",
        quoteIn,
        tokensOut: Tokens.fromWad(quoteIn.wad < IMPACT_FREE_BELOW_WAD ? atSpot : worse(atSpot)),
        feeQuote: buyFeeFromQuoteIn(quoteIn),
      };
    };
    const sellQuote = (tokensIn: Tokens): PoolSellQuote => {
      const afterLp = (tokensIn.wad * (1_000_000n - BigInt(fee))) / 1_000_000n;
      const gross = worse((afterLp * price.wad) / WAD);
      // A pool pays whole raw units of its quote, net of the hook's 0.80%.
      const quoteOut = QuoteAmount
        .fromWad(quote, (gross * (10_000n - POOL_TRADE_FEE_BPS)) / 10_000n)
        .floorToRepresentable();
      return { venue: "pool", tokensIn, quoteOut, feeQuote: sellFeeFromQuoteOut(quoteOut) };
    };

    return {
      token,
      key: () => Promise.resolve({
        currency0: quoteIsCurrency0 ? quote.address : token,
        currency1: quoteIsCurrency0 ? token : quote.address,
        fee,
        tickSpacing: 60,
        hooks: FEE_HOOK,
      }),
      quoteToken: () => Promise.resolve(quote),
      quoteIsCurrency0: () => Promise.resolve(quoteIsCurrency0),
      async accruedHookFee() {
        checkHook();
        port.record("read:pool.accruedHookFee", { hooks: FEE_HOOK });
        return port.accrued;
      },
      async fees() {
        checkHook();
        port.record("read:pool.fees", { hooks: FEE_HOOK, lpFeePips: fee });
        // What the SDK reads: feeBps() and feeConfigOf() off the hook, fee off the key.
        return {
          hookFeeBps: HOOK_FEE,
          lpFeePips: fee,
          totalBps: Bps.of(POOL_TRADE_FEE_BPS + BigInt(fee) / 100n),
          split: poolFeeConfig(),
        };
      },
      poolId: () => Promise.resolve(POOL_ID),
      poolManager: () => Promise.resolve(POOL_MANAGER),
      isReachable: () => Promise.resolve(
        script.poolReachable ?? port.config.contracts.v4Router !== undefined),
      quoteBuy(quoteIn, opts) {
        port.record("read:pool.quoteBuy", { quoteIn: quoteIn.toString(), from: opts?.from });
        if (script.poolQuoteBuyThrows !== undefined) {
          return Promise.reject(script.poolQuoteBuyThrows as Error);
        }
        return Promise.resolve(buyQuote(quoteIn));
      },
      quoteSell(tokensIn, opts) {
        port.record("read:pool.quoteSell", { tokensIn: tokensIn.toString(), from: opts?.from });
        return Promise.resolve(sellQuote(tokensIn));
      },
      routerAllowance(owner) {
        port.record("read:pool.routerAllowance", { owner });
        return Promise.resolve(port.allowance);
      },
      approveRouter(amount) {
        port.record("write:pool.approveRouter", { amount: amount.toString(), spender: ROUTER });
        port.allowance = amount;
        return Promise.resolve(APPROVE_TX);
      },
      async buy(request) {
        refuseCurveOnly(request);
        if (script.poolBuyThrows !== undefined) throw script.poolBuyThrows;
        request.quoteIn.toRaw();
        requireSameQuote(request.quoteIn, quote, `${token}'s pool`);
        const approvalTxHash = port.ensureQuoteAllowance(ROUTER, request.quoteIn);
        port.record("write:pool.buy", {
          // What the SDK sends: an ERC-20 pool swap at the estimate plus
          // max(20%, 400,000); a native one at the node's estimate.
          gasSent: request.quoteIn.token.isNative
            ? undefined
            : withPoolQuoteTransferHeadroom(script.gasEstimate ?? 300_000n),
          quoteIn: request.quoteIn.toString(),
          symbol: request.quoteIn.token.symbol,
          minTokensOut: request.minTokensOut.toString(),
          recipient: request.recipient,
          deadline: request.deadline.unixSeconds,
        });
        port.spendQuoteAllowance(ROUTER, request.quoteIn);
        const feeQuote = buyFeeFromQuoteIn(request.quoteIn);
        return {
          venue: "pool",
          hash: POOL_TX,
          quote: request.quoteIn,
          tokens: buyQuote(request.quoteIn).tokensOut,
          feeQuote,
          feesDistributed: settleHookFee(feeQuote),
          approvalTxHash,
        };
      },
      async sell(request) {
        refuseCurveOnly(request);
        if (script.poolSellThrows !== undefined) throw script.poolSellThrows;
        requireSameQuote(request.minQuoteOut, quote, `${token}'s pool`);
        if (port.allowance.lt(request.tokensIn)) {
          throw new ArcNowError({
            code: "InvalidArgument",
            message: `(fake SDK) selling ${request.tokensIn.toString()} tokens needs an allowance `
              + `and the router has ${port.allowance.toString()}`,
          });
        }
        port.record("write:pool.sell", {
          gasSent: quote.isNative
            ? undefined
            : withPoolQuoteTransferHeadroom(script.gasEstimate ?? 300_000n),
          tokensIn: request.tokensIn.toString(),
          minQuoteOut: request.minQuoteOut.toString(),
          recipient: request.recipient,
        });
        port.allowance = port.allowance.sub(request.tokensIn);
        const sold = sellQuote(request.tokensIn);
        return {
          venue: "pool",
          hash: POOL_TX,
          quote: sold.quoteOut,
          tokens: request.tokensIn,
          feeQuote: sold.feeQuote,
          feesDistributed: settleHookFee(sold.feeQuote),
        };
      },
    };
  }

  trade(token: Address): TradeHandle {
    const port = this;
    const pool = this.pool(token);
    const onPool = (): boolean => this.script.state?.migrated === true;
    return {
      token,
      pool,
      venue: () => Promise.resolve(onPool() ? "pool" : "curve"),
      quoteToken: () => {
        port.record("read:trade.quoteToken", { token });
        return Promise.resolve(port.quote);
      },
      async quoteBuy(quoteIn, opts) {
        if (onPool()) return pool.quoteBuy(quoteIn, opts);
        return { venue: "curve", ...(await port.curve(CURVE).quoteBuy(quoteIn)) };
      },
      async quoteSell(tokensIn, opts) {
        if (onPool()) return pool.quoteSell(tokensIn, opts);
        return { venue: "curve", ...(await port.curve(CURVE).quoteSell(tokensIn)) };
      },
      async buy(request) {
        if (onPool()) return pool.buy(request);
        refusePoolOnly(request.recipient);
        const result = await port.curve(CURVE).buy({
          quoteIn: request.quoteIn,
          minTokensOut: request.minTokensOut,
          deadline: request.deadline,
          ...(request.referrer === undefined ? {} : { referrer: request.referrer }),
          ...(request.gasLimit === undefined ? {} : { gasLimit: request.gasLimit }),
        });
        return { venue: "curve", ...result };
      },
      async sell(request) {
        if (onPool()) return pool.sell(request);
        refusePoolOnly(request.recipient);
        const result = await port.curve(CURVE).sell({
          tokensIn: request.tokensIn,
          minQuoteOut: request.minQuoteOut,
          deadline: request.deadline,
          ...(request.referrer === undefined ? {} : { referrer: request.referrer }),
        });
        return { venue: "curve", ...result };
      },
    };
  }

  get launchpad(): LaunchpadHandle {
    const port = this;
    const script = this.script;
    const launchpad = NETWORK.contracts.launchpad;
    const platformOf = (params: LaunchParams): Address =>
      params.platform ?? NETWORK.contracts.arcnowPlatform;
    const quoteOf = (params: LaunchParams): LaunchQuote => {
      const token = params.initialBuy.token;
      if (script.noTemplateFor?.some((q) => q.toLowerCase() === token.address) === true) {
        throw new ArcNowError({ code: "QuoteNotEnabledOnPlatform", message: "(fake chain) quote not enabled" });
      }
      // Launching is free: the registry's fee is zero for every quote arcnow.io registers.
      const launchFee = QuoteAmount.zero(token);
      const totalCost = launchFee.add(params.initialBuy);
      return {
        quoteToken: token,
        launchFee,
        initialBuy: params.initialBuy,
        totalCost,
        nativeValue: token.isNative ? totalCost : Usdc.ZERO,
        tokensOut: Tokens.parse("125000"),
        tradeFee: Bps.of(100n).applyToQuote(params.initialBuy),
        graduates: false,
        ...script.launchQuote,
      };
    };
    return {
      address: launchpad,
      launchFee: (quote) => {
        port.record("read:launchFee", { quote });
        const token = quote === undefined ? USDC : (findQuoteToken(port.config, quote) ?? USDC);
        return Promise.resolve(QuoteAmount.zero(token));
      },
      quoteLaunch(params: LaunchParams) {
        port.record("read:quoteLaunch", { symbol: params.symbol, quote: params.initialBuy.token.symbol });
        // The SDK checks the platform's VERSION() inside its quote.
        port.checkPlatform(platformOf(params));
        return Promise.resolve(quoteOf(params));
      },
      predictAddresses: () => Promise.resolve({ token: TOKEN, curve: CURVE }),
      launch(params: LaunchParams) {
        port.checkPlatform(platformOf(params));
        params.initialBuy.toRaw();
        const quoted = quoteOf(params);
        const approvalTxHash = port.ensureQuoteAllowance(launchpad, quoted.totalCost);
        if (script.launchThrows !== undefined) return Promise.reject(script.launchThrows as Error);
        port.record("write:launch", {
          name: params.name,
          symbol: params.symbol,
          quote: params.initialBuy.token.symbol,
          initialBuy: params.initialBuy.toString(),
          minTokensOut: params.minTokensOut.toString(),
          value: quoted.nativeValue.toString(),
        });
        port.spendQuoteAllowance(launchpad, quoted.totalCost);
        const graduates = script.launchQuote?.graduates ?? false;
        return Promise.resolve({
          token: TOKEN,
          curve: CURVE,
          tokensOut: Tokens.parse("125000"),
          graduated: graduates,
          instantMigrationFailed: false,
          migratedInThisTransaction: graduates,
          approvalTxHash,
          txHash: TX,
          receipt: {} as LaunchResult["receipt"],
          ...script.launchResult,
        });
      },
    };
  }

  get platforms(): PlatformsHandle {
    const port = this;
    const script = this.script;
    return {
      address: NETWORK.contracts.platformRegistry,
      isPlatform: () => Promise.resolve(true),
      platformCount: () => Promise.resolve(2n),
      platformAt: (index: bigint) => Promise.resolve(
        index === 0n
          ? NETWORK.contracts.arcnowPlatform
          : ("0x9999999999999999999999999999999999999999" as Address)),
      settings(platform: Address) {
        port.checkPlatform(platform);
        return Promise.resolve(platformSettings());
      },
      feeConfigFor: () => Promise.resolve(feeConfig()),
      checkCurveTemplate: () => Promise.resolve(),
      curveParametersFor(platform: Address, quote?: Address | QuoteTokenInfo) {
        port.checkPlatform(platform);
        port.record("read:curveParametersFor", { platform, quote });
        const token = quote === undefined
          ? USDC
          : typeof quote === "string" ? (findQuoteToken(port.config, quote) ?? USDC) : quote;
        if (script.noTemplateFor?.some((q) => q.toLowerCase() === token.address) === true) {
          return Promise.reject(new ArcNowError({
            code: "NoCurveParameters",
            message: `(fake chain) the platform serves no template for ${token.symbol}`,
          }));
        }
        return Promise.resolve(templateIn(token));
      },
      registerPlatform(platform: NewPlatform) {
        port.record("write:registerPlatform", {
          admin: platform.admin,
          creatorShareBps: platform.creatorShareBps.bps,
          refShareBps: platform.refShareBps.bps,
          template: {
            totalSupply: platform.curve.totalSupply.toString(),
            target: platform.curve.target.toString(),
          },
        });
        return Promise.resolve({
          platform: "0xaaaa0000000000000000000000000000000000aa" as Address,
          platformShareBps: Bps.of(
            10_000n - 2500n - platform.creatorShareBps.bps - platform.refShareBps.bps),
          txHash: TX,
        });
      },
      protocolSummary: () => Promise.resolve({
        protocolShareBps: Bps.of(2500n),
        protocolRecipient: feeConfig().protocolRecipient,
        launchFee: Usdc.ZERO,
      }),
    };
  }

  listLaunches(options: ListLaunchesOptions): Promise<LaunchScan> {
    const quote = this.quote;
    return Promise.resolve({
      launches: [{
        token: TOKEN,
        curve: CURVE,
        creator: CREATOR,
        platform: NETWORK.contracts.arcnowPlatform,
        migrator: NETWORK.contracts.v4Migrator ?? CURVE,
        quoteToken: quote,
        launchFee: QuoteAmount.zero(quote),
        initialBuy: QuoteAmount.parse(quote, "25"),
        tokensOut: Tokens.parse("125000"),
        blockNumber: 62_230_000n,
        txHash: TX,
      }].slice(0, options.limit),
      tipBlock: 62_270_000n,
      scannedFromBlock: 62_226_550n,
      scannedToBlock: 62_270_000n,
      reachedDeployment: false,
      stoppedOnBudget: false,
    });
  }
}

// A non-null assertion would hide the day this stops being true.
export const V4_MIGRATOR: Address = NETWORK.contracts.v4Migrator ?? CURVE;

export function unusedResults(_: BuyResult | SellResult | RegisterPlatformResult): void {
  // Type-only anchor: keeps the SDK result shapes imported and checked.
}
