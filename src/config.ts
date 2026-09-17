/**
 * How this server is configured, and the one decision that matters.
 *
 * # A private key is never a tool argument
 *
 * Every write this server can do needs a key. That key is read **here**, from
 * the process environment or from a file the operator names, and from nowhere
 * else. No tool takes one, no tool schema has a field for one, and
 * `test/unit/no-key-arguments.test.ts` walks every published schema to keep it
 * that way.
 *
 * The reason is not that arguments are less secure than environment variables
 * in general. It is that a tool argument is **written by a model, into a
 * transcript**. It goes to the model provider, into whatever log the client
 * keeps, into the context of every later turn, and into the bug report someone
 * pastes into an issue. A key that has been through a tool call is a key that
 * has been published, and there is no way to un-publish it. The environment is
 * read by one process, in one place, at startup.
 *
 * The key never leaves this module either: {@link ServerConfig} holds a viem
 * `Account` behind a private field and its `toJSON` is the redacted
 * description, so a config object that ends up in a log line or an error dump
 * carries an address and not a secret.
 *
 * # Read-only is the default, and writing is the operator's decision
 *
 * A key being present is **not** consent to spend it. Writing requires
 * `--allow-writes` (or `ARCNOW_MCP_ALLOW_WRITES=1`) from whoever starts the
 * process — a person editing a config file, not a model mid-conversation — and
 * the mode is printed on stderr at startup and reported by the
 * `arcnow_network` tool, so neither the operator nor the model has to guess.
 *
 * A key with no opt-in starts read-only and says so loudly. An opt-in with no
 * key refuses to start: the operator asked for something this process cannot
 * do, and a server that quietly downgrades is a server whose failures arrive
 * later, as "why did it not buy".
 *
 * # Spend caps are per quote token, and a quote with no cap is refused
 *
 * A curve is priced in native USDC or an allowlisted ERC-20 such as EURC, and
 * one number in USDC cannot cap a spend in EURC. So the operator sets one cap
 * per quote token, each in that quote's own units:
 *
 * - `ARCNOW_MCP_MAX_SPEND_USDC` caps native USDC, and defaults to 100.
 * - `ARCNOW_MCP_MAX_SPEND_<SYMBOL>` caps every other quote: `ARCNOW_MCP_MAX_SPEND_EURC=50`.
 *   The symbol is the quote's symbol upper-cased, with anything but a letter
 *   or a digit written as `_`.
 *
 * Fail-closed, in four ways. A quote with **no** cap is refused for every
 * spending write — launch and buy — and non-native quotes get no default, so a
 * cap can never be got round by switching quote. A symbol resolves **only**
 * against the network's own `quoteTokens` (the SDK's `networks.json`, or the
 * network file), never against a token's on-chain `symbol()`, so a token cannot
 * call itself EURC and borrow EURC's cap; a quote the network does not list can
 * have no cap and is always refused. A cap variable naming no quote token of
 * the network is a startup error, which catches typos. And two quote tokens of
 * the network sharing a symbol is a startup error, because their two caps would
 * be one variable.
 *
 * # A network the SDK has no preset for
 *
 * `ARCNOW_MCP_NETWORK_FILE` names a JSON document in the SDK's `CustomNetwork`
 * shape — `rpcUrl`, `chainId`, `contracts`, and optionally `quoteTokens` and
 * `quoteAllowanceSlots` — for a local anvil stack or a fork. It is validated by
 * the SDK's own `resolveNetwork`, and is mutually exclusive with a preset name.
 *
 * @module
 */

import { readFileSync } from "node:fs";

import type { Account, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CustomNetwork, NetworkConfig, QuoteTokenInfo } from "@arcnow/sdk";
import { isArcNowError, NATIVE_USDC, QuoteAmount, resolveNetwork } from "@arcnow/sdk";

/** Bad configuration, phrased for the person who wrote it. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Read-only, or writing. There is no third state and nothing in between. */
export type ServerMode = "read-only" | "write";

/** How far back the launch-log scan is allowed to reach in one tool call. */
export interface LogScanLimits {
  readonly chunkBlocks: bigint;
  readonly maxChunks: number;
}

/** The environment variable that caps native USDC. */
export const NATIVE_CAP_VARIABLE = "ARCNOW_MCP_MAX_SPEND_USDC";

/** Every per-quote cap variable starts with this. */
export const CAP_VARIABLE_PREFIX = "ARCNOW_MCP_MAX_SPEND_";

