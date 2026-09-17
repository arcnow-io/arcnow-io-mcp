/**
 * A launch needs a metadata URI.
 *
 * `Launchpad.launch` reverts with `InvalidLaunchParameters` when the name, the
 * symbol or the metadata URI is empty — at
 * `src/Launchpad.sol:186-192`. `quoteLaunch` does not check it, so a quote for
 * an empty URI would describe a launch that cannot happen. The tools therefore
 * refuse an empty or missing URI themselves, at the argument, before anything
 * reaches the port, and say why.
 */

import { describe, expect, it } from "vitest";

import { callTool, findTool } from "../../src/tools/index.js";
import { ctxReadOnly, ctxWithWrites, flat } from "../support/context.js";

const LAUNCH = {
  name: "Example", symbol: "EXAM", initialBuy: "25", slippageBps: 50,
  maxTotalCost: "30", acknowledgeIrreversible: true,
};
const QUOTE = { name: "Example", symbol: "EXAM", initialBuy: "25" };

const MISSING = [
  ["empty", { metadataUri: "" }],
  ["omitted", {}],
] as const;

describe("a launch without a metadata URI", () => {
  it.each(MISSING)("arcnow_launch refuses one %s before any call reaches the chain", async (_, extra) => {
    const { ctx, port } = ctxWithWrites();
    const result = await callTool("arcnow_launch", { ...LAUNCH, ...extra }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/metadataUri: a metadata URI is required/);
    expect(flat(result.text)).toMatch(/InvalidLaunchParameters/);
    expect(port.calls).toEqual([]);
  });

  it.each(MISSING)("arcnow_quote_launch refuses one %s too, quoting nothing", async (_, extra) => {
    const { ctx, port } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch", { ...QUOTE, ...extra }, ctx);
    expect(result.isError).toBe(true);
    expect(flat(result.text)).toMatch(/metadataUri: a metadata URI is required/);
    expect(port.calls).toEqual([]);
  });

  it("both tools' schemas require it, and neither description says empty is allowed", () => {
    for (const name of ["arcnow_launch", "arcnow_quote_launch"]) {
      const schema = findTool(name)?.inputSchema as {
        required?: string[];
        properties: Record<string, { minLength?: number; default?: unknown; description?: string }>;
      };
      const uri = schema.properties.metadataUri;
      expect(schema.required, name).toContain("metadataUri");
      expect(uri?.minLength, name).toBe(1);
      expect(uri?.default, name).toBeUndefined();
      expect(uri?.description, name).not.toMatch(/empty is allowed/i);
      expect(uri?.description, name).toMatch(/required/i);
    }
  });

  it("a URI that is given reaches the quote as written", async () => {
    const { ctx } = ctxReadOnly();
    const result = await callTool("arcnow_quote_launch",
      { ...QUOTE, metadataUri: "ipfs://example" }, ctx);
    expect(result.isError, result.text).toBeUndefined();
    expect(result.text).toMatch(/metadata\s+ipfs:\/\/example/);
  });
});
