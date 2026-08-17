import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Direct tests of `firestore.rules` (FINAL-ARCHITECTURE.md §3, §5, §7, §9, §18, §26) using
 * `@firebase/rules-unit-testing` against the same Firestore emulator the rest of the suite uses.
 *
 * Every test uses its own randomly generated ids (never a fixed "merchant-a") — the emulator's
 * `singleProjectMode` (firebase.json) means this file shares underlying data with every other
 * emulator test file in the same run, so nothing here relies on being alone in the database.
 * `withSecurityRulesDisabled` is used only to seed fixtures — never to assert on data.
 */

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "loyalty-platform-dev-9a0c5";
const RULES_PATH = path.resolve(import.meta.dirname, "../../firestore.rules");

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

function ownerClaims(merchantId: string, staffUserId: string) {
  return { merchantId, role: "OWNER", staffUserId };
}

async function seedMerchant() {
  const merchantId = `m-${randomUUID()}`;
  const ownerAuthUid = `owner-${randomUUID()}`;
  const staffUserId = `staff-${randomUUID()}`;
  const membershipId = `member-${randomUUID()}`;
  const customerId = `cust-${randomUUID()}`;
  const identityId = `ident-${randomUUID()}`;
  const auditLogId = `audit-${randomUUID()}`;
  const packageId = `pkg-${randomUUID()}`;

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "merchants", merchantId), { name: "Test Merchant", slug: merchantId });
    await setDoc(doc(db, "merchants", merchantId, "branches", "branch-1"), {
      name: "Main",
      isActive: true,
    });
    await setDoc(doc(db, "staffUsers", staffUserId), {
      merchantId,
      authUid: ownerAuthUid,
      role: "OWNER",
      status: "ACTIVE",
    });
    await setDoc(doc(db, "memberships", membershipId), {
      merchantId,
      merchantProfile: { displayName: "Somchai" },
      pointsBalance: 0,
    });
    await setDoc(doc(db, "subscriptions", merchantId), { status: "TRIAL", packageId: null });
    await setDoc(doc(db, "platformCustomers", customerId), { createdAt: new Date() });
    await setDoc(doc(db, "customerIdentities", identityId), { platformCustomerId: customerId });
    await setDoc(doc(db, "auditLogs", auditLogId), { merchantId, action: "test.seed" });
    await setDoc(doc(db, "packages", packageId), { name: "Starter" });
  });

  return {
    merchantId,
    ownerAuthUid,
    staffUserId,
    membershipId,
    customerId,
    identityId,
    auditLogId,
    packageId,
  };
}

describe("firestore.rules — platformCustomers / customerIdentities: 100% deny-all", () => {
  it("denies read to same-merchant staff, other-merchant staff, and superAdmin", async () => {
    const { customerId, identityId, merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();

    await assertFails(getDoc(doc(staff, "platformCustomers", customerId)));
    await assertFails(getDoc(doc(admin, "platformCustomers", customerId)));
    await assertFails(getDoc(doc(staff, "customerIdentities", identityId)));
    await assertFails(getDoc(doc(admin, "customerIdentities", identityId)));
  });

  it("denies write from any client", async () => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    await assertFails(
      setDoc(doc(staff, "platformCustomers", `x-${randomUUID()}`), { createdAt: new Date() }),
    );
  });
});

describe("firestore.rules — auditLogs: server-only, no client read/write, ever", () => {
  it("denies read to same-merchant staff and superAdmin alike", async () => {
    const { auditLogId, merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, "auditLogs", auditLogId)));
    await assertFails(getDoc(doc(admin, "auditLogs", auditLogId)));
  });

  it("denies create/update/delete from any client, including superAdmin", async () => {
    const { auditLogId, merchantId } = await seedMerchant();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(admin, "auditLogs", `x-${randomUUID()}`), { merchantId }));
    await assertFails(updateDoc(doc(admin, "auditLogs", auditLogId), { action: "tampered" }));
    await assertFails(deleteDoc(doc(admin, "auditLogs", auditLogId)));
  });
});

describe("firestore.rules — merchants / branches: same-merchant-staff read, no client write", () => {
  it("allows a merchant's own active staff to read; denies a different merchant's staff", async () => {
    const merchantA = await seedMerchant();
    const merchantB = await seedMerchant();
    const staffA = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantA.merchantId, merchantA.staffUserId))
      .firestore();
    const staffB = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantB.merchantId, merchantB.staffUserId))
      .firestore();

    await assertSucceeds(getDoc(doc(staffA, "merchants", merchantA.merchantId)));
    await assertFails(getDoc(doc(staffB, "merchants", merchantA.merchantId)));
    await assertSucceeds(getDoc(doc(staffA, "merchants", merchantA.merchantId, "branches", "branch-1")));
    await assertFails(getDoc(doc(staffB, "merchants", merchantA.merchantId, "branches", "branch-1")));
  });

  it("denies all client writes, even from the merchant's own staff", async () => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    await assertFails(updateDoc(doc(staff, "merchants", merchantId), { name: "Hacked" }));
  });

  it("denies an unauthenticated (anonymous) client entirely", async () => {
    const { merchantId } = await seedMerchant();
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "merchants", merchantId)));
  });
});