/** One quote token's cap, as the operator set it. */
export interface SpendCap {
  /** The quote, from the network's `quoteTokens`. */
  readonly token: QuoteTokenInfo;
  /** The environment variable that sets it. */
  readonly variable: string;
  /** The most one write call may spend in this quote. `undefined`: no cap, every spend refused. */
  readonly cap: QuoteAmount | undefined;
}

/** The variable capping `token`: `ARCNOW_MCP_MAX_SPEND_USDC` if native, else `…_<SYMBOL>`. */
export function capVariableFor(token: QuoteTokenInfo): string {
  if (token.isNative) return NATIVE_CAP_VARIABLE;
  return `${CAP_VARIABLE_PREFIX}${token.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** The redacted view: everything about this server except the secret. */
export interface ConfigDescription {
  readonly network: string;
  /** The network file the network came from, or null for a preset. */
  readonly networkFile: string | null;
  readonly rpcUrl: string;
  readonly mode: ServerMode;
  readonly signerAddress: Address | null;
  /** The native USDC cap, as a decimal. */
  readonly maxSpendPerCallUsdc: string;
  /** Every quote token's cap by symbol, in its own units; `null` where none is set (refused). */
  readonly maxSpendPerCall: Readonly<Record<string, string | null>>;
  readonly logScan: { readonly chunkBlocks: string; readonly maxChunks: number };
  readonly warnings: readonly string[];
}

/**
 * The resolved configuration.
 *
 * Deliberately a class and not a plain object: the signing account lives in a
 * `#` field that nothing can enumerate, and `toJSON` is the redacted
 * description. Anything that stringifies this — a log line, an error cause, a
 * crash dump — gets an address.
 */
export class ServerConfig {
  /** The network's name: the preset's, or the network file's. */
  readonly network: string;
  /** The network, resolved by the SDK: what the client is built on and caps resolve against. */
  readonly networkConfig: NetworkConfig;
  /** The network file it came from, when it did. */
  readonly networkFile: string | undefined;
  /** Already redacted of any credential: this is the value that gets printed. */
  readonly rpcUrl: string;
  readonly mode: ServerMode;
  readonly signerAddress: Address | undefined;
  /**
   * The ceiling this process will spend in any one write call, per quote token,
   * whatever a tool argument asks for. The operator's numbers, not the model's.
   */
  readonly spendCaps: readonly SpendCap[];
  readonly logScan: LogScanLimits;
  /** Things worth saying at startup that are not fatal. */
  readonly warnings: readonly string[];

  readonly #account: Account | undefined;
  /** The un-redacted endpoint, for the client. Never printed. */
  readonly #rpcUrlRaw: string | undefined;

  constructor(init: {
    network: string;
    networkConfig: NetworkConfig;
    networkFile: string | undefined;
    rpcUrlRaw: string | undefined;
    rpcUrlDisplay: string;
    mode: ServerMode;
    account: Account | undefined;
    spendCaps: readonly SpendCap[];
    logScan: LogScanLimits;
    warnings: readonly string[];
  }) {
    this.network = init.network;
    this.networkConfig = init.networkConfig;
    this.networkFile = init.networkFile;
    this.rpcUrl = init.rpcUrlDisplay;
    this.mode = init.mode;
    this.#account = init.account;
    this.#rpcUrlRaw = init.rpcUrlRaw;
    this.signerAddress = init.account?.address;
    this.spendCaps = init.spendCaps;
    this.logScan = init.logScan;
    this.warnings = init.warnings;
  }

  /** The signer, when this server is in write mode. `undefined` otherwise. */
  account(): Account | undefined {
    return this.mode === "write" ? this.#account : undefined;
  }

  /** The endpoint to actually connect to, credential and all. */
  rpcUrlForClient(): string | undefined {
    return this.#rpcUrlRaw;
  }

  /**
   * The cap for a quote token, by ADDRESS — never by symbol, so a token that
   * calls itself EURC is not EURC. `undefined` for a quote the network does not
   * list, which no variable can cap.
   */
  spendCapFor(token: QuoteTokenInfo | string): SpendCap | undefined {
    const address = (typeof token === "string" ? token : token.address).toLowerCase();
    return this.spendCaps.find((cap) => cap.token.address === address);
  }

  /** The native USDC cap, which always exists: it defaults to 100. */
  get maxSpendPerCallUsdc(): QuoteAmount {
    const native = this.spendCaps.find((cap) => cap.token.isNative)?.cap;
    if (native === undefined) throw new Error("no native USDC cap: loadConfig always sets one");
    return native;
  }

  /** True when write tools are published and callable. */
  get canWrite(): boolean {
    return this.mode === "write" && this.#account !== undefined;
  }

  describe(): ConfigDescription {
    return {
      network: this.network,
      networkFile: this.networkFile ?? null,
      rpcUrl: this.rpcUrl,
      mode: this.mode,
      signerAddress: this.signerAddress ?? null,
      maxSpendPerCallUsdc: this.maxSpendPerCallUsdc.toString(),
      maxSpendPerCall: Object.fromEntries(
        this.spendCaps.map((cap) => [cap.token.symbol, cap.cap?.toString() ?? null])),
      logScan: {
        chunkBlocks: this.logScan.chunkBlocks.toString(),
        maxChunks: this.logScan.maxChunks,
      },
      warnings: [...this.warnings],
    };
  }

  /** Redacted by construction: whatever stringifies a config gets this. */
  toJSON(): ConfigDescription {
    return this.describe();
  }
}

/** Defaults, named so they can be quoted in documentation and in tests. */
export const DEFAULTS = {
  network: "arc-testnet",
  /**
   * 100 USDC a call. Low enough that a prompt-injected "buy everything" is a
   * bounded accident and not a bounded-by-your-balance one; high enough that
   * the shipped 2 USDC launch fee plus a real first buy fits under it. An
   * operator who means to spend more says so once, at startup, on purpose.
   *
   * Native USDC only. Every other quote has NO default: spending it is refused
   * until the operator names a cap for it.
   */
  maxSpendPerCallUsdc: "100",
  /**
   * Arc's public endpoint has not documented a `eth_getLogs` range limit, so
   * the scan is chunked rather than asking for six million blocks and finding
   * out. 10,000 blocks a request, twenty requests: a bounded amount of work for
   * a tool call, and the result says how far back it actually reached instead
   * of implying it saw everything.
   */
  logChunkBlocks: 10_000n,
  logMaxChunks: 20,
} as const;

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Strip anything secret out of an endpoint before it is ever printed.
 *
 * A private RPC endpoint is very often `https://host/v2/<api-key>` or
 * `https://user:pass@host`. This server prints its endpoint at startup and in
 * `arcnow_network`, and a model reads that output — so the path and the
 * userinfo go, and what is left is the origin plus a marker saying something
 * was there.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<unparseable endpoint>";
  }
  const auth = url.username || url.password ? "<credentials>@" : "";
  const tail = url.pathname !== "/" && url.pathname !== "" ? "/…" : url.search ? "/…" : "";
  return `${url.protocol}//${auth}${url.host}${tail}`;
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readKeyFile(path: string, readFile: (p: string) => string): string {
  try {
    return readFile(path).trim();
  } catch (cause) {
    throw new ConfigError(
      `ARCNOW_PRIVATE_KEY_FILE points at ${path} and it could not be read. `
      + "Nothing was logged about its contents and nothing was guessed; fix the path "
      + "or the permissions.",
      { cause },
    );
  }
}

