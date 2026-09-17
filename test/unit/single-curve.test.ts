/**
 * One curve, one stack.
 *
 * arcnow.io runs one bonding curve — the constant-product
 * `arcnow/bonding-curve@4.x.x` of the fee-model stack — launched through one
 * contract stack. Nothing a tool prints names a curve kind or a stack, and the
 * parameters it prints are that curve's own, `r0Wad` and `y0Wad`. Any other
 * version — the retired multi-quote `@3.x.x`, the linear curve `@1.x.x`, a
 * platform or a fee hook of another version — is refused by name before any
 * quote or send, and never priced.
 */

import type { Address } from "viem";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { ArcNowClient } from "@arcnow/sdk";
import { ArcNowError, WRAPPED_ERROR_SELECTOR } from "@arcnow/sdk";

import { createSdkPort } from "../../src/sdk-port.js";
import { callTool, renderError } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat } from "../support/context.js";
import type { FakePort } from "../support/fake-port.js";
import {
  CURVE,
  CURVE_PARAMS,
  FEE_HOOK,
  NETWORK,
  RETIRED_CURVE_VERSION,
  RETIRED_HOOK_VERSION,
  RETIRED_PLATFORM_VERSION,
  TOKEN,
} from "../support/fake-port.js";

const MIGRATED = { state: { graduated: true, migrated: true } } as const;
const RETIRED_CURVE = { state: { version: RETIRED_CURVE_VERSION } } as const;

const whats = (port: FakePort): string[] => port.calls.map((c) => c.what);
const buyArgs = (over: Record<string, unknown> = {}) => ({
  address: TOKEN, quoteIn: "1", slippageBps: 100, maxTotalCost: "1", ...over,
});
const sellArgs = (over: Record<string, unknown> = {}) => ({
  address: TOKEN, tokensIn: "1000", slippageBps: 100, ...over,
});
const QUOTE_LAUNCH = { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "1" };
const LAUNCH = { ...QUOTE_LAUNCH, slippageBps: 100, maxTotalCost: "27", acknowledgeIrreversible: true };

/** A curve kind, a stack, the retired curve's parameter or a hook generation, in a report. */
const KIND_OR_STACK = /curve kind|\bstack\b|\blinear\b|\bcpmm\b|kWad|version-[12]|legacy/i;

// ─────────────────────────────────────────────────────────────────────────────

