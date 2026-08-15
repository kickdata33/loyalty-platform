import { describe, expect, it } from "vitest";

import { createMerchantWithOwner } from "@/modules/merchant/service";
import { ConflictError, ValidationError } from "@/modules/shared/errors";
import { createStaffUser } from "@/modules/staff/service";

import { createMerchantFixture, createTestAuthUser, uniqueSlug } from "./setup";

/**
 * Concurrency-safety tests found and fixed during the Phase 1 security review: both uniqueness
 * checks below originally ran as a plain query *before* the write (classic TOCTOU) and have been
 * moved to run as a `tx.get(query)` *inside* the same Firestore transaction that performs the
 * write — Firestore includes queries read inside a transaction in its optimistic-concurrency
 * conflict detection, so the loser of a race is retried and observes the winner's document.
 */
describe("Race conditions — uniqueness checks are transaction-safe (emulator)", () => {
  it("createMerchantWithOwner: only one of two concurrent signups with the same slug succeeds", async () => {
    const slug = uniqueSlug("race-merchant");
    const ownerAuthUidA = await createTestAuthUser("race-owner-a");
    const ownerAuthUidB = await createTestAuthUser("race-owner-b");

    const results = await Promise.allSettled([
      createMerchantWithOwner({
        name: "Race A",
        slug,
        businessType: "cafe",
        timezone: "Asia/Bangkok",
        ownerAuthUid: ownerAuthUidA,
      }),
      createMerchantWithOwner({
        name: "Race B",
        slug,
        businessType: "cafe",
        timezone: "Asia/Bangkok",
        ownerAuthUid: ownerAuthUidB,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });

  it("createStaffUser: only one of two concurrent calls for the same authUid+merchant succeeds", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const authUid = await createTestAuthUser("race-staff");

    const results = await Promise.allSettled([
      createStaffUser(ownerCtx, { authUid, role: "STAFF" }),
      createStaffUser(ownerCtx, { authUid, role: "STAFF" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
  });
});
