/**
 * Tool definitions, and the two rules every one of them obeys.
 *
 * # 1. Arguments are strict
 *
 * Every input schema is a `strictObject`, so an argument this server did not
 * ask for is a **refusal**, not a silently ignored key. That matters for
 * exactly one reason: if a model — prompted by a page, a token name, or a
 * user who was told to — tries to pass `privateKey`, `mnemonic` or
 * `signerSecret`, the call fails and says so, instead of dropping the field on
 * the floor and leaving the secret in the transcript anyway. The failure is the
 * point; the secret is already spent either way, but the operator finds out.
 *
 * # 2. Money is a decimal string, never a JSON number
 *
 * `25.5` as a JSON number is an IEEE double, and a double cannot hold
 * `0.000193050193050194` — the shipped curve's last price — or any 18-decimal
 * quantity worth more than about nine million. Amounts therefore cross this
 * boundary as strings and are parsed by the SDK's `QuoteAmount.parse` — in the
 * decimals of the quote the amount is in, 18 for native USDC, 6 for EURC — or
 * `Tokens.parse`, both of which reject a decimal place too many rather than
 * truncating it.
 *
 * @module
 */

import { z } from "zod";

export { z };

import type { ArcNowPort } from "../sdk-port.js";
import type { ServerConfig } from "../config.js";

/** What a handler is given besides its arguments. */
export interface ToolContext {
  readonly port: ArcNowPort;
  readonly config: ServerConfig;
}

/** What a handler returns: one readable report, and whether it is a failure. */
export interface ToolOutput {
  readonly text: string;
  readonly isError?: boolean;
}

/**
 * `read` tools cannot sign, cannot spend and are always published. `write`
 * tools are published only when the operator opted in at startup, and are
 * refused by name — not hidden behind "unknown tool" — when they did not.
 */
export type ToolAccess = "read" | "write";

export interface AnyTool {
  readonly name: string;
  readonly title: string;
  readonly access: ToolAccess;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  run(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly access: ToolAccess;
  /**
   * `destructive` means "this cannot be undone by calling something else".
   * A launch is destructive. A buy is not — it can be sold back, at a price.
   */
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly description: string;
  readonly input: Shape;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): AnyTool {
  const schema = z.strictObject(spec.input);
  return {
    name: spec.name,
    title: spec.title,
    access: spec.access,
    description: spec.description,
    inputSchema: z.toJSONSchema(schema, { io: "input" }),
    annotations: {
      title: spec.title,
      readOnlyHint: spec.access === "read",
      destructiveHint: spec.destructive ?? false,
      idempotentHint: spec.idempotent ?? spec.access === "read",
      // Every one of these reads a public blockchain.
      openWorldHint: true,
    },
    async run(rawArgs, ctx) {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return { isError: true, text: explainParseFailure(spec.name, parsed.error) };
      }
      return spec.run(parsed.data, ctx);
    },
  };
}

const SECRET_LOOKING = /(private|secret|mnemonic|seed|passphrase|password|key)/i;

function explainParseFailure(tool: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  ${path}: ${issue.message}`;
  });
  const unrecognised = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : []);
  const secretish = unrecognised.filter((k) => SECRET_LOOKING.test(k));
  const extra = secretish.length > 0
    ? "\n\nOne of those is named like a credential. No tool on this server takes a key, a "
    + "mnemonic or any other secret as an argument, and this one did not silently ignore "
    + "it — it refused. A tool argument is written into a transcript, and a key that has "
    + "been through a transcript has been published. If that value is real, ROTATE IT. "
    + "Signing is configured by whoever starts the server, from the environment."
    : "";
  return `${tool}: those arguments were not accepted.\n${lines.join("\n")}${extra}`;
}

// ── shared argument shapes ───────────────────────────────────────────────────
// Built by functions rather than shared constants so that no two tools share a
// schema object; a shared instance is what makes zod emit `$ref`/`$defs`, and a
// tool schema full of references is harder for a model to read than one that
// repeats itself.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d{1,30}(\.\d{1,18})?$/;

export function addressArg(description: string) {
  return z.string().regex(ADDRESS, "expected a 0x-prefixed 20-byte address").describe(description);
}

export function decimalArg(description: string) {
  return z.string().regex(DECIMAL,
    "expected a decimal amount as a string, e.g. \"25\" or \"1.5\" — not a JSON number, "
    + "which cannot hold 18 decimals exactly").describe(description);
}

export function slippageArg() {
  return z.number().int().min(0).max(10_000).describe(
    "Slippage tolerance in basis points, applied to a quote taken in this same call to "
    + "produce the on-chain minimum-out floor. 50 = 0.5%. There is no default and there "
    + "will not be one: 0 means \"fill me at any price\", which on a public mempool is a "
    + "donation, so it has to be typed. On a bonding curve the price rises across your own "
    + "order, so a floor is protection against other people's orders landing first, not "
    + "against your own impact — that is already in the quote.",
  );
}

export function intArg(min: number, max: number, fallback: number, description: string) {
  return z.number().int().min(min).max(max).default(fallback).describe(description);
}

export function boolArg(fallback: boolean, description: string) {
  return z.boolean().default(fallback).describe(description);
}

export function textArg(max: number, description: string) {
  return z.string().min(1).max(max).describe(description);
}

/**
 * Why a launch cannot go without a metadata URI, said where the argument is refused.
 *
 * `Launchpad.launch` reverts with `InvalidLaunchParameters` when the URI is empty,
 * (`src/Launchpad.sol:186-192`). `quoteLaunch` does not
 * check it, so the refusal lives here, in the schema both launch tools share:
 * before any quote, any RPC call or any transaction.
 */
const METADATA_URI_REQUIRED
  = "a metadata URI is required — the launchpad reverts a launch whose URI is empty "
    + "(InvalidLaunchParameters), so a token cannot be launched without one";

export function metadataUriArg() {
  return z.string({
    error: (issue) => (issue.input === undefined ? METADATA_URI_REQUIRED : undefined),
  }).min(1, METADATA_URI_REQUIRED).max(512).describe(
    "REQUIRED. An ipfs:// or https:// URI for the token's metadata — image, description, "
    + "links. The launchpad reverts a launch whose URI is empty (InvalidLaunchParameters), so "
    + "there is no launching without one. Permanent: it is stamped into the token at launch "
    + "and there is no setter.",
  );
}

/**
 * The one argument that makes a write tool's cost a stated intention rather
 * than an open tab.
 *
 * The caller names the most it believes this call will spend. The server takes
 * a fresh quote, and if the real cost is above that number it refuses and shows
 * both figures. It catches a quote that went stale between being shown to a
 * person and being acted on, a curve that moved, and a model that was talked
 * into spending more than the conversation agreed to — none of which the
 * operator's ceiling catches on its own, because that ceiling is a single
 * number for the whole session.
 */
export function maxCostArg(what: string) {
  return z.string().regex(/^\d{1,30}(\.\d{1,18})?$/,
    "expected a decimal amount as a string").describe(
    `The most you intend ${what} to cost, in whole units of the token's quote — native USDC, `
    + "or the ERC-20 such as EURC it is priced in — as a string, with no more decimals than "
    + "that quote has. REQUIRED, and it is checked against a quote taken inside this call: if "
    + "the real cost is higher, nothing is sent and both numbers are reported. Set it from a "
    + "quote you have actually shown to the person whose money it is — not from the number you "
    + "hope it will be. Gas is on top of this and is always paid in native USDC.",
  );
}

/** A decimal amount in the quote token the trade is priced in. */
export function quoteAmountArg(description: string) {
  return decimalArg(description);
}
