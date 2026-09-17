/**
 * The pin, checked from inside the program rather than only by a shell script.
 *
 * The maintainers' pin gate proves the installed SDK is the published version
 * pinned. These prove the things a hash cannot: that the chain facts this
 * repository restates for a reader agree with the SDK's own `networks.json`,
 * and that the version pinned is the version installed. Two copies of a chain
 * id is how one of them ends up wrong.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { NETWORKS, POOL_LP_FEE_PIPS, resolveNetwork } from "@arcnow/sdk";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pins = JSON.parse(readFileSync(`${root}/pins.json`, "utf8")) as {
  sdk: {
    package: string;
    version: string;
    integrity: string;
    public_repo: string;
    tag: string;
  };
  images: { foundry: string };
  chain: {
    network: string;
    chain_id: number;
    rpc_url: string;
    native_decimals: number;
    usdc_erc20_decimals: number;
  };
};
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, "utf8")) as {
  packages: Record<string, { version: string; resolved?: string; integrity?: string }>;
};

describe("pins.json against the SDK it pins", () => {
  it("restates the chain id the SDK actually resolves", () => {
    expect(resolveNetwork("arc-testnet").chainId).toBe(pins.chain.chain_id);
  });

  it("restates the endpoint the SDK actually resolves", () => {
    expect(resolveNetwork("arc-testnet").rpcUrl).toBe(pins.chain.rpc_url);
  });

  it("restates 18 native decimals and 6 for the ERC-20 view", () => {
    expect(pins.chain.native_decimals).toBe(18);
    expect(pins.chain.usdc_erc20_decimals).toBe(6);
  });

  it("names a network the SDK knows", () => {
    expect(NETWORKS).toContain(pins.chain.network);
  });

  it("pins the version that is actually installed", () => {
    const installed = JSON.parse(
      readFileSync(`${root}/node_modules/${pins.sdk.package}/package.json`, "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(pins.sdk.version);
  });

  it("names an exact version, a sha512 of its tarball, and the tag of that release", () => {
    expect(pins.sdk.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.sdk.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(pins.sdk.tag).toBe(`v${pins.sdk.version}`);
    expect(pins.sdk.public_repo).toBe("arcnow-io/arcnow-io-sdk");
  });

  it("binds the version to the pinned tarball in the lockfile, from the npm registry", () => {
    const entry = lock.packages[`node_modules/${pins.sdk.package}`];
    expect(entry?.version).toBe(pins.sdk.version);
    expect(entry?.integrity).toBe(pins.sdk.integrity);
    expect(entry?.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
  });

  it("pins the Foundry image the fork proof runs to an exact release, never latest", () => {
    expect(pins.images.foundry).toMatch(/^ghcr\.io\/foundry-rs\/foundry:v\d+\.\d+\.\d+$/);
  });
});

describe("package.json", () => {
  it("depends on the published SDK at exactly the pinned version, never a range", () => {
    expect(pkg.dependencies[pins.sdk.package]).toBe(pins.sdk.version);
  });
});

describe("the deployments the SDK ships", () => {
  it("ships exactly the two presets: arc-testnet and arc-mainnet", () => {
    expect([...NETWORKS].sort()).toEqual(["arc-mainnet", "arc-testnet"]);
  });

  it.each(["arc-testnet", "arc-mainnet"] as const)(
    "%s has a Uniswap v4 venue and no escrow, v2 or v3 — which is the healthy state",
    (network) => {
      const config = resolveNetwork(network);
      expect(config.venues.uniswapV4).toBe(true);
      expect(config.venues.escrow).toBe(false);
      expect(config.venues.uniswapV2).toBe(false);
      expect(config.venues.uniswapV3).toBe(false);
      expect(config.contracts.escrowMigrator).toBeUndefined();
    },
  );

  it.each(["arc-testnet", "arc-mainnet"] as const)(
    "%s names a v4 router and a PoolManager, which is what makes a graduated token tradeable",
    (network) => {
      const config = resolveNetwork(network);
      expect(config.contracts.v4Router).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(config.v4?.poolManager).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(config.v4?.lpFee).toBe(POOL_LP_FEE_PIPS);
    },
  );

  it.each(["arc-testnet", "arc-mainnet"] as const)(
    "%s runs the fee-model stack: bonding-curve@4, platform-config@4, arc-now-fee-hook@4",
    (network) => {
      const versions = resolveNetwork(network).contractVersions;
      expect(versions?.curveFactory).toMatch(/^arcnow\/curve-factory@4\./);
      expect(versions?.arcnowPlatform).toMatch(/^arcnow\/platform-config@4\./);
      expect(versions?.platformRegistry).toMatch(/^arcnow\/platform-registry@4\./);
      expect(versions?.feeHook).toMatch(/^arcnow\/arc-now-fee-hook@4\./);
      expect(versions?.launchpad).toMatch(/^arcnow\/launchpad@3\./);
    },
  );

  it("arc-testnet is the fee-model stack deployed at block 62,386,232", () => {
    const config = resolveNetwork("arc-testnet");
    expect(config.chainId).toBe(5042002);
    expect(config.contracts.launchpad.toLowerCase()).toBe("0x675a7a605911b0e3109eca580bc86e708199d952");
    expect(config.deployedAtBlock).toBe(62_386_232);
    expect(config.quoteTokens.find((q) => q.symbol === "EURC")?.address)
      .toBe("0x89b50855aa3be2f677cd6303cec089b5f319d72a");
  });

  it("arc-mainnet is the live deployment: chain 5042, and EURC at its mainnet address", () => {
    const config = resolveNetwork("arc-mainnet");
    expect(config.chainId).toBe(5042);
    expect(config.rpcUrl).toBe("https://rpc.mainnet.arc.io");
    expect(config.contracts.launchpad.toLowerCase()).toBe("0xae1e5558ab71e851ce44f5c0f12ebeaf3db9dae3");
    expect(config.contracts.arcnowPlatform.toLowerCase()).toBe("0xe3c7cd3e98af47de518740c7cfef9fc7064b2ef9");
    expect(config.v4?.poolManager?.toLowerCase()).toMatch(/^0x8366a39c/);
    expect(config.contracts.v4Router?.toLowerCase()).toMatch(/^0x4a142209/);
    expect(config.deployedAtBlock).toBe(21_179_866);
    const eurc = config.quoteTokens.find((q) => q.symbol === "EURC");
    expect(eurc?.address).toBe("0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1");
    expect(eurc?.decimals).toBe(6);
    expect(eurc?.isNative).toBe(false);
    expect(config.quoteTokens.find((q) => q.isNative)?.symbol).toBe("USDC");
  });
});
