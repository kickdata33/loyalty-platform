import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { onDocumentWritten } from "firebase-functions/v2/firestore";

import type { StaffUserClaimsSnapshot } from "../../src/modules/rbac/staff-claims";
import { syncStaffCustomClaims } from "../../src/modules/rbac/staff-claims";

// Ambient service identity in the Cloud Functions runtime (and the emulator) — no config needed,
// never a hard-coded credential (FINAL-ARCHITECTURE.md §1, §26).
initializeApp();

/**
 * The ONE mechanism that sets Firebase Auth custom claims for staff/owner users
 * (FINAL-ARCHITECTURE.md §8, §10, §32). Reacts to every write of `staffUsers/{staffUserId}` —
 * create, update, or delete — regardless of which server code path performed it, and delegates
 * the actual claims logic to the framework-agnostic `syncStaffCustomClaims` module shared with
 * this repo's Next.js app and its tests (§31), so there is exactly one implementation of "how do
 * StaffUser fields map to custom claims" in the entire codebase.
 */
export const onStaffUserWrite = onDocumentWritten(
  "staffUsers/{staffUserId}",
  async (event) => {
    const { staffUserId } = event.params;
    const before = (event.data?.before.exists
      ? (event.data.before.data() as StaffUserClaimsSnapshot)
      : null) as StaffUserClaimsSnapshot | null;
    const after = (event.data?.after.exists
      ? (event.data.after.data() as StaffUserClaimsSnapshot)
      : null) as StaffUserClaimsSnapshot | null;

    await syncStaffCustomClaims(getAuth(), { staffUserId, before, after });
  },
);