/**
 * Turn an environment and a command line into a {@link ServerConfig}.
 *
 * Pure apart from the `readFile` it is handed, so the whole configuration
 * surface — including every refusal — is testable without a process, a file or
 * a key that is worth anything.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[] = [],
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ServerConfig {
  const warnings: string[] = [];

  for (const arg of argv) {
    if (arg !== "--allow-writes" && arg !== "--read-only" && !arg.startsWith("--network=")) {
      throw new ConfigError(
        `unknown option ${arg}. This server takes --allow-writes, --read-only and `
        + "--network=<name>; everything else is an environment variable, because an "
        + "MCP client's config file is where the operator's decisions belong.",
      );
    }
  }

  const networkArg = argv.find((a) => a.startsWith("--network="))?.slice("--network=".length);
  const networkFile = env.ARCNOW_MCP_NETWORK_FILE?.trim() || undefined;
  const namedNetwork = networkArg ?? (env.ARCNOW_MCP_NETWORK?.trim() || undefined);
  if (networkFile !== undefined && namedNetwork !== undefined) {
    throw new ConfigError(
      `ARCNOW_MCP_NETWORK_FILE and a network name are mutually exclusive: the file is `
      + `${networkFile} and the name is ${namedNetwork}. Either the operator means the preset `
      + "or the deployment the file describes, and guessing which one gets real addresses wrong.",
    );
  }
  const network = namedNetwork ?? DEFAULTS.network;

  // Refused here rather than at the first call, so the operator finds out when
  // they start the server instead of when a model tries to trade. The SDK
  // refuses it too, by name; this is the same refusal, said earlier.
  if (networkFile === undefined && network === "arc-mainnet") {
    throw new ConfigError(
      "arc-mainnet does not exist. arcnow.io is not deployed to an Arc mainnet, every "
      + "address in the SDK's preset for it is null on purpose, and this server will not "
      + "invent one. Use arc-testnet, or point ARCNOW_MCP_NETWORK at a network name the "
      + "SDK knows.",
    );
  }

  const networkConfig = networkFile === undefined
    ? resolvePreset(network)
    : readNetworkFile(networkFile, readFile);

  const rpcUrlRaw = env.ARCNOW_RPC_URL?.trim() || undefined;
  if (rpcUrlRaw !== undefined) {
    try {
      new URL(rpcUrlRaw);
    } catch {
      throw new ConfigError(`ARCNOW_RPC_URL is not a URL: ${redactUrl(rpcUrlRaw)}`);
    }
  }

  // ── the key ────────────────────────────────────────────────────────────────
  const inlineKey = env.ARCNOW_PRIVATE_KEY?.trim() || undefined;
  const keyFile = env.ARCNOW_PRIVATE_KEY_FILE?.trim() || undefined;
  if (inlineKey !== undefined && keyFile !== undefined) {
    throw new ConfigError(
      "both ARCNOW_PRIVATE_KEY and ARCNOW_PRIVATE_KEY_FILE are set. Pick one: guessing "
      + "which key the operator meant is not a thing a program should do with a key.",
    );
  }
  const rawKey = inlineKey ?? (keyFile === undefined ? undefined : readKeyFile(keyFile, readFile));

  let account: Account | undefined;
  if (rawKey !== undefined) {
    if (!PRIVATE_KEY_PATTERN.test(rawKey)) {
      // Deliberately says nothing about the value, not even its length: an error
      // message about a key is an error message that will be pasted somewhere.
      throw new ConfigError(
        "the private key is not a 32-byte hex key (0x followed by 64 hex characters). "
        + "Nothing about its value is reported here on purpose.",
      );
    }
    try {
      account = privateKeyToAccount(rawKey as `0x${string}`);
    } catch (cause) {
      throw new ConfigError("the private key could not be turned into an account.", { cause });
    }
  }

  // ── the opt-in ─────────────────────────────────────────────────────────────
  const forcedReadOnly = argv.includes("--read-only");
  const wantsWrites = !forcedReadOnly
    && (argv.includes("--allow-writes") || truthy(env.ARCNOW_MCP_ALLOW_WRITES));

  if (wantsWrites && account === undefined) {
    throw new ConfigError(
      "writes are enabled and there is no key to sign with. Set ARCNOW_PRIVATE_KEY (or "
      + "ARCNOW_PRIVATE_KEY_FILE) in the environment this process is started with, or drop "
      + "the write opt-in and run read-only. This refuses to start rather than quietly "
      + "downgrading, because a server that silently cannot write fails later, in the "
      + "middle of somebody's trade.",
    );
  }
  if (!wantsWrites && account !== undefined && !forcedReadOnly) {
    warnings.push(
      `a signing key is present (${account.address}) and writes are NOT enabled, so this `
      + "server is read-only and that key will not be used. Add --allow-writes, or "
      + "ARCNOW_MCP_ALLOW_WRITES=1, if you meant to let an assistant spend from it.",
    );
  }
  if (forcedReadOnly && (argv.includes("--allow-writes") || truthy(env.ARCNOW_MCP_ALLOW_WRITES))) {
    warnings.push("--read-only was passed alongside a write opt-in; --read-only wins.");
  }

  const mode: ServerMode = wantsWrites ? "write" : "read-only";

  // ── the spend ceilings, one per quote token ────────────────────────────────
  const spendCaps = resolveSpendCaps(env, networkConfig);
  for (const { token, variable, cap } of spendCaps) {
    if (mode === "write" && cap?.isZero() === true) {
      warnings.push(
        `${variable} is 0, so every write that spends ${token.symbol} will be refused. That is `
        + "a legitimate way to run — launch and buy off, migrate and sell still on — but it is "
        + "probably not what was meant.",
      );
    }
  }

  const chunkBlocks = parseBigint(env.ARCNOW_MCP_LOG_CHUNK_BLOCKS, DEFAULTS.logChunkBlocks,
    "ARCNOW_MCP_LOG_CHUNK_BLOCKS");
  const maxChunks = Number(parseBigint(env.ARCNOW_MCP_LOG_MAX_CHUNKS,
    BigInt(DEFAULTS.logMaxChunks), "ARCNOW_MCP_LOG_MAX_CHUNKS"));

  return new ServerConfig({
    network: networkFile === undefined ? network : networkConfig.name,
    networkConfig,
    networkFile,
    rpcUrlRaw,
    rpcUrlDisplay: rpcUrlRaw === undefined
      ? networkFile === undefined ? "(the network preset's endpoint)" : "(the network file's endpoint)"
      : redactUrl(rpcUrlRaw),
    mode,
    account,
    spendCaps,
    logScan: { chunkBlocks, maxChunks },
    warnings,
  });
}

/** A preset, resolved by the SDK; its refusal said as a configuration error. */
function resolvePreset(network: string): NetworkConfig {
  try {
    return resolveNetwork(network as "arc-testnet");
  } catch (cause) {
    throw new ConfigError(
      `${network} is not a network the SDK can build a client for: ${describeSdkError(cause)} `
      + "Use a preset the SDK knows, or describe the deployment in ARCNOW_MCP_NETWORK_FILE.",
      { cause },
    );
  }
}

