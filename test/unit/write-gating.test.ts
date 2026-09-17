/**
 * Read-only is the default, and a write tool refuses without the operator's
 * opt-in.
 *
 * Two separate assertions, and both matter. The write tools are not **listed**
 * in read-only mode, because a model offered a tool it cannot use will offer
 * the capability to a user before discovering that. And they are still
 * **refused by name** if called anyway — a client may have cached an older
 * list, and "unknown tool" reads as "you guessed the name wrong" and invites a
 * model to try variations.
 *
 * The assertion that carries the weight in every one of these is
 * `port.writes === []`: not that an error came back, but that nothing was sent.
 */

import { describe, expect, it } from "vitest";

import { ALL_TOOLS, callTool, listTools } from "../../src/tools/index.js";
import { READ_TOOLS } from "../../src/tools/read.js";
import { WRITE_TOOLS } from "../../src/tools/write.js";
import { ctxReadOnly, ctxWithWrites, flat } from "../support/context.js";

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  arcnow_launch: {
    name: "Example", symbol: "EXAM", metadataUri: "ipfs://example", initialBuy: "25", slippageBps: 50,
    maxTotalCost: "30", acknowledgeIrreversible: true,
  },
  arcnow_buy: {
    address: "0x1111111111111111111111111111111111111111",
    quoteIn: "10", slippageBps: 50, maxTotalCost: "10",
  },
  arcnow_sell: {
    address: "0x1111111111111111111111111111111111111111",
    tokensIn: "100", slippageBps: 50,
  },
  arcnow_migrate: { address: "0x1111111111111111111111111111111111111111" },
  arcnow_withdraw_refund: { address: "0x1111111111111111111111111111111111111111" },
  arcnow_register_platform: {
    admin: "0x4444444444444444444444444444444444444444",
    feeRecipient: "0x5555555555555555555555555555555555555555",
    creatorShareBps: 3000, refShareBps: 1000, devShareBps: 1000,
    defaultMigrator: "0x878ce48a169c1699ff9e6b5db6a47292dca6cd27",
  },
};

describe("what is published", () => {
  it("lists only the read tools when read-only", () => {
    const { ctx } = ctxReadOnly();
    const names = listTools(ctx.config).map((t) => t.name);
    expect(names).toEqual(READ_TOOLS.map((t) => t.name));
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool.name);
  });

  it("lists everything once writes are enabled", () => {
    const { ctx } = ctxWithWrites();
    expect(listTools(ctx.config).map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("marks every read tool read-only and no read tool destructive", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it("marks the irreversible ones destructive and no write tool read-only", () => {
    for (const tool of WRITE_TOOLS) expect(tool.annotations.readOnlyHint).toBe(false);
    const destructive = WRITE_TOOLS.filter((t) => t.annotations.destructiveHint)
      .map((t) => t.name);
    expect(destructive).toContain("arcnow_launch");
  });
});

describe("a write tool called on a read-only server", () => {
  it.each(WRITE_TOOLS.map((tool) => tool.name))("%s refuses and sends nothing", async (name) => {
    const { ctx, port } = ctxReadOnly();
    const result = await callTool(name, MINIMAL_ARGS[name], ctx);

    expect(result.isError).toBe(true);
    expect(result.text).toContain(name);
    expect(result.text).toMatch(/READ-ONLY/);
    expect(result.text).toMatch(/--allow-writes/);
    expect(result.text).toMatch(/ARCNOW_PRIVATE_KEY/);
    expect(flat(result.text)).toMatch(/never an argument to any tool/);
    expect(port.writes).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("does not tell the model to try again or to ask for a key", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_launch", MINIMAL_ARGS.arcnow_launch, ctx);
    expect(flat(result.text)).toMatch(/not something to work around/i);
    expect(flat(result.text)).toMatch(/Do not ask the user to paste one/);
  });

  it("points at the read-only tools that still work", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_buy", MINIMAL_ARGS.arcnow_buy, ctx);
    expect(result.text).toContain("arcnow_quote_buy");
  });
});

describe("a write tool called on a writing server", () => {
  it.each(WRITE_TOOLS.map((tool) => tool.name))("%s is allowed through", async (name) => {
    const { ctx, port } = ctxWithWrites({ pendingWithdrawal: undefined });
    const result = await callTool(name, MINIMAL_ARGS[name], ctx);
    // migrate and withdraw legitimately decline on this fixture's state; what
    // is being asserted is that the GATE let them run, not that they all send.
    expect(result.text).not.toMatch(/READ-ONLY/);
    if (name !== "arcnow_migrate" && name !== "arcnow_withdraw_refund") {
      expect(port.writes.length).toBe(1);
    }
  });
});

describe("an unknown tool", () => {
  it("is named as unknown and the real list is offered", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_drain_wallet", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no tool called arcnow_drain_wallet/);
    expect(result.text).toContain("arcnow_quote_buy");
    // A read-only server does not advertise the write tools even here.
    expect(result.text).not.toContain("arcnow_launch");
  });
});
