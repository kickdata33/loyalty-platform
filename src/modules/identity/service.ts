import { createHash } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";

import type { IdentityProvider } from "@/modules/identity/types";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

/**
 * Global Customer Identity foundation (FINAL-ARCHITECTURE.md §6).
 *
 * LINE userId (or any other provider's subject) is NEVER used directly as the platform-wide
 * identity key — see §6. This module is the only place `platformCustomers`/`customerIdentities`
 * are created or resolved.
 */

function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase();
}

/** `identityId = deterministicHash(provider, providerScope, normalizedSubject)` — §6. */
export function computeIdentityId(
  provider: IdentityProvider,
  providerScope: string | null,
  subject: string,
): string {
  return createHash("sha256")
    .update(`${provider}:${providerScope ?? ""}:${normalizeSubject(subject)}`)
    .digest("hex");
}

function hashSubject(subject: string): string {
  return createHash("sha256").update(normalizeSubject(subject)).digest("hex");
}

/**
 * Creates a bare PlatformCustomer with no external identity index entry — used only for the
 * staff-input path (`memberships.merchantProfile.profileSource = 'STAFF_INPUT'`, §7) where a
 * member is created at the counter without any LINE/phone/email identity to verify or index.
 * Every merchant a customer joins this way independently gets its own PlatformCustomer, by
 * design (§6: "โดย default... ได้ PlatformCustomer แยกกัน (ปลอดภัยที่สุด ไม่ auto-merge)").
 */
export async function createPlatformCustomer(): Promise<string> {
  const ref = getDb().collection(COLLECTIONS.platformCustomers).doc();
  await ref.set({ createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}

/**
 * Resolves the PlatformCustomer for a verified external identity, creating both the
 * PlatformCustomer and the `customerIdentities` index entry atomically on first sight.
 *
 * `subject` MUST already be backend-verified for the given provider (§6, §21) — e.g. the `sub`
 * claim from a LINE ID Token verified against LINE's servers, or a phone number confirmed via
 * OTP. This function never accepts a raw, unverified client-supplied value; `verified` must be
 * `true` or it throws.
 *
 * Race-safe by construction: concurrent calls with the same identity race to `tx.create()` the
 * same deterministic `identityId` document. Firestore aborts and retries the loser; on retry it
 * observes the winner's document and returns the same `platformCustomerId` — no duplicate
 * PlatformCustomer can be created from a double-submit (§6).
 */
export async function resolveOrCreatePlatformCustomer(params: {
  provider: IdentityProvider;
  providerScope: string | null;
  subject: string;
  verified: boolean;
}): Promise<string> {
  const { provider, providerScope, subject, verified } = params;

  if (!verified) {
    throw new ValidationError(
      `resolveOrCreatePlatformCustomer requires a backend-verified subject for provider '${provider}'.`,
    );
  }
  if (provider === "line" && (!providerScope || providerScope.length === 0)) {
    throw new ValidationError("providerScope (lineProviderId) is required for provider 'line'.");
  }
  if (subject.trim().length === 0) {
    throw new ValidationError("subject must not be empty.");
  }

  const db = getDb();
  const identityId = computeIdentityId(provider, providerScope, subject);
  const identityRef = db.collection(COLLECTIONS.customerIdentities).doc(identityId);

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(identityRef);
    if (existing.exists) {
      return existing.data()!.platformCustomerId as string;
    }

    const customerRef = db.collection(COLLECTIONS.platformCustomers).doc();
    tx.create(customerRef, { createdAt: FieldValue.serverTimestamp() });
    tx.create(identityRef, {
      provider,
      providerScope: providerScope ?? null,
      providerSubjectHash: hashSubject(subject),
      platformCustomerId: customerRef.id,
      verifiedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
    return customerRef.id;
  });
}