/**
 * `ARCNOW_MCP_NETWORK_FILE`: a `CustomNetwork` document, validated by the SDK.
 *
 * JSON has no bigint, so an allowance slot may be written as a number or a
 * decimal string; everything else is passed to `resolveNetwork` as it is.
 */
function readNetworkFile(path: string, readFile: (p: string) => string): NetworkConfig {
  let text: string;
  try {
    text = readFile(path);
  } catch (cause) {
    throw new ConfigError(
      `ARCNOW_MCP_NETWORK_FILE points at ${path} and it could not be read. Fix the path or `
      + "the permissions; no network was guessed in its place.",
      { cause },
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`ARCNOW_MCP_NETWORK_FILE ${path} is not JSON.`, { cause });
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ConfigError(
      `ARCNOW_MCP_NETWORK_FILE ${path} is not a JSON object in the SDK's CustomNetwork shape `
      + "({ rpcUrl, chainId, contracts, quoteTokens?, quoteAllowanceSlots? }).",
    );
  }
  const raw = document as Record<string, unknown>;
  const slots = raw.quoteAllowanceSlots;
  const quoteAllowanceSlots: Record<string, bigint> = {};
  if (slots !== undefined && slots !== null) {
    if (typeof slots !== "object" || Array.isArray(slots)) {
      throw new ConfigError(`ARCNOW_MCP_NETWORK_FILE ${path}: quoteAllowanceSlots is not an object.`);
    }
    for (const [address, slot] of Object.entries(slots as Record<string, unknown>)) {
      if (!(typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0)
        && !(typeof slot === "string" && /^\d+$/.test(slot))) {
        throw new ConfigError(
          `ARCNOW_MCP_NETWORK_FILE ${path}: the allowance slot for ${address} is not a `
          + `non-negative integer: ${JSON.stringify(slot)}.`,
        );
      }
      quoteAllowanceSlots[address] = BigInt(slot);
    }
  }
  try {
    return resolveNetwork({ ...(raw as unknown as CustomNetwork), quoteAllowanceSlots });
  } catch (cause) {
    throw new ConfigError(
      `ARCNOW_MCP_NETWORK_FILE ${path} is not a network the SDK accepts: ${describeSdkError(cause)}`,
      { cause },
    );
  }
}