describe("firestore.rules — staffUsers: readable by same merchant's staff, no client write", () => {
  it("denies read for staff of a different merchant", async () => {
    const merchantA = await seedMerchant();
    const merchantB = await seedMerchant();
    const staffB = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantB.merchantId, merchantB.staffUserId))
      .firestore();
    await assertFails(getDoc(doc(staffB, "staffUsers", merchantA.staffUserId)));
  });

  it("denies a client attempting to self-escalate role by writing its own staffUsers doc", async () => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    await assertFails(updateDoc(doc(staff, "staffUsers", staffUserId), { role: "OWNER" }));
    await assertFails(
      setDoc(doc(staff, "staffUsers", `forged-${randomUUID()}`), {
        merchantId,
        authUid: "someone",
        role: "OWNER",
        status: "ACTIVE",
      }),
    );
  });
});

describe("firestore.rules — memberships: readable by same merchant's staff, no client write", () => {
  it("denies read for staff of a different merchant (forged/guessed membershipId)", async () => {
    const merchantA = await seedMerchant();
    const merchantB = await seedMerchant();
    const staffB = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantB.merchantId, merchantB.staffUserId))
      .firestore();
    await assertFails(getDoc(doc(staffB, "memberships", merchantA.membershipId)));
  });

  it("denies a client attempting to self-credit points by writing pointsBalance directly", async () => {
    const { merchantId, staffUserId, membershipId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    await assertFails(updateDoc(doc(staff, "memberships", membershipId), { pointsBalance: 999999 }));
  });
});

describe("firestore.rules — subscriptions: same-merchant-staff read, no client write", () => {
  it("denies read for a different merchant's staff and denies all client writes", async () => {
    const merchantA = await seedMerchant();
    const merchantB = await seedMerchant();
    const staffA = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantA.merchantId, merchantA.staffUserId))
      .firestore();
    const staffB = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantB.merchantId, merchantB.staffUserId))
      .firestore();

    await assertSucceeds(getDoc(doc(staffA, "subscriptions", merchantA.merchantId)));
    await assertFails(getDoc(doc(staffB, "subscriptions", merchantA.merchantId)));
    await assertFails(updateDoc(doc(staffA, "subscriptions", merchantA.merchantId), { status: "ACTIVE" }));
  });
});

describe("firestore.rules — packages: readable by any signed-in user, no client write", () => {
  it("allows read for any authenticated user, denies anonymous and denies writes", async () => {
    const { packageId, merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const anon = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(staff, "packages", packageId)));
    await assertFails(getDoc(doc(anon, "packages", packageId)));
    await assertFails(setDoc(doc(staff, "packages", `x-${randomUUID()}`), { name: "Hacked" }));
  });
});

describe("firestore.rules — undeclared collections default-deny", () => {
  it("denies access to a collection not defined in firestore.rules at all", async () => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    // `pointsLedger` is EXPLICITLY declared (deny-all) below — genuinely undeclared collection
    // name needed here so this test still verifies Firestore's own "no matching rule = no access"
    // default, not the explicit block.
    await assertFails(getDoc(doc(staff, "notAPhase3CollectionEither", "does-not-exist")));
  });
});

