/**
 * Minimal JWT decoder.
 *
 * The Pluggy SDK obtains a JWT API key from `POST /auth`. We never want
 * to verify or trust it locally (the SDK does that against the Pluggy
 * server), but it is occasionally useful to peek at claims like `exp`
 * or `iat` when diagnosing token-related issues in stderr logs.
 *
 * No cryptography is performed here — this is a base64url decoder.
 */

export type JwtClaims = {
  iat?: number;
  exp?: number;
  sub?: string;
  [key: string]: unknown;
};

/**
 * Decode the payload of a JWT without verifying its signature.
 * Returns `null` if the token is malformed.
 */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const payload = parts[1];
  if (!payload) {
    return null;
  }

  try {
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}
