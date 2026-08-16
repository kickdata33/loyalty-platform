import "server-only";

import { ValidationError } from "@/modules/shared/errors";

/**
 * LINE ID Token backend verification (FINAL-ARCHITECTURE.md §21 — Security Note บังคับ, §22
 * Definition of Done: "Phase 7 ต้องมี automated test สำหรับ Backend ID Token verification ก่อนถือว่า
 * เสร็จ").
 *
 * `liff.getProfile()`/any client-supplied userId is untrusted (§21). The ONLY trusted source of a
 * `lineUserId` anywhere in this codebase is the `sub` claim returned by THIS function after a
 * successful verify call — never a raw client payload field.
 *
 * Uses LINE's hosted "Verify ID Token" endpoint (`POST https://api.line.me/oauth2/v2.1/verify`)
 * rather than local JWT signature verification — §21 explicitly allows either approach ("เรียก LINE
 * Verify ID Token endpoint (หรือ verify JWT signature/claims ตาม LINE spec...)"), and the hosted
 * endpoint requires no new cryptography/JWKS-fetching dependency, consistent with CLAUDE.md's
 * "หลีกเลี่ยง dependency ที่ไม่จำเป็น".
 */

const LINE_VERIFY_ENDPOINT = "https://api.line.me/oauth2/v2.1/verify";

export interface VerifiedLineIdToken {
  /** The verified LINE userId — the only value ever passed as `subject` into
   * `resolveOrCreatePlatformCustomer({provider:'line', ...})`. */
  sub: string;
  aud: string;
  exp: number;
}

/** Injected fetch for testability — defaults to the global `fetch`, tests substitute a fake so no
 * real network call to LINE ever happens in the automated suite. */
export type FetchLike = typeof fetch;

/**
 * Verifies `idToken` against LINE's servers for the given merchant's Login Channel ID.
 *
 * §21 requires rejecting outright (never creating/modifying any PlatformCustomer/Membership) on
 * any of: bad signature, wrong `aud` (this merchant's Login Channel ID must match exactly — closes
 * the cross-tenant impersonation path named in §26), or expired token. LINE's `/verify` endpoint
 * itself validates signature/expiry; this function additionally re-checks `aud` against the
 * expected channel id server-side rather than trusting the endpoint's own audience matching alone
 * (defense in depth — never trust a single check for a tenant-isolation-relevant assertion, same
 * posture as every other cross-tenant check in this codebase).
 */
export async function verifyLineIdToken(
  idToken: string,
  expectedLoginChannelId: string,
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedLineIdToken> {
  if (!idToken || idToken.trim().length === 0) {
    throw new ValidationError("idToken is required.");
  }

  const response = await fetchImpl(LINE_VERIFY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: expectedLoginChannelId }).toString(),
  });

  if (!response.ok) {
    // LINE rejected the token outright (bad signature, expired, malformed) — reject, never guess.
    throw new ValidationError("LINE ID Token verification failed.");
  }

  const data = (await response.json()) as { sub?: string; aud?: string; exp?: number };
  if (!data.sub || !data.aud || !data.exp) {
    throw new ValidationError("LINE ID Token verification response missing required claims.");
  }
  if (data.aud !== expectedLoginChannelId) {
    // §26: a token valid for a DIFFERENT merchant's Login Channel must never be accepted here.
    throw new ValidationError("LINE ID Token audience does not match this merchant's Login Channel.");
  }
  if (data.exp * 1000 <= Date.now()) {
    throw new ValidationError("LINE ID Token has expired.");
  }

  return { sub: data.sub, aud: data.aud, exp: data.exp };
}
