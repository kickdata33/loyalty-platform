import type { DecodedIdToken } from "firebase-admin/auth";
import { describe, expect, it } from "vitest";

import { buildAuthContext } from "@/modules/shared/auth-context";
import { AuthenticationError } from "@/modules/shared/errors";

function fakeToken(claims: Record<string, unknown>): DecodedIdToken {
  return {
    uid: "auth-uid-1",
    aud: "test",
    auth_time: 0,
    exp: 0,
    firebase: { identities: {}, sign_in_provider: "custom" },
    iat: 0,
    iss: "test",
    sub: "auth-uid-1",
    ...claims,
  } as unknown as DecodedIdToken;
}

describe("buildAuthContext() — fails closed on malformed/missing claims", () => {
  it("throws AuthenticationError when merchantId is missing", () => {
    const token = fakeToken({ role: "STAFF", staffUserId: "s1" });
    expect(() => buildAuthContext(token)).toThrow(AuthenticationError);
  });

  it("throws AuthenticationError when role is missing or not one of OWNER/MANAGER/STAFF", () => {
    expect(() =>
      buildAuthContext(fakeToken({ merchantId: "m1", staffUserId: "s1" })),
    ).toThrow(AuthenticationError);
    expect(() =>
      buildAuthContext(fakeToken({ merchantId: "m1", role: "SUPERUSER", staffUserId: "s1" })),
    ).toThrow(AuthenticationError);
  });

  it("throws AuthenticationError when staffUserId is missing", () => {
    expect(() => buildAuthContext(fakeToken({ merchantId: "m1", role: "STAFF" }))).toThrow(
      AuthenticationError,
    );
  });

  it("throws AuthenticationError when branchScope is present but not an array", () => {
    expect(() =>
      buildAuthContext(
        fakeToken({ merchantId: "m1", role: "STAFF", staffUserId: "s1", branchScope: "not-an-array" }),
      ),
    ).toThrow(AuthenticationError);
  });

  it("builds a well-formed AuthContext from valid claims, defaulting branchScope to []", () => {
    const result = buildAuthContext(
      fakeToken({ merchantId: "m1", role: "OWNER", staffUserId: "s1" }),
    );
    expect(result).toEqual({
      authUid: "auth-uid-1",
      merchantId: "m1",
      role: "OWNER",
      staffUserId: "s1",
      branchScope: [],
    });
  });

  it("preserves a valid, non-empty branchScope", () => {
    const result = buildAuthContext(
      fakeToken({ merchantId: "m1", role: "STAFF", staffUserId: "s1", branchScope: ["b1", "b2"] }),
    );
    expect(result.branchScope).toEqual(["b1", "b2"]);
  });
});
