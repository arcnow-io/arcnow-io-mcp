/**
 * Turning whatever went wrong into something a model can act on.
 *
 * The SDK's errors are already good — decoded by selector across every pinned
 * ABI, carrying their parameters and a sentence saying what to do — so the job
 * here is mostly to not lose them, and to add the one thing the SDK cannot
 * know: which tool was being run.
 *
 * # Three kinds of failure, said as three different things
 *
 * - **The chain said no:** a decoded contract error, or one of the SDK's codes
 *   for a revert (`WrappedRevert`, `UnknownRevert`, `RevertString`, `Panic`,
 *   `EmptyRevert`). "failed on-chain".
 * - **The SDK refused before building a transaction:** every other code in the
 *   SDK's own `SDK_ERROR_CODES` — an unknown curve, platform or hook version, an address
 *   that is not a curve. "refused".
 * - **The question never reached the chain:** `RpcFailure`. "could not reach the
 *   chain" — a rate limit or a timeout, which says nothing about the token.
 *
 * A revert that came back through Uniswap v4's `WrappedError` keeps the layers
 * it came through, which the SDK decodes onto `details.wrappedBy` — including
 * which transfer out of the PoolManager failed.
 *
 * Its own module, rather than a function in the dispatcher, because a write
 * tool sometimes has to render an error *inside* a report: a pool sell whose
 * router approval went through and whose swap then did not has to say both.
 *
 * @module
 */

import type { ArcNowError, WrappedLayer } from "@arcnow/sdk";
import {
  AmountParseError,
  isArcNowError,
  SDK_ERROR_CODES,
  WRAPPED_ERROR_SELECTOR,
} from "@arcnow/sdk";

import { addr, note, report, section } from "../format.js";
import { QuoteInputError } from "./quote.js";
import { NotACurveOrTokenError, NotArcNowError } from "./resolve.js";

/** The SDK's codes for a revert it decoded, or could not: the chain refused. */
const REVERT_CODES: ReadonlySet<string> = new Set([
  "WrappedRevert", "UnknownRevert", "RevertString", "Panic", "EmptyRevert",
]);

/** Every code the SDK raises itself, as opposed to a contract error's name. */
const SDK_CODES: ReadonlySet<string> = new Set(SDK_ERROR_CODES);

/**
 * What a quote-token contract error means, for a model deciding what to tell a
 * user. Only the ones whose name alone does not say what to do next.
 */
const QUOTE_ERROR_NOTES: Readonly<Record<string, string>> = {
  QuoteTokenNotSupported:
    "The launchpad does not accept this quote token for a launch. Nothing was launched. "
    + "arcnow_quote_tokens lists what its quote registry accepts; launch in one of those, or in "
    + "native USDC. If an ERC-20 approve was sent first, it still stands.",
  QuoteNotEnabledOnPlatform:
    "This platform serves no curve template for that quote, so it cannot launch in it. Nothing "
    + "was launched. Launch in a quote the platform enables — native USDC always is on "
    + "arcnow.io's own — or under another platform.",
  MigratorDoesNotSupportQuote:
    "The graduation venue chosen cannot migrate a curve priced in this quote. Nothing was launched.",
  LaunchFeeAboveMaximum:
    "The launch fee for this quote was raised after it was quoted, and the launch refused to pay "
    + "more than the fee it was shown. Nothing was launched. Re-quote and show the new total.",
  QuoteTransferShortfall:
    "The quote token delivered less than the amount pulled — a token that takes a fee on "
    + "transfer, or a paused or blocklisted account. Nothing was traded.",
};

export function renderError(tool: string, error: unknown): string {
  if (error instanceof QuoteInputError) return error.message;
  if (error instanceof NotACurveOrTokenError) return notACurveOrToken(tool, error.refusal);
  if (isArcNowError(error)) {
    if (error.code === "QuoteTransferOutOfGas") return quoteTransferOutOfGas(tool, error);
    if (error.code === "UnknownCurveVersion") return unknownCurveVersion(tool, error);
    if (error.code === "RpcFailure") return transportFailure(tool, error);
    if (SDK_CODES.has(error.code) && !REVERT_CODES.has(error.code)) return sdkRefusal(tool, error);
    const args = Object.entries(error.args);
    return report(
      `${tool} failed on-chain: ${error.code}`,
      error.message,
      args.length === 0
        ? undefined
        : `Details: ${args.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`,
      wrapperSection(error),
      QUOTE_ERROR_NOTES[error.code] === undefined ? undefined : note(QUOTE_ERROR_NOTES[error.code] ?? ""),
    );
  }
  if (error instanceof NotArcNowError) return error.message;
  if (error instanceof AmountParseError) {
    return report(
      `${tool}: that amount could not be read.`,
      error.message,
      note("Amounts here are decimal strings in whole units — \"25\", \"1.5\" — not raw "
        + "integers and not JSON numbers. Token quantities have 18 decimals; an amount of a quote "
        + "token has that quote's own — native USDC 18, EURC 6 — and an amount with more decimal "
        + "places than that is rejected rather than quietly truncated."),
    );
  }
  if (error instanceof Error) return `${tool} failed: ${error.message}`;
  return `${tool} failed: ${String(error)}`;
}