describe("firestore.rules — Phase 3 points collections: 100% deny-all client read/write (§12, §26)", () => {
  // pointRules/pointsLedger/pointsLots/pointsLotConsumptions/idempotencyKeys/visits/events: every
  // read and every write goes through the protected API routes (Admin SDK) — the Staff Portal
  // never reads these directly via the client Firestore SDK (see firestore.rules comment).
  const PHASE_3_COLLECTIONS = [
    "pointRules",
    "pointsLedger",
    "pointsLots",
    "pointsLotConsumptions",
    "idempotencyKeys",
    "visits",
    "events",
  ] as const;

  it.each(PHASE_3_COLLECTIONS)("%s denies read to same-merchant staff and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_3_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 4 reward collections: 100% deny-all client read/write (§13, §26)", () => {
  // rewardTemplates/voucherInstances: Redeem/Use are transactional operations (FIFO points spend,
  // stock decrement, status transition) that must go through the protected API routes — same
  // "server is the only path" reasoning as every Phase 3 collection above.
  const PHASE_4_COLLECTIONS = ["rewardTemplates", "voucherInstances"] as const;

  it.each(PHASE_4_COLLECTIONS)("%s denies read to same-merchant staff and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_4_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 5 coupon collections: 100% deny-all client read/write (§14, §26)", () => {
  // couponTemplates/couponInstances: Issue/Redeem are transactional operations (Total/Per-Member
  // Limit enforcement, status transition, code lookup) that must go through the protected API
  // routes — same "server is the only path" reasoning as every Phase 3/4 collection above.
  const PHASE_5_COLLECTIONS = ["couponTemplates", "couponInstances"] as const;

  it.each(PHASE_5_COLLECTIONS)("%s denies read to same-merchant staff and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_5_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 6 automation collections: 100% deny-all client read/write (§16, §17, §26)", () => {
  const PHASE_6_COLLECTIONS = ["automations", "automationActionExecutions"] as const;

  it.each(PHASE_6_COLLECTIONS)("%s denies read to same-merchant staff and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_6_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 7 LINE/notification collections: 100% deny-all client read/write (§19, §23, §26)", () => {
  // lineChannelConfigs holds Secret Manager references — deny-all is especially critical here.
  const PHASE_7_COLLECTIONS = ["lineChannelConfigs", "notificationSettings", "notificationLog"] as const;

  it.each(PHASE_7_COLLECTIONS)("%s denies read to same-merchant staff (even Owner) and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_7_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 8 report collections: 100% deny-all client read/write (§24, §26)", () => {
  const PHASE_8_COLLECTIONS = ["merchantDailyStats", "reports"] as const;

  it.each(PHASE_8_COLLECTIONS)("%s denies read to same-merchant staff (even Owner) and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_8_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 9 supportSessions/emergencyControls: 100% deny-all, even superAdmin (§37.1, §37.2, §26)", () => {
  const PHASE_9_DENY_ALL_COLLECTIONS = ["supportSessions", "emergencyControls"] as const;

  it.each(PHASE_9_DENY_ALL_COLLECTIONS)("%s denies read to same-merchant staff (even Owner) and superAdmin alike", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const docId = `x-${randomUUID()}`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), name, docId), { merchantId });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, name, docId)));
    await assertFails(getDoc(doc(admin, name, docId)));
  });

  it.each(PHASE_9_DENY_ALL_COLLECTIONS)("%s denies create/update/delete from any client, including superAdmin", async (name) => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(staff, name, `x-${randomUUID()}`), { merchantId }));
    await assertFails(setDoc(doc(admin, name, `x-${randomUUID()}`), { merchantId }));
  });
});

describe("firestore.rules — Phase 9 systemHealth: Super-Admin-only read, no client write ever (§32, §37)", () => {
  it("denies read to same-merchant staff (even Owner), allows read to superAdmin", async () => {
    const { merchantId, staffUserId } = await seedMerchant();
    const componentId = "Database";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "systemHealth", componentId), { component: componentId, status: "OK" });
    });
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(getDoc(doc(staff, "systemHealth", componentId)));
    await assertSucceeds(getDoc(doc(admin, "systemHealth", componentId)));
  });

  it("denies write from any client, including superAdmin", async () => {
    const admin = testEnv.authenticatedContext(`u-${randomUUID()}`, { superAdmin: true }).firestore();
    await assertFails(setDoc(doc(admin, "systemHealth", `x-${randomUUID()}`), { status: "OK" }));
  });
});

describe("firestore.rules — a SUSPENDED staff claim is not enough for access (structural sanity)", () => {
  it("a client with no role claim at all is denied merchant read (fails closed)", async () => {
    const { merchantId } = await seedMerchant();
    // No custom claims at all — e.g. a signed-in user whose staffUsers doc was deleted/suspended
    // and whose claims were cleared by syncStaffCustomClaims (see staff-claims.test.ts).
    const noClaims = testEnv.authenticatedContext(`u-${randomUUID()}`, {}).firestore();
    await assertFails(getDoc(doc(noClaims, "merchants", merchantId)));
  });

  it("an invalid role string is denied (not one of OWNER/MANAGER/STAFF)", async () => {
    const { merchantId } = await seedMerchant();
    const bogus = testEnv
      .authenticatedContext(`u-${randomUUID()}`, { merchantId, role: "SUPERUSER", staffUserId: "x" })
      .firestore();
    await assertFails(getDoc(doc(bogus, "merchants", merchantId)));
  });
});

// Sanity check that the fixtures themselves are shaped as expected (guards against a seeding bug
// silently making every other "assertFails" test above pass for the wrong reason).
describe("test fixture sanity", () => {
  it("seedMerchant() produces a merchant document readable by its own owner", async () => {
    const { merchantId, staffUserId } = await seedMerchant();
    const staff = testEnv
      .authenticatedContext(`u-${randomUUID()}`, ownerClaims(merchantId, staffUserId))
      .firestore();
    const snap = await assertSucceeds(getDoc(doc(staff, "merchants", merchantId)));
    expect(snap.exists()).toBe(true);
  });
});
