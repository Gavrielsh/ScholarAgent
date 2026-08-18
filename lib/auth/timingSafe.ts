import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for secrets of unknown length.
 *
 * `crypto.timingSafeEqual` throws on mismatched buffer sizes, so both sides are
 * hashed to SHA-256 first. The comparison then always runs over 32 bytes.
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