function detail(error: ArcNowError, key: string): string | undefined {
  const value = error.details[key];
  return typeof value === "string" ? value : undefined;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function sdkRefusal(tool: string, error: ArcNowError): string {
  const details = Object.entries(error.details)
    .filter(([key, value]) => key !== "wrappedBy"
      && (typeof value === "string" || typeof value === "number" || typeof value === "bigint"));
  return report(
    `${tool} refused: ${error.code}`,
    error.message,
    details.length === 0
      ? undefined
      : `Details: ${details.map(([k, v]) =>
        `${k}=${typeof v === "string" && ADDRESS.test(v) ? addr(v) : String(v)}`).join(", ")}`,
    error.code === "ReadOnlyClient"
      ? note("That means this server has no signer even though a write tool ran, which "
        + "should not be reachable — report it rather than retrying.")
      : error.code === "QuoteAmountNotRepresentable"
        ? note("The SDK refused this call itself, before building its transaction: the amount is "
          + "not a whole number of its quote token's raw units, and an ERC-20 cannot move a "
          + "fraction of one. Pass an amount with no more decimals than the quote has.")
        : error.code === "QuoteTokenMismatch"
          ? note("The SDK refused this call itself, before building its transaction: an amount of "
            + "one quote token was offered where another is priced. Nothing converts between "
            + "quotes here.")
          : note("The SDK refused this call itself, before building its transaction."),
  );
}

/**
 * An ERC-20 trade or launch that ran out of gas inside a fee-share transfer.
 *
 * The contracts' gas guard on ERC-20 fee shares (contracts#23,
 * `QuoteTransfer.tryPushBounded`) reverts with no data when too little gas is
 * left, and the SDK names that `QuoteTransferOutOfGas`. It is a gas limit too
 * tight — not an unknown revert, and not a refusal made before anything was
 * attempted — so it is said as exactly that, with the one thing to do about it.
 */
function quoteTransferOutOfGas(tool: string, error: ArcNowError): string {
  const quote = detail(error, "quoteToken");
  const limit = error.details.gasLimit;
  return report(
    `${tool} failed on-chain: QuoteTransferOutOfGas — the transaction ran out of gas paying an `
    + `ERC-20 fee share${quote === undefined ? "" : ` in the quote token ${addr(quote)}`}.`,
    error.message,
    section("details", [
      ["quote token", quote === undefined ? "(not reported)" : addr(quote)],
      ["gas limit", typeof limit === "bigint" || typeof limit === "number"
        ? `gasLimit=${limit.toString()}`
        : "none set — the node's estimate plus the SDK's headroom"],
    ]),
    note("arcnow.io's contracts send each ERC-20 fee share through a gas guard that reverts with no "
      + "data when too little gas is left for the transfer, so this is a gas limit too tight for the "
      + "transfers, not a rejection of the trade and nothing wrong with the token. To fix it, leave "
      + "the gas limit unset, or raise it: with none set the SDK sends the node's estimate plus a "
      + "fifth — at least 150,000 more for a curve trade or a launch, at least 400,000 more for a "
      + "pool swap — and a trade that graduates the curve gets 8,000,000. A trade "
      + "is simulated before it is sent, so this normally means nothing was sent; check the balance "
      + "before retrying anyway."),
  );
}

function transportFailure(tool: string, error: ArcNowError): string {
  return report(
    `${tool} could not reach the chain: RpcFailure`,
    error.message,
    note("This is the transport — the endpoint, a rate limit or a timeout — and it says "
      + "nothing about the address, the token or the trade. If it happened while a transaction "
      + "was being sent, check the balance before trying again; otherwise try again after a "
      + "pause."),
  );
}

function notACurveOrToken(tool: string, refusal: ArcNowError): string {
  return report(
    `${tool} refused: AddressIsNotACurve — this address is not an arcnow.io bonding curve, and `
    + "it is not an arcnow.io token either.",
    refusal.message,
    note("Read as a token, it named no arcnow.io curve. Nothing was quoted and nothing was sent. "
      + "A launch gives two addresses — the token and its curve — and either one works here; "
      + "anything else, an ordinary ERC-20 such as the USDC interface predeploy included, does "
      + "not."),
  );
}

/** What the SDK refused, by the component whose `VERSION()` it read. */
const REFUSED_COMPONENT: Readonly<Record<string, string>> = {
  "bonding-curve": "this curve",
  "platform-config": "this platform",
  "platform-registry": "this platform registry",
  "quote-registry": "this quote registry",
  "launchpad": "this launchpad",
  "arc-now-fee-hook": "this fee hook",
};

function unknownCurveVersion(tool: string, error: ArcNowError): string {
  const version = detail(error, "version") ?? "(not reported)";
  const component = detail(error, "component") ?? "bonding-curve";
  const what = REFUSED_COMPONENT[component] ?? `this ${component}`;
  return report(
    `${tool} refused: UnknownCurveVersion — ${what} answers VERSION() `
    + `${JSON.stringify(version)}, which is not a version this server prices.`,
    error.message,
    note("Nothing was quoted and nothing was sent. arcnow.io has one bonding curve, the "
      + "constant-product arcnow/bonding-curve@3.x.x, priced in a quote token and launched under "
      + "arcnow/platform-config@3.x.x platforms through arcnow/launchpad@3.x.x, whose quote "
      + "registry is arcnow/quote-registry@1.x.x. Any other version — the 2.x contracts Arc "
      + "testnet ran until the multi-quote reset and the retired linear curve, @1.x.x, included "
      + "— is refused rather "
      + "than priced, because another build can keep another quantity in the same slots and a "
      + "guess would be a plausible, wrong number. Do not estimate a price for it some other way."),
  );
}

/** The `WrappedError` layers the SDK peeled off a revert, outermost first. */
function wrappedLayers(error: ArcNowError): readonly WrappedLayer[] {
  const layers = error.details.wrappedBy;
  return Array.isArray(layers) ? (layers as readonly WrappedLayer[]) : [];
}

function wrapperSection(error: ArcNowError): string | undefined {
  const layers = wrappedLayers(error);
  if (layers.length === 0) return undefined;
  const rows: [string, string][] = layers.map((layer, index) => [
    index === 0 ? "wrapped by" : "inside that",
    `${layer.selectorName ?? layer.selector} on ${addr(layer.target)}`
    + (layer.detailsName === undefined ? "" : ` (${layer.detailsName})`),
  ]);
  if (error.code === "WrappedRevert") {
    const reason = detail(error, "reason");
    rows.push(["inner revert", reason === undefined
      ? "not reported"
      : reason === "0x"
        ? "no data at all"
        : `${reason} — in none of the ABIs the SDK carries`]);
  }
  return section(
    `Uniswap v4 WrappedError (${WRAPPED_ERROR_SELECTOR}) layers, outermost first`,
    rows,
  );
}

/**
 * A pool quote or trade, rendered — naming what failed when the SDK could.
 *
 * Uniswap v4 wraps a failing hook call, and a failing transfer out of the
 * PoolManager, in `WrappedError`. The SDK unwraps it: a known inner error keeps
 * its own code, and an empty reason is `WrappedRevert`, whose layers the SDK
 * decodes — `NativeTransferFailed` or `ERC20TransferFailed` for a transfer.
 *
 * This server adds no cause of its own on top. It says which transfer failed
 * when a layer names one, tells the model which tool to use next, and shows the
 * SDK's explanation and the layers once, beneath.
 */
export function renderPoolError(tool: string, side: "buy" | "sell", error: unknown): string {
  if (!isArcNowError(error) || error.code !== "WrappedRevert") {
    return renderError(tool, error);
  }
  const failed = wrappedLayers(error).map((layer) => layer.detailsName);
  const transfer = failed.includes("NativeTransferFailed")
    ? "a native USDC transfer"
    : failed.includes("ERC20TransferFailed") ? "an ERC-20 transfer" : undefined;
  return report(
    transfer === undefined
      ? `${tool}: the pool refused this ${side}, for a reason the SDK could not decode.`
      : `${tool}: the pool refused this ${side} — ${transfer} out of the PoolManager failed `
        + "inside the swap.",
    note(transfer === undefined
      ? "A call inside the swap reverted with a reason the SDK could not decode; the layers "
      + "below name which call. Nothing here says what the cause was. A smaller amount may go "
      + `through; quote it first with arcnow_quote_${side}.`
      : "The SDK decoded which transfer failed and gives its reason below. Before trying again, "
        + `quote a smaller amount with arcnow_quote_${side}, and do not tell the user the pool `
        + "is empty or broken: nothing here shows either."),
    note("A trade is simulated before it is sent, so a revert reported like this normally "
      + "means nothing was sent. Check the balance before retrying anyway."),
    renderError(tool, error),
  );
}
