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
import { NETWORKS, resolveNetwork } from "@arcnow/sdk";

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

describe("the deployment the SDK ships", () => {
  it("has a Uniswap v4 venue and no escrow, v2 or v3 — which is the healthy state", () => {
    const config = resolveNetwork("arc-testnet");
    expect(config.venues.uniswapV4).toBe(true);
    expect(config.venues.escrow).toBe(false);
    expect(config.venues.uniswapV2).toBe(false);
    expect(config.venues.uniswapV3).toBe(false);
    expect(config.contracts.escrowMigrator).toBeUndefined();
  });

  it("names arcnow.io's v4 router, which is what makes a graduated token tradeable", () => {
    expect(resolveNetwork("arc-testnet").contracts.v4Router?.toLowerCase())
      .toBe("0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e");
  });

  it("refuses arc-mainnet rather than inventing an address for it", () => {
    expect(() => resolveNetwork("arc-mainnet")).toThrow();
  });
});
