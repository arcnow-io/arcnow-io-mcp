/**
 * The fee model, as every report states it.
 *
 * Two shapes, and a report never confuses them:
 *
 * - On a CURVE the flat 1% is split FOUR ways — creator, platform, referrer,
 *   protocol. There is no developer share and no tool takes a developer; a
 *   strict schema refuses one by name.
 * - In a POOL the trade costs the same 1.00% as two charges by two parties:
 *   arcnow.io's fee hook takes 0.80% in the pool's quote and splits it
 *   creator / platform / protocol with no referrer, and the pool keeps a 0.20%
 *   LP fee. Both rates are READ off the pool through the SDK's `Pool.fees()`
 *   and never assumed: a pool whose key carries another LP fee is reported at
 *   the fee it carries.
 *
 * Launching is free on arcnow.io's networks; the tools print the registry's
 * zero as zero and say so, rather than assuming a fee that is not there.
 */

import { describe, expect, it } from "vitest";
import { POOL_LP_FEE_PIPS, POOL_TRADE_FEE_BPS, TRADE_FEE_BPS } from "@arcnow/sdk";

import { instructionsFor } from "../../src/server.js";
import { callTool, listTools } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat } from "../support/context.js";
import {
  CREATOR,
  CURVE,
  PAYEE,
  PLATFORM_RECIPIENT,
  PROTOCOL_RECIPIENT,
  TOKEN,
  V4_MIGRATOR,
} from "../support/fake-port.js";

const MIGRATED = { state: { graduated: true, migrated: true } } as const;

describe("the SDK's shipped rates, which the prose quotes", () => {
  it("are a 1% curve fee, an 0.80% hook fee and a 0.20% LP fee", () => {
    expect(TRADE_FEE_BPS).toBe(100n);
    expect(POOL_TRADE_FEE_BPS).toBe(80n);
    expect(POOL_LP_FEE_PIPS).toBe(2000);
  });
});

