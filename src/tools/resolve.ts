/**
 * Turning "an address" into "the curve, and what it currently says".
 *
 * A launch produces two addresses, a token and a curve, and a person holding
 * one of them rarely knows which it is. Every trading tool here therefore
 * accepts either, and resolves it by asking the chain rather than by guessing
 * from the shape of the string — there is nothing in an address to guess from.
 *
 * The SDK answers the first question — is this a bonding curve? — with a code:
 * `AddressIsNotACurve` for an address that is not one (a token, an ERC-20, an
 * account, nothing), `UnknownCurveVersion` for a curve of a version it cannot
 * price, `RpcFailure` when the question never reached the chain. Only the first
 * is followed as a token.
 *
 * @module
 */

import type { Address } from "viem";
import type { ArcNowError, CurveState } from "@arcnow/sdk";
import { isArcNowError } from "@arcnow/sdk";

import type { ArcNowPort, CurveHandle } from "../sdk-port.js";
import { ZERO_ADDRESS } from "../format.js";

export interface ResolvedCurve {
  readonly curve: CurveHandle;
  readonly state: CurveState;
  /** True when the caller handed us a token address and we followed it. */
  readonly viaToken: boolean;
}

/** Raised when an address is neither a curve nor a launched token. */
export class NotArcNowError extends Error {
  override readonly name = "NotArcNowError";
}

/**
 * The SDK's `AddressIsNotACurve` for an address that, read as a token, names no
 * curve either — kept whole, so the refusal a model reads is the SDK's own,
 * saying what the address claimed to be.
 */
export class NotACurveOrTokenError extends Error {
  override readonly name = "NotACurveOrTokenError";

  constructor(readonly refusal: ArcNowError) {
    super(refusal.message);
  }
}

/**
 * Try the address as a curve; failing that, as a token whose `curve()` points
 * at one. Two round trips in the worst case, one in the common one.
 */
export async function resolveCurve(port: ArcNowPort, address: Address): Promise<ResolvedCurve> {
  try {
    const curve = port.curve(address);
    return { curve, state: await curve.state(), viaToken: false };
  } catch (curveError) {
    // Two answers end here rather than being followed as a token: a bonding
    // curve of a version the SDK cannot price IS a curve, and a question that
    // never reached the chain says nothing about what the address is.
    if (isArcNowError(curveError)
      && (curveError.code === "UnknownCurveVersion" || curveError.code === "RpcFailure")) {
      throw curveError;
    }
    let curveAddress: Address;
    try {
      curveAddress = await port.token(address).curve();
    } catch {
      if (isArcNowError(curveError) && curveError.code === "AddressIsNotACurve") {
        throw new NotACurveOrTokenError(curveError);
      }
      throw new NotArcNowError(
        `${address} does not answer as an arcnow.io bonding curve, and does not answer as `
        + "an arcnow.io token either. It may belong to a different chain than this server "
        + "is pointed at, or to nothing at all. A launch gives you two addresses — the "
        + "token and its curve — and either one works here; anything else does not."
        + (isArcNowError(curveError) ? `\n\nReading it as a curve said: ${curveError.message}` : ""),
      );
    }
    if (curveAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new NotArcNowError(
        `${address} answers as a token but names no curve, which should not happen for a `
        + "token this launchpad created. Treat it as not an arcnow.io token.",
      );
    }
    const curve = port.curve(curveAddress);
    return { curve, state: await curve.state(), viaToken: true };
  }
}
