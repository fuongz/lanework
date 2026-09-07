import { createHash, randomBytes } from "node:crypto";

/**
 * A fresh PKCE verifier/challenge pair (RFC 7636, S256).
 *
 * 32 random bytes base64url-encode to 43 characters — the minimum the RFC
 * allows, and 256 bits of entropy. The challenge is the only half that leaves
 * this process before redemption; the verifier stays in memory and is sent once,
 * directly to the control plane over TLS. Never log it, never put it in a URL.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest()
    .toString("base64url");
  return { verifier, challenge };
}

/** The opaque `state` we generate, echo-check, and compare. Never reused. */
export function newState(): string {
  return randomBytes(16).toString("base64url");
}