describe("a curve fee is split four ways", () => {
  it("arcnow_quote_buy names the four parties, their amounts and their addresses, and no developer share", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_buy", { address: CURVE, quoteIn: "100", referrer: PAYEE }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/fee split — where the 1 USDC goes, four ways/);
    // arcnow.io's split of a 1 USDC fee: 0.30 / 0.35 / 0.10 / 0.25.
    expect(result.text).toMatch(new RegExp(`creator\\s+0\\.3 USDC\\s+→ ${CREATOR}`, "i"));
    expect(result.text).toMatch(new RegExp(`platform\\s+0\\.35 USDC\\s+→ ${PLATFORM_RECIPIENT}`, "i"));
    expect(result.text).toMatch(new RegExp(`referrer\\s+0\\.1 USDC\\s+→ ${PAYEE}`, "i"));
    expect(result.text).toMatch(new RegExp(`protocol\\s+0\\.25 USDC\\s+→ ${PROTOCOL_RECIPIENT}`, "i"));
    expect(result.text).toMatch(/developer\s+none — the fee has four parties; there is no developer share/);
    expect(result.text).toMatch(/trade fee\s+1 USDC — a flat 1% of the input/);
  });

  it("arcnow_quote_sell does the same, and says an absent referrer's share goes to the platform", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_sell", { address: CURVE, tokensIn: "1000" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/fee split — where the 0\.99 USDC goes, four ways/);
    expect(result.text).toMatch(/referrer\s+0\.099 USDC\s+→ no referrer given, so this goes to the platform/);
    expect(result.text).toMatch(/developer\s+none/);
    // The four amounts total the fee exactly: the platform takes the residual.
    expect(result.text).toMatch(/platform\s+0\.3465 USDC/);
  });

  it("arcnow_platform prints the four shares both ways, the platform as the residual, and no developer share", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_platform", {}, ctx);
    expect(result.text).toMatch(/how the 1% trade fee is divided — four ways, on a curve/);
    expect(result.text).toMatch(/creator\s+3000 bps of the fee \(30% of the fee, 0\.3% of a trade\)/);
    expect(result.text).toMatch(/referrer\s+1000 bps of the fee \(10% of the fee, 0\.1% of a trade\)/);
    expect(result.text).toMatch(/protocol\s+2500 bps of the fee \(25% of the fee, 0\.25% of a trade\)/);
    expect(result.text).toMatch(/platform\s+3500 bps of the fee \(35% of the fee, 0\.35% of a trade\) — the RESIDUAL/);
    expect(result.text).toMatch(/developer\s+none — there is no developer share/);
    expect(result.text).not.toMatch(/devShare/);
  });

  it("arcnow_list_platforms lists creator / ref / platform, and no developer", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_list_platforms", {}, ctx);
    expect(result.text).toMatch(/creator \/ ref \/ platform\s+3000 \/ 1000 \/ 3500 bps of the fee/);
    expect(result.text).not.toMatch(/dev\b/);
  });

  it("arcnow_register_platform takes creator and referrer shares only, and reports the residual", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_register_platform", {
      admin: TOKEN, feeRecipient: PAYEE, creatorShareBps: 3000, refShareBps: 1000,
      defaultMigrator: V4_MIGRATOR,
    }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/platform \(residual\)\s+3500 bps of the fee/);
    expect(result.text).toMatch(/developer\s+none — the fee has four parties/);
    expect(port.writes[0]?.args).toMatchObject({ creatorShareBps: 3000n, refShareBps: 1000n });

    const refused = await callTool("arcnow_register_platform", {
      admin: TOKEN, feeRecipient: PAYEE, creatorShareBps: 3000, refShareBps: 1000,
      devShareBps: 1000, defaultMigrator: V4_MIGRATOR,
    }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/devShareBps/);
    expect(port.writes).toHaveLength(1);
  });

  it("no published schema has a developer field, and the descriptions say the fee has four parties", () => {
    const { config } = ctxWithWrites().ctx;
    for (const tool of listTools(config)) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      const properties = schema.properties ?? {};
      for (const field of Object.keys(properties)) {
        expect(field, `${tool.name}.${field}`).not.toMatch(/dev/i);
      }
      expect(flat(JSON.stringify(tool)), tool.name).not.toMatch(/developer share of the fee/);
    }
    for (const name of ["arcnow_quote_buy", "arcnow_platform", "arcnow_register_platform"]) {
      const tool = listTools(config).find((t) => t.name === name);
      expect(flat(tool?.description ?? ""), name).toMatch(/four parties|four ways|FOUR ways/i);
    }
  });

  it("the server's instructions say the fee has four parties and that launching is free", () => {
    const text = flat(instructionsFor(ctxReadOnly().ctx.config));
    expect(text).toMatch(/split FOUR ways — creator, platform, referrer, protocol; there is no developer share/);
    expect(text).toMatch(/Launching is free/);
    expect(text).toMatch(/fee hook's 0\.80% and the pool's own 0\.20% LP fee, 1\.00% in all/);
  });
});

