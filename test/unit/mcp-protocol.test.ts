/**
 * The wire, end to end, with no process and no chain.
 *
 * A real MCP client talks to a real MCP server over a linked in-memory
 * transport. What this proves that the dispatch tests cannot: that the schemas
 * this server generates are ones a client will accept, that the instructions
 * reach the client, that a read-only server really does not advertise a way to
 * spend money, and that a tool error arrives as a result the model can read
 * rather than as a protocol error that kills the call.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../../src/server.js";
import type { ServerConfig } from "../../src/config.js";
import { FakePort, type FakeScript, CURVE } from "../support/fake-port.js";
import { readOnlyConfig, TEST_KEY, writeConfig } from "../support/context.js";

async function connect(config: ServerConfig, script: FakeScript = {}): Promise<Client> {
  const port = new FakePort(script, { canWrite: config.canWrite });
  const server = createServer(port, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("a read-only server", () => {
  it("advertises eight read tools and no way to spend anything", async () => {
    const client = await connect(readOnlyConfig());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("arcnow_quote_buy");
    expect(names).not.toContain("arcnow_buy");
    expect(names).not.toContain("arcnow_launch");
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("tells the model it is read-only before any tool is called", async () => {
    const client = await connect(readOnlyConfig());
    expect(client.getInstructions()).toMatch(/READ-ONLY/);
    expect(client.getInstructions()).toMatch(/Do not offer to buy, sell or launch/);
    await client.close();
  });

  it("returns a tool error as a readable result, not a protocol failure", async () => {
    const client = await connect(readOnlyConfig());
    const result = await client.callTool({
      name: "arcnow_buy",
      arguments: { address: CURVE, quoteIn: "1", slippageBps: 50, maxTotalCost: "1" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/READ-ONLY/);
    await client.close();
  });

  it("answers a quote over the wire with the fee broken out", async () => {
    const client = await connect(readOnlyConfig());
    const result = await client.callTool({
      name: "arcnow_quote_buy",
      arguments: { address: CURVE, quoteIn: "100" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toMatch(/trade fee\s+1 USDC/);
    await client.close();
  });
});

describe("a writing server", () => {
  it("advertises the write tools and marks a launch destructive", async () => {
    const client = await connect(writeConfig());
    const { tools } = await client.listTools();
    const launch = tools.find((t) => t.name === "arcnow_launch");
    expect(launch).toBeDefined();
    expect(launch?.annotations?.destructiveHint).toBe(true);
    expect(launch?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  it("warns the model about irreversibility in the instructions", async () => {
    const client = await connect(writeConfig());
    expect(client.getInstructions()).toMatch(/irreversible/);
    expect(client.getInstructions()).toMatch(/WRITES ENABLED/);
    await client.close();
  });

  it("never puts the signing key anywhere on the wire", async () => {
    const client = await connect(writeConfig());
    const { tools } = await client.listTools();
    const wire = JSON.stringify({ tools, instructions: client.getInstructions() });
    expect(wire).not.toContain(TEST_KEY);
    expect(wire).not.toMatch(/0x[0-9a-fA-F]{64}/);
    await client.close();
  });
});

describe("every published schema", () => {
  it("is one a client accepts and a model can read", async () => {
    const client = await connect(writeConfig());
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description?.length ?? 0).toBeGreaterThan(200);
      expect(tool.title).toBeTruthy();
    }
    await client.close();
  });
});
