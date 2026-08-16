import { describe, expect, it, vi } from "vitest";

import { verifyLineIdToken } from "@/modules/line-integration/id-token-verification";
import { ValidationError } from "@/modules/shared/errors";

/**
 * FINAL-ARCHITECTURE.md §22 Definition of Done: "Phase 7 ต้องมี automated test สำหรับ Backend ID
 * Token verification ก่อนถือว่าเสร็จ" — this file satisfies that requirement. `fetch` is injected
 * (never the real global) so this suite never makes a real network call to LINE (§21 verification
 * logic is tested in isolation, not LINE's own service).
 */

const CHANNEL_ID = "1234567890";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("verifyLineIdToken — §21 backend verification, no exceptions", () => {
  it("returns the verified sub/aud/exp on a successful LINE response", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const fetchImpl = fakeFetch(200, { sub: "U_verified_user_id", aud: CHANNEL_ID, exp: futureExp });

    const result = await verifyLineIdToken("real-looking-token", CHANNEL_ID, fetchImpl);
    expect(result).toEqual({ sub: "U_verified_user_id", aud: CHANNEL_ID, exp: futureExp });
  });

  it("rejects when LINE's endpoint itself rejects the token (bad signature/malformed)", async () => {
    const fetchImpl = fakeFetch(400, { error: "invalid_request" });
    await expect(verifyLineIdToken("bad-token", CHANNEL_ID, fetchImpl)).rejects.toThrow(ValidationError);
  });

  it("rejects an expired token even if LINE's endpoint somehow returned 200", async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const fetchImpl = fakeFetch(200, { sub: "U_expired", aud: CHANNEL_ID, exp: pastExp });
    await expect(verifyLineIdToken("expired-token", CHANNEL_ID, fetchImpl)).rejects.toThrow(ValidationError);
  });

  it("rejects an audience mismatch — a token valid for a DIFFERENT merchant's Login Channel (§26 cross-tenant impersonation check)", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const fetchImpl = fakeFetch(200, { sub: "U_other_merchant_user", aud: "some-other-channel-id", exp: futureExp });
    await expect(verifyLineIdToken("token-for-another-merchant", CHANNEL_ID, fetchImpl)).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects a response missing required claims rather than guessing defaults", async () => {
    const fetchImpl = fakeFetch(200, { aud: CHANNEL_ID }); // no sub, no exp
    await expect(verifyLineIdToken("incomplete-response-token", CHANNEL_ID, fetchImpl)).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects an empty idToken before ever calling out to LINE", async () => {
    const fetchImpl = vi.fn();
    await expect(verifyLineIdToken("", CHANNEL_ID, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      ValidationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
