/**
 * The property this server exists to keep: **no tool takes a key.**
 *
 * Not "no tool currently takes a key" — the schemas are walked, so a field
 * added next year with a credential-shaped name fails this file. And not only
 * the declared fields: passing one anyway is refused, because a strict schema
 * is the difference between a secret being dropped and a secret being reported.
 *
 * A tool argument is written by a model into a transcript. It reaches the model
 * provider, the client's logs, every later turn's context, and whatever anyone
 * pastes into an issue. There is no un-publishing it. Everything else in this
 * file follows from that.
 */

import { describe, expect, it } from "vitest";

import { ALL_TOOLS, callTool } from "../../src/tools/index.js";
import { ctxWithWrites } from "../support/context.js";

const CREDENTIAL_NAMES = /(privatekey|private_key|secret|mnemonic|seed|passphrase|password|apikey|api_key|credential|signer|wallet)/i;

function walkProperties(
  schema: Record<string, unknown>,
  visit: (name: string, node: Record<string, unknown>) => void,
): void {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  for (const [name, node] of Object.entries(properties ?? {})) {
    visit(name, node);
    walkProperties(node, visit);
  }
  for (const key of ["items", "additionalProperties"]) {
    const child = schema[key];
    if (child !== null && typeof child === "object") {
      walkProperties(child as Record<string, unknown>, visit);
    }
  }
}

describe("every published tool schema", () => {
  it.each(ALL_TOOLS.map((tool) => [tool.name, tool] as const))(
    "%s declares no credential-shaped argument",
    (_name, tool) => {
      const offenders: string[] = [];
      walkProperties(tool.inputSchema, (name) => {
        if (CREDENTIAL_NAMES.test(name)) offenders.push(name);
      });
      expect(offenders).toEqual([]);
    },
  );

  it.each(ALL_TOOLS.map((tool) => [tool.name, tool] as const))(
    "%s never asks for a key in an argument description",
    (_name, tool) => {
      walkProperties(tool.inputSchema, (_field, node) => {
        const description = typeof node.description === "string" ? node.description : "";
        expect(description).not.toMatch(/paste (your|the) .*(key|secret)/i);
        expect(description).not.toMatch(/provide (your|a) private key/i);
      });
    },
  );

  it.each(ALL_TOOLS.map((tool) => [tool.name, tool] as const))(
    "%s rejects arguments it did not ask for",
    (_name, tool) => {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    },
  );
});

describe("a key passed anyway", () => {
  it("is refused, named, and answered with 'rotate it'", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_quote_buy", {
      address: "0x1111111111111111111111111111111111111111",
      quoteIn: "10",
      privateKey: `0x${"ab".repeat(32)}`,
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/privateKey/);
    expect(result.text).toMatch(/ROTATE IT/);
    expect(result.text).toMatch(/never a tool argument|No tool on this server takes a key/i);
    // And nothing was read or written on the strength of it.
    expect(port.calls).toEqual([]);
  });

  it("is refused on a write tool too, before anything is sent", async () => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_buy", {
      address: "0x1111111111111111111111111111111111111111",
      quoteIn: "10",
      slippageBps: 50,
      maxTotalCost: "10",
      mnemonic: "test test test test test test test test test test test junk",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/mnemonic/);
    expect(result.text).toMatch(/ROTATE IT/);
    expect(port.writes).toEqual([]);
  });

  it("does not echo the value back", async () => {
    const { ctx } = ctxWithWrites();
    const secret = `0x${"cd".repeat(32)}`;
    const result = await callTool("arcnow_network", { privateKey: secret }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(secret);
  });
});

describe("the server's own instructions", () => {
  it("tell the model not to ask for a key", async () => {
    const { instructionsFor } = await import("../../src/server.js");
    const { ctx } = ctxWithWrites();
    const text = instructionsFor(ctx.config);
    expect(text).toMatch(/NEVER ask anyone for a private key/);
    expect(text).toMatch(/never put one in a tool argument/);
  });
});
