/**
 * Configuration: the mode, the key, and the things this server refuses to start
 * with.
 *
 * These are the tests that matter most in this file, in order of how much
 * damage the absence of each would do:
 *
 *   - a key never appears in anything this server prints or serialises;
 *   - read-only is what you get unless somebody asked for otherwise;
 *   - asking for writes without a key stops the server rather than downgrading
 *     it silently;
 *   - arc-mainnet is refused by name rather than resolved to invented addresses.
 */

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, redactUrl, startupBanner } from "../../src/config.js";
import { TEST_KEY } from "../support/context.js";

const KEY_SHAPED = /0x[0-9a-fA-F]{64}/;

describe("mode", () => {
  it("is read-only with an empty environment", () => {
    const config = loadConfig({});
    expect(config.mode).toBe("read-only");
    expect(config.canWrite).toBe(false);
    expect(config.account()).toBeUndefined();
  });

  it("is read-only when a key is present but nobody opted in, and says so", () => {
    const config = loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY });
    expect(config.mode).toBe("read-only");
    expect(config.canWrite).toBe(false);
    // The account is withheld even though a key was parsed: a key is not consent.
    expect(config.account()).toBeUndefined();
    expect(config.warnings.join(" ")).toMatch(/writes are NOT enabled/i);
  });

  it("writes with both the opt-in and a key", () => {
    const config = loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY }, ["--allow-writes"]);
    expect(config.mode).toBe("write");
    expect(config.canWrite).toBe(true);
    expect(config.signerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("takes the opt-in from the environment too", () => {
    const config = loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY, ARCNOW_MCP_ALLOW_WRITES: "1" });
    expect(config.mode).toBe("write");
  });

  it("refuses to start when writes are asked for and there is no key", () => {
    expect(() => loadConfig({}, ["--allow-writes"])).toThrow(ConfigError);
    expect(() => loadConfig({}, ["--allow-writes"])).toThrow(/no key to sign with/i);
  });

  it("lets --read-only win over an environment opt-in", () => {
    const config = loadConfig(
      { ARCNOW_PRIVATE_KEY: TEST_KEY, ARCNOW_MCP_ALLOW_WRITES: "1" },
      ["--read-only"],
    );
    expect(config.mode).toBe("read-only");
    expect(config.canWrite).toBe(false);
  });
});

describe("the key", () => {
  it("is never in the redacted description", () => {
    const config = loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY }, ["--allow-writes"]);
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain(TEST_KEY);
    expect(serialised).not.toMatch(KEY_SHAPED);
    expect(JSON.stringify(config.describe())).not.toMatch(KEY_SHAPED);
  });

  it("is never in the startup banner", () => {
    const banner = startupBanner(loadConfig({ ARCNOW_PRIVATE_KEY: TEST_KEY }, ["--allow-writes"]));
    expect(banner).not.toContain(TEST_KEY);
    expect(banner).not.toMatch(KEY_SHAPED);
    expect(banner).toMatch(/WRITES ENABLED/);
  });

  it("says READ-ONLY first, in the banner, when it is read-only", () => {
    expect(startupBanner(loadConfig({}))).toMatch(/mode\s+READ-ONLY/);
  });

  it("is not quoted back when it is malformed", () => {
    const bad = "0xdefinitelynotakey";
    let message = "";
    try {
      loadConfig({ ARCNOW_PRIVATE_KEY: bad });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/32-byte hex key/);
    expect(message).not.toContain(bad);
  });

  it("can be read from a file instead of the environment", () => {
    const config = loadConfig(
      { ARCNOW_PRIVATE_KEY_FILE: "/secrets/key" },
      ["--allow-writes"],
      () => `${TEST_KEY}\n`,
    );
    expect(config.mode).toBe("write");
  });

  it("refuses to guess when both key sources are set", () => {
    expect(() => loadConfig({
      ARCNOW_PRIVATE_KEY: TEST_KEY,
      ARCNOW_PRIVATE_KEY_FILE: "/secrets/key",
    })).toThrow(/Pick one/);
  });
});

describe("network", () => {
  it("refuses arc-mainnet by name", () => {
    expect(() => loadConfig({ ARCNOW_MCP_NETWORK: "arc-mainnet" }))
      .toThrow(/arc-mainnet does not exist/);
    expect(() => loadConfig({}, ["--network=arc-mainnet"])).toThrow(ConfigError);
  });

  it("defaults to arc-testnet", () => {
    expect(loadConfig({}).network).toBe("arc-testnet");
  });
});

describe("the spend ceiling", () => {
  it("defaults to 100 USDC", () => {
    expect(loadConfig({}).maxSpendPerCallUsdc.toString()).toBe("100");
  });

  it("takes a decimal amount", () => {
    expect(loadConfig({ ARCNOW_MCP_MAX_SPEND_USDC: "2.5" }).maxSpendPerCallUsdc.toString())
      .toBe("2.5");
  });

  it("refuses a ceiling it cannot read as USDC", () => {
    expect(() => loadConfig({ ARCNOW_MCP_MAX_SPEND_USDC: "100 dollars" }))
      .toThrow(/decimal USDC amount/);
  });
});

describe("redactUrl", () => {
  it("removes an api key in the path", () => {
    expect(redactUrl("https://rpc.example.com/v2/abcdef123456"))
      .toBe("https://rpc.example.com/…");
  });

  it("removes userinfo", () => {
    expect(redactUrl("https://user:hunter2@rpc.example.com/"))
      .toBe("https://<credentials>@rpc.example.com");
  });

  it("leaves a plain endpoint alone", () => {
    expect(redactUrl("https://rpc.testnet.arc.io")).toBe("https://rpc.testnet.arc.io");
  });
});

describe("unknown options", () => {
  it("are refused rather than ignored", () => {
    expect(() => loadConfig({}, ["--yolo"])).toThrow(/unknown option/);
  });
});
