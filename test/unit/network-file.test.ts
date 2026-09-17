/**
 * `ARCNOW_MCP_NETWORK_FILE`: a deployment the SDK's presets do not name.
 *
 * An operator running a local anvil stack — and this repository's own fork
 * suite, which deploys the 3.x contracts onto a fork of Arc testnet — points
 * the server at a JSON document in the SDK's `CustomNetwork` shape. It is
 * validated by the SDK's own `resolveNetwork`, it is mutually exclusive with a
 * preset name, and its `quoteTokens` are the list the spend caps resolve
 * symbols against.
 */

import { describe, expect, it } from "vitest";

import { clientOptionsFor } from "../../src/client-options.js";
import { ConfigError, loadConfig, startupBanner } from "../../src/config.js";
import { NETWORK_FILE_PATH, networkDocument, TEST_KEY, withNetworkFile } from "../support/context.js";
import { NETWORK, WETHX } from "../support/fake-port.js";

describe("ARCNOW_MCP_NETWORK_FILE", () => {
  it("resolves the file through the SDK: its name, addresses and quote tokens", () => {
    const { env, readFile } = withNetworkFile([...NETWORK.quoteTokens, WETHX]);
    const config = loadConfig(env, [], readFile);
    expect(config.network).toBe("fork-under-test");
    expect(config.networkConfig.chainId).toBe(NETWORK.chainId);
    expect(config.networkConfig.contracts.launchpad).toBe(NETWORK.contracts.launchpad);
    expect(config.networkConfig.quoteTokens.map((q) => q.symbol)).toEqual(["USDC", "EURC", "WETHX"]);
    expect(config.describe().networkFile).toBe(NETWORK_FILE_PATH);
    expect(startupBanner(config)).toContain(NETWORK_FILE_PATH);
  });

  it("turns a JSON allowance slot into the bigint the SDK expects", () => {
    const { env, readFile } = withNetworkFile();
    const config = loadConfig(env, [], readFile);
    expect(Object.values(config.networkConfig.quoteAllowanceSlots)).toEqual([10n]);
  });

  it("is what the SDK client is built on, with the endpoint override still applied", () => {
    const { env, readFile } = withNetworkFile();
    const config = loadConfig({ ...env, ARCNOW_RPC_URL: "http://127.0.0.1:9999" }, [], readFile);
    const options = clientOptionsFor(config);
    expect(options.network).toBe(config.networkConfig);
    expect(options.rpcUrl).toBe("http://127.0.0.1:9999");
  });

  it("the preset is what the client is built on without one", () => {
    const config = loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY }, ["--allow-writes"]);
    const options = clientOptionsFor(config);
    expect(options.network).toBe(config.networkConfig);
    expect(options.network.name).toBe("arc-testnet");
    expect(options.account).toBeDefined();
  });

  it("refuses to be combined with a preset name, either way it is given", () => {
    const { env, readFile } = withNetworkFile();
    expect(() => loadConfig({ ...env, ARCNOW_MCP_NETWORK: "arc-testnet" }, [], readFile))
      .toThrow(/ARCNOW_MCP_NETWORK_FILE and a network name are mutually exclusive/);
    expect(() => loadConfig(env, ["--network=arc-testnet"], readFile)).toThrow(ConfigError);
  });

  it("refuses a file it cannot read, or that is not JSON", () => {
    expect(() => loadConfig({ ARCNOW_MCP_NETWORK_FILE: "/nope.json" }, [], () => {
      throw new Error("ENOENT");
    })).toThrow(/ARCNOW_MCP_NETWORK_FILE points at \/nope\.json and it could not be read/);
    expect(() => loadConfig({ ARCNOW_MCP_NETWORK_FILE: "/bad.json" }, [], () => "{ not json"))
      .toThrow(/\/bad\.json is not JSON/);
  });

  it("refuses a document the SDK refuses, with the SDK's reason", () => {
    const document = JSON.parse(networkDocument()) as { contracts: Record<string, string> };
    delete document.contracts.launchpad;
    expect(() => loadConfig({ ARCNOW_MCP_NETWORK_FILE: "/x.json" }, [], () => JSON.stringify(document)))
      .toThrow(/ContractNotDeployed.*launchpad/s);
  });

  it("refuses a quote token the SDK refuses: native at other than 18 decimals", () => {
    const document = JSON.parse(networkDocument()) as { quoteTokens: { decimals: number }[] };
    const native = document.quoteTokens[0];
    if (native !== undefined) native.decimals = 6;
    expect(() => loadConfig({ ARCNOW_MCP_NETWORK_FILE: "/x.json" }, [], () => JSON.stringify(document)))
      .toThrow(ConfigError);
  });
});
