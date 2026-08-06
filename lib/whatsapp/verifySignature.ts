// Meta signs every webhook POST with an HMAC-SHA256 of the raw request body,
// keyed by the app secret, delivered in the X-Hub-Signature-256 header.
// Verification must run against the RAW body bytes — re-serialising the parsed
// JSON changes key order/whitespace and will never match.

import { createHmac, timingSafeEqual } from "node:crypto";

import { logWarn } from "@/lib/logger";

export const META_SIGNATURE_HEADER = "x-hub-signature-256";

const SIGNATURE_PREFIX = "sha256=";

export type SignatureVerdict =
  /** Header present and HMAC matches. */
  | "valid"
  /** Header missing, malformed, or HMAC mismatch — reject the request. */
  | "invalid"
  /** No app secret configured; verification skipped (dev only). */
  | "unconfigured";

let unconfiguredWarningEmitted = false;

/**
 * Constant-time verification of Meta's webhook signature.
 *
 * Returns "unconfigured" (rather than throwing) when WHATSAPP_APP_SECRET is absent
 * so local development keeps working, but emits a one-shot warning so the gap is
 * visible in logs. Callers decide how strict to be about that state.
 */
export function verifyMetaSignature(
  rawBody: string,
  headerValue: string | null
): SignatureVerdict {
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();

  if (!appSecret) {
    if (!unconfiguredWarningEmitted) {
      unconfiguredWarningEmitted = true;
      logWarn(
        "whatsapp_webhook_signature_unconfigured",
        "WHATSAPP_APP_SECRET is not set — inbound webhook signatures are NOT verified. Set it before production."
      );
    }
    return "unconfigured";
  }

  if (!headerValue || !headerValue.startsWith(SIGNATURE_PREFIX)) {
    return "invalid";
  }

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  // Buffer.from silently drops non-hex characters, so compare lengths before
  // timingSafeEqual — it throws on mismatched buffer sizes.
  const received = Buffer.from(headerValue.slice(SIGNATURE_PREFIX.length), "hex");

  if (received.length !== expected.length) {
    return "invalid";
  }

  return timingSafeEqual(received, expected) ? "valid" : "invalid";
}