describe("a pool's fees are the hook's 0.80% and the pool's 0.20%, read off the pool", () => {
  it("arcnow_token shows both, their total, and the hook's three-way split", async () => {
    const { ctx, port } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/fees\s+1% of the trade in all — 0\.8% \(80 bps\) taken by arcnow\.io's fee hook in USDC, plus 0\.2% \(2000 hundredths of a bip\) the pool keeps as its LP fee/);
    expect(flat(result.text)).toMatch(/Both read off the chain: the hook's own feeBps\(\) and the pool key's fee/);
    expect(result.text).toMatch(/how the fee hook splits its 0\.8% — read from the hook/);
    expect(result.text).toMatch(/creator\s+5000 bps of the fee \(50% of the fee, 0\.4% of a trade\)/);
    expect(result.text).toMatch(/platform\s+1875 bps of the fee \(18\.75% of the fee, 0\.15% of a trade\)/);
    expect(result.text).toMatch(/protocol\s+3125 bps of the fee \(31\.25% of the fee, 0\.25% of a trade\)/);
    expect(result.text).toMatch(/referrer\s+0 bps — a pool swap names no referrer/);
    expect(port.calls.map((c) => c.what)).toContain("read:pool.fees");
  });

  it("arcnow_network describes the pool's two charges as the shipped rates, and says a quote reads its pool's own", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_network", {}, ctx);
    expect(result.text).toMatch(/trade fee, on a curve\s+100 bps — a flat 1%/);
    expect(flat(result.text)).toMatch(/FOUR ways: creator, referrer, platform, protocol\. There is no developer share/);
    expect(result.text).toMatch(/trade fee, in a pool\s+the same 1% in all, as two charges: arcnow\.io's fee hook takes 0\.8% \(80 bps\)/);
    expect(flat(result.text)).toMatch(/the pool keeps 0\.2% \(2000 hundredths of a bip\) as its LP fee/);
    expect(flat(result.text)).toMatch(/Every pool quote reads both rates off that pool/);
  });

  it("a pool quote's hook fee is 0.80% of the input, never the curve's 1%", async () => {
    const { ctx } = ctxReadOnly(MIGRATED);
    const result = await callTool("arcnow_quote_buy", { address: TOKEN, quoteIn: "250" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/arcnow\.io fee\s+2 USDC — 0\.8% of the trade \(80 bps\), read from the hook/);
    expect(result.text).not.toMatch(/2\.5 USDC/);
    // The LP fee is charged on what reaches the pool: 0.20% of 248.
    expect(result.text).toMatch(/pool fee\s+0\.2% \(2000 hundredths of a bip\)[^\n]*about 0\.496 USDC of this order/);
  });

  it("a refused hook version leaves the pool's fees unread, and arcnow_token says so", async () => {
    const { ctx } = ctxReadOnly({ ...MIGRATED, hookVersion: "arcnow/arc-now-fee-hook@3.0.0" });
    const result = await callTool("arcnow_token", { address: TOKEN }, ctx);
    expect(result.text).toMatch(/fees\s+refused: UnknownHookVersion/);
    expect(result.text).toMatch(/hook fees accrued\s+refused: UnknownHookVersion/);
    expect(result.text).not.toMatch(/0\.8% \(80 bps\)/);
    expect(result.text).not.toMatch(/how the fee hook splits/);
  });

  it("a pool trade's result reports the hook's rate and the LP fee it read, and their total", async () => {
    const { ctx } = ctxWithWrites(MIGRATED);
    const bought = await callTool("arcnow_buy",
      { address: TOKEN, quoteIn: "1", slippageBps: 100, maxTotalCost: "1", deadlineMinutes: 5 }, ctx);
    expect(bought.isError, bought.text).toBeUndefined();
    expect(bought.text).toMatch(/arcnow\.io fee\s+0\.008 USDC — what arcnow\.io's fee hook took, at 0\.8% of the trade \(80 bps\), read from the hook/);
    expect(flat(bought.text)).toMatch(/paid out to the creator, the platform and the protocol/);
    expect(flat(bought.text)).toMatch(/pool fee 0\.2% \(2000 hundredths of a bip\) — Uniswap's LP fee, inside the price, kept by the pool's liquidity; with the hook's 0\.8%, 1% of the trade in all, both read off the pool/);
  });
});

describe("launching is free, and said to be — from the registry's figure", () => {
  it("arcnow_quote_tokens, arcnow_quote_launch and arcnow_platform print the registry's zero as zero", async () => {
    const { ctx } = ctxReadOnly();
    const tokens = await callTool("arcnow_quote_tokens", {}, ctx);
    expect(tokens.text).toMatch(/launch fee\s+0 USDC launch fee — launching is free — per launch, in USDC, as the registry sets it/);
    const launch = await callTool("arcnow_quote_launch",
      { name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "10" }, ctx);
    expect(launch.text).toMatch(/total, exactly\s+10 USDC/);
    expect(launch.text).toMatch(/launch fee\s+0 USDC launch fee — launching is free/);
    const platform = await callTool("arcnow_platform", {}, ctx);
    expect(platform.text).toMatch(/launch fee\s+0 USDC launch fee — launching is free — per launch in native USDC, as the quote registry sets it/);
  });

  it("a launch's total is exactly its initial buy, and the cap is checked against that", async () => {
    const { ctx, port } = ctxWithWrites({}, { ARCNOW_MCP_MAX_SPEND_USDC: "10" });
    const result = await callTool("arcnow_launch", {
      name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "10",
      slippageBps: 50, maxTotalCost: "10", acknowledgeIrreversible: true,
    }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/total\s+10 USDC — exactly/);
    expect(result.text).toMatch(/launch fee\s+0 USDC launch fee — launching is free/);
    expect(port.writes.map((w) => w.what)).toEqual(["write:launch"]);
  });
});