describe("a CPMM token's reports name no curve kind and no stack", () => {
  it("arcnow_token prints the curve's own parameters, r0Wad and y0Wad, and nothing about a kind", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(new RegExp(
      `curve parameters\\s+r0Wad ${CURVE_PARAMS.r0Wad} \\(the virtual USDC reserve at launch, in WAD\\), `
      + `y0Wad ${CURVE_PARAMS.y0Wad} \\(the virtual token reserve at launch\\)`));
    expect(result.text).not.toMatch(KIND_OR_STACK);
  });

  it.each([
    ["arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }],
    ["arcnow_quote_sell", { address: TOKEN, tokensIn: "10" }],
  ] as const)("%s on the curve and in the pool", async (tool, args) => {
    for (const script of [{}, MIGRATED]) {
      const { ctx } = ctxWithWrites(script);
      const result = await callTool(tool, args, ctx);
      expect(result.isError, result.text).toBeUndefined();
      expect(result.text).not.toMatch(KIND_OR_STACK);
    }
  });

  it("the trade tools, on the curve and in the pool", async () => {
    for (const script of [{}, MIGRATED]) {
      const { ctx } = ctxWithWrites(script);
      const bought = await callTool("arcnow_buy", buyArgs(), ctx);
      const sold = await callTool("arcnow_sell", sellArgs(script === MIGRATED ? { approveRouter: true } : {}), ctx);
      for (const result of [bought, sold]) {
        expect(result.isError, result.text).toBeUndefined();
        expect(result.text).not.toMatch(KIND_OR_STACK);
      }
    }
  });

  it("arcnow_quote_launch and arcnow_launch: the template's y0, and no stack", async () => {
    const { ctx } = ctxWithWrites();
    const quote = await callTool("arcnow_quote_launch", QUOTE_LAUNCH, ctx);
    expect(quote.isError, quote.text).toBeUndefined();
    expect(quote.text).toMatch(/y0 \d+(\.\d+)? \(the virtual token reserve\)/);
    expect(quote.text).not.toMatch(KIND_OR_STACK);
    const launched = await callTool("arcnow_launch", LAUNCH, ctx);
    expect(launched.isError, launched.text).toBeUndefined();
    expect(launched.text).not.toMatch(KIND_OR_STACK);
  });

  it("arcnow_network, arcnow_list_tokens, arcnow_platform, arcnow_list_platforms and arcnow_register_platform", async () => {
    const { ctx } = ctxWithWrites();
    const network = await callTool("arcnow_network", {}, ctx);
    expect(network.text).not.toMatch(/contract stacks/);
    const platform = await callTool("arcnow_platform", {}, ctx);
    expect(platform.text).toMatch(/y0 \(virtual token reserve\)/);
    const registered = await callTool("arcnow_register_platform", {
      admin: TOKEN, feeRecipient: TOKEN, defaultMigrator: NETWORK.contracts.v4Migrator,
    }, ctx);
    expect(registered.text).toMatch(/curve template\s+the template arcnow\.io's own platform serves on arc-testnet/);
    for (const result of [
      network,
      await callTool("arcnow_list_tokens", { limit: 5 }, ctx),
      platform,
      await callTool("arcnow_list_platforms", {}, ctx),
      registered,
    ]) {
      expect(result.isError, result.text).toBeUndefined();
      expect(result.text).not.toMatch(KIND_OR_STACK);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a retired or unknown version is refused by name, before any quote or send", () => {
  it("arcnow_token on a retired curve: UnknownCurveVersion naming the version, not 'not ours', not a price", async () => {
    // As on a chain: the address is a curve, so reading it as a token fails.
    const { ctx } = ctxReadOnly({ ...RETIRED_CURVE, tokenCurveThrows: new Error("execution reverted") });
    const result = await callTool("arcnow_token", { address: CURVE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^arcnow_token refused: UnknownCurveVersion — this curve answers VERSION\(\)/);
    expect(result.text).toContain(RETIRED_CURVE_VERSION);
    expect(flat(result.text)).toMatch(/Nothing was quoted and nothing was sent/);
    expect(flat(result.text)).toMatch(/the retired multi-quote stack, @3\.x\.x/);
    expect(flat(result.text)).toMatch(/the retired linear curve, @1\.x\.x/);
    expect(flat(result.text)).not.toMatch(/failed on-chain|does not answer as an arcnow\.io|spot price/);
  });

  it("the quote tools on an @1 curve, through the token address, quote nothing", async () => {
    const { ctx, port } = ctxWithWrites({ ...RETIRED_CURVE, notACurve: TOKEN });
    for (const [tool, args] of [
      ["arcnow_quote_buy", { address: TOKEN, quoteIn: "1" }],
      ["arcnow_quote_sell", { address: TOKEN, tokensIn: "1" }],
    ] as const) {
      const result = await callTool(tool, args, ctx);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(new RegExp(`^${tool} refused: UnknownCurveVersion`));
      expect(result.text).toContain(RETIRED_CURVE_VERSION);
    }
    expect(whats(port)).not.toContain("read:quoteBuy");
    expect(whats(port)).not.toContain("read:quoteSell");
  });

  it("arcnow_buy, arcnow_sell and arcnow_migrate on an @1 curve send nothing", async () => {
    const { ctx, port } = ctxWithWrites({
      state: { version: RETIRED_CURVE_VERSION, graduated: true },
      notACurve: TOKEN,
    });
    for (const [tool, args] of [
      ["arcnow_buy", buyArgs()],
      ["arcnow_sell", sellArgs()],
      ["arcnow_migrate", { address: TOKEN }],
    ] as const) {
      const result = await callTool(tool, args, ctx);
      expect(result.isError, `${tool}: ${result.text}`).toBe(true);
      expect(result.text).toMatch(new RegExp(`^${tool} refused: UnknownCurveVersion`));
    }
    expect(port.writes).toEqual([]);
  });

  it("an @1 platform: arcnow_quote_launch, arcnow_launch and arcnow_platform refuse, and nothing is sent", async () => {
    const { ctx, port } = ctxWithWrites({ platformVersion: RETIRED_PLATFORM_VERSION });
    for (const [tool, args] of [
      ["arcnow_quote_launch", QUOTE_LAUNCH],
      ["arcnow_launch", LAUNCH],
      ["arcnow_platform", {}],
    ] as const) {
      const result = await callTool(tool, args, ctx);
      expect(result.isError, `${tool}: ${result.text}`).toBe(true);
      expect(result.text).toMatch(new RegExp(
        `^${tool} refused: UnknownCurveVersion — this platform answers VERSION\\(\\) "${RETIRED_PLATFORM_VERSION}"`));
    }
    expect(port.writes).toEqual([]);
  });

  it("an @1 fee hook: arcnow_token says its accrual is refused, naming the version, and reads nothing from it", async () => {
    const { ctx, port } = ctxReadOnly({ ...MIGRATED, hookVersion: RETIRED_HOOK_VERSION, accruedHookFee: "9" });
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/hook fees accrued\s+refused: UnknownHookVersion/);
    expect(result.text).toContain(RETIRED_HOOK_VERSION);
    expect(result.text).not.toMatch(/9 USDC/);
    expect(port.writes).toEqual([]);
  });

  it("renderError names which component answered the version it refused", () => {
    const text = renderError("arcnow_register_platform", new ArcNowError({
      code: "UnknownCurveVersion",
      message: "the platform registry answers VERSION() \"arcnow/platform-registry@1.0.0\".",
      details: { version: "arcnow/platform-registry@1.0.0", component: "platform-registry" },
    }));
    expect(text).toMatch(
      /^arcnow_register_platform refused: UnknownCurveVersion — this platform registry answers VERSION\(\) "arcnow\/platform-registry@1\.0\.0"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the context a wrapper carries", () => {
  const layer = {
    target: FEE_HOOK,
    selector: "0xb47b2fb1" as `0x${string}`,
    selectorName: "afterSwap",
    details: "0xa9e35b2f" as `0x${string}`,
    detailsName: "HookCallFailed",
  };

  it("WrappedRevert keeps every wrapper layer, outermost first", () => {
    const text = renderError("arcnow_buy", new ArcNowError({
      code: "WrappedRevert",
      message: "inside a Uniswap v4 call — afterSwap on the hook — the call reverted with no data at all.",
      selector: WRAPPED_ERROR_SELECTOR,
      details: { wrappedBy: [layer], reason: "0x" },
    }));
    expect(text).toMatch(/WrappedRevert/);
    expect(text).toContain(`afterSwap on ${getAddress(FEE_HOOK)} (HookCallFailed)`);
    expect(text).toMatch(/inner revert\s+no data at all/);
  });

  it("a decoded error that came through a wrapper keeps its own code and the wrapper", () => {
    const text = renderError("arcnow_sell", new ArcNowError({
      code: "SlippageExceeded",
      message: "the fill moved against your floor. Re-quote and retry.",
      args: { minOutWad: 1n, actualOutWad: 2n },
      details: { wrappedBy: [layer] },
    }));
    expect(text).toMatch(/arcnow_sell failed on-chain: SlippageExceeded/);
    expect(text).toMatch(/minOutWad=1/);
    expect(text).toContain(`afterSwap on ${getAddress(FEE_HOOK)}`);
  });
});

describe("the pool's fee hook, which accrues", () => {
  it("arcnow_token says what the hook holds accrued", async () => {
    const { ctx } = ctxReadOnly({ ...MIGRATED, accruedHookFee: "0.25" });
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/hook fees accrued\s+0\.25 USDC/);
    expect(flat(result.text)).toMatch(/takes its 0\.8% in USDC, accrues it as a PoolManager claim/);
  });

  it("a pool buy reports the earlier fees its swap paid out, apart from the fill", async () => {
    const { ctx } = ctxWithWrites({ ...MIGRATED, accruedHookFee: "0.5" });
    const result = await callTool("arcnow_buy", buyArgs(), ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/earlier fees paid out\s+0\.5 USDC/);
    expect(flat(result.text)).toMatch(/accrued by the hook as a PoolManager claim/);
  });

  it("a pool sell pays out the buy's accrued fee", async () => {
    const { ctx } = ctxWithWrites(MIGRATED);
    await callTool("arcnow_buy", buyArgs(), ctx);
    const result = await callTool("arcnow_sell", sellArgs({ approveRouter: true }), ctx);
    expect(result.isError, result.text).toBeUndefined();
    // The buy's hook fee: 0.80% of its 1 USDC, not 1%.
    expect(result.text).toMatch(/earlier fees paid out\s+0\.008 USDC/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the launch scan", () => {
  it("reads the one launchpad, back to the block its stack was deployed in", async () => {
    const launchpad = NETWORK.contracts.launchpad.toLowerCase();
    const queried: { address: unknown; fromBlock: bigint; toBlock: bigint }[] = [];
    const log = (address: string, block: bigint, token: Address) => ({
      address,
      blockNumber: block,
      transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
      args: {
        token, curve: CURVE, creator: TOKEN, platform: TOKEN, migrator: TOKEN,
        quoteToken: "0x0000000000000000000000000000000000000000",
        launchFeeWad: 0n, initialBuyWad: 0n, tokensOutWad: 0n,
      },
    });
    const client = {
      config: NETWORK,
      publicClient: {
        getBlockNumber: () => Promise.resolve(62_398_000n),
        getLogs: (params: { address: unknown; fromBlock: bigint; toBlock: bigint }) => {
          queried.push(params);
          return Promise.resolve([log(launchpad, 62_390_000n, TOKEN)].filter((l) =>
            String(params.address).toLowerCase() === l.address
            && l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock));
        },
      },
    } as unknown as ArcNowClient;

    const port = createSdkPort(client, { chunkBlocks: 50_000n, maxChunks: 10 });
    const scan = await port.listLaunches({ limit: 10 });

    // The fee-model stack's first block on Arc testnet, as the SDK's preset records it.
    expect(NETWORK.deployedAtBlock).toBe(62_386_232);
    expect(scan.launches.map((l) => l.blockNumber)).toEqual([62_390_000n]);
    expect(scan.reachedDeployment).toBe(true);
    expect(scan.scannedFromBlock).toBe(62_386_232n);
    expect(queried.length).toBeGreaterThan(0);
    for (const q of queried) expect(String(q.address).toLowerCase()).toBe(launchpad);
  });
});