function describeSdkError(error: unknown): string {
  if (isArcNowError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * One cap per quote token of the network, each in its own units.
 *
 * Refuses, at startup: a cap variable naming no quote token of the network; two
 * quote tokens whose symbols make the same variable; a cap that is not an
 * amount of its quote (more decimals than it has, included).
 */
function resolveSpendCaps(
  env: Readonly<Record<string, string | undefined>>,
  networkConfig: NetworkConfig,
): SpendCap[] {
  const tokens = networkConfig.quoteTokens.some((token) => token.isNative)
    ? networkConfig.quoteTokens
    : [NATIVE_USDC, ...networkConfig.quoteTokens];

  const byVariable = new Map<string, QuoteTokenInfo>();
  for (const token of tokens) {
    const variable = capVariableFor(token);
    const other = byVariable.get(variable);
    if (other !== undefined) {
      const symbol = variable.slice(CAP_VARIABLE_PREFIX.length);
      throw new ConfigError(
        `the quote tokens ${other.address} (${other.symbol}) and ${token.address} (${token.symbol}) `
        + `of ${networkConfig.name} share the symbol ${symbol}, so one variable, ${variable}, would `
        + "cap both. A spend cap is per quote token, and two tokens under one cap is a cap that "
        + "does not mean what it says. Fix the network's quoteTokens.",
      );
    }
    byVariable.set(variable, token);
  }

  for (const key of Object.keys(env)) {
    if (!key.startsWith(CAP_VARIABLE_PREFIX) || byVariable.has(key)) continue;
    const known = [...byVariable.entries()]
      .map(([variable, token]) => `${variable} (${token.symbol})`).join(", ");
    throw new ConfigError(
      `${key} names no quote token of ${networkConfig.name}. Its quote tokens take these caps: `
      + `${known}. A symbol is matched upper-cased against the network's own quoteTokens and `
      + "nothing else — never a token's on-chain symbol() — so this variable would cap nothing, "
      + "and it is refused rather than ignored, in case it is a typo for one of those.",
    );
  }

  return [...byVariable.entries()].map(([variable, token]) => {
    const given = env[variable]?.trim() || undefined;
    const raw = token.isNative ? (given ?? DEFAULTS.maxSpendPerCallUsdc) : given;
    if (raw === undefined) return { token, variable, cap: undefined };
    try {
      return { token, variable, cap: QuoteAmount.parse(token, raw) };
    } catch (cause) {
      throw new ConfigError(
        token.isNative
          ? `${variable} is not a decimal USDC amount: ${raw}. It is USDC, in whole units, the way `
          + "a person writes it — \"100\", \"2.5\" — not a wei-scale integer."
          : `${variable} is not an amount of ${token.symbol}: ${raw}. It is whole ${token.symbol}, the `
            + `way a person writes it — "50", "2.5" — with at most ${token.decimals} decimals, `
            + `${token.symbol}'s own, and never a raw integer.`,
        { cause },
      );
    }
  });
}

function parseBigint(raw: string | undefined, fallback: bigint, name: string): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  let value: bigint;
  try {
    value = BigInt(raw.trim());
  } catch {
    throw new ConfigError(`${name} is not an integer: ${raw}`);
  }
  if (value <= 0n) throw new ConfigError(`${name} must be positive; got ${value}.`);
  return value;
}

/**
 * The startup banner, on **stderr**.
 *
 * stdout belongs to the MCP transport and a stray byte there corrupts the
 * protocol frame, so nothing in this server ever writes to it. The banner says
 * the mode first, because that is the fact an operator is checking for.
 */
export function startupBanner(config: ServerConfig): string {
  const lines: string[] = [];
  lines.push("arcnow.io MCP server");
  lines.push(
    config.mode === "write"
      ? `  mode        WRITES ENABLED — this server can spend from ${config.signerAddress ?? "?"}`
      : "  mode        READ-ONLY — no tool here can spend, launch or sign anything",
  );
  lines.push(config.networkFile === undefined
    ? `  network     ${config.network}`
    : `  network     ${config.network} (from ARCNOW_MCP_NETWORK_FILE ${config.networkFile})`);
  lines.push(`  endpoint    ${config.rpcUrl}`);
  if (config.mode === "write") {
    config.spendCaps.forEach(({ token, variable, cap }, index) => {
      lines.push(`  ${index === 0 ? "spend cap " : "          "}  ${cap === undefined
        ? `${token.symbol} none — every spend in ${token.symbol} is refused; set ${variable} to allow it`
        : `${cap.format()} per write call (${variable})`}`);
    });
    lines.push(
      "  reminder    a launch is irreversible and a token's parameters can never be changed.",
    );
  } else {
    lines.push(
      "  to write    restart with --allow-writes and a key in ARCNOW_PRIVATE_KEY. The key is "
      + "read from the environment and is never a tool argument.",
    );
  }
  for (const warning of config.warnings) lines.push(`  warning     ${warning}`);
  return lines.join("\n");
}
