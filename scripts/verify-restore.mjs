#!/usr/bin/env node
/**
 * Backup Restore Verification (FINAL-ARCHITECTURE.md §29, §38.3 — Phase 10 Blocker 3, Locked).
 *
 * Run AFTER importing a Firestore export into a scratch project (see
 * docs/ops/backup-restore-runbook.md §2) — never against the live production project.
 *
 *   FIRESTORE_PROJECT_ID=<scratch-project-id> node scripts/verify-restore.mjs
 *
 * Plain Node.js + `firebase-admin` (already a project dependency — no new dependency added for
 * this script). This deliberately does NOT import from `src/modules/*` — this script runs
 * standalone outside the Next.js/TypeScript build, so the small reconciliation check below is a
 * narrow, self-contained reimplementation of the read-only logic in
 * `src/modules/reconciliation/service.ts`, not a second copy of application business logic that
 * the app itself also depends on (the app never imports this file, and this file never runs as
 * part of the app).
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIRESTORE_PROJECT_ID;
if (!projectId) {
  console.error("FIRESTORE_PROJECT_ID env var is required — point this at a SCRATCH project, never production.");
  process.exit(1);
}

const app = process.env.FIRESTORE_EMULATOR_HOST
  ? initializeApp({ projectId })
  : initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore(app);

const SAMPLE_MERCHANT_LIMIT = 5;

async function countCollection(name) {
  const snap = await db.collection(name).count().get();
  return snap.data().count;
}

async function findBalanceMismatchesForMerchant(merchantId) {
  const membershipsSnap = await db.collection("memberships").where("merchantId", "==", merchantId).get();
  const mismatches = [];
  for (const membershipDoc of membershipsSnap.docs) {
    const cachedBalance = membershipDoc.data().pointsBalance;
    const lotsSnap = await db
      .collection("pointsLots")
      .where("merchantId", "==", merchantId)
      .where("membershipId", "==", membershipDoc.id)
      .where("status", "==", "ACTIVE")
      .get();
    const computedBalance = lotsSnap.docs.reduce((sum, d) => sum + (d.data().remainingAmount ?? 0), 0);
    if (computedBalance !== cachedBalance) {
      mismatches.push({ membershipId: membershipDoc.id, cachedBalance, computedBalance });
    }
  }
  return mismatches;
}

async function main() {
  console.log(`Verifying restored project: ${projectId}\n`);

  console.log("--- Collection counts (sanity check — compare against pre-export expectations) ---");
  for (const name of ["merchants", "staffUsers", "memberships", "pointsLedger", "auditLogs"]) {
    console.log(`  ${name}: ${await countCollection(name)}`);
  }

  console.log(`\n--- Balance Reconciliation re-check (sample of up to ${SAMPLE_MERCHANT_LIMIT} merchants) ---`);
  const merchantsSnap = await db.collection("merchants").limit(SAMPLE_MERCHANT_LIMIT).get();
  let totalMismatches = 0;
  for (const merchantDoc of merchantsSnap.docs) {
    const mismatches = await findBalanceMismatchesForMerchant(merchantDoc.id);
    totalMismatches += mismatches.length;
    console.log(`  ${merchantDoc.id}: ${mismatches.length} mismatch(es)`);
  }

  console.log("\n--- Result ---");
  if (totalMismatches > 0) {
    console.log(`FAIL: ${totalMismatches} balance mismatch(es) found in the restored data.`);
    process.exit(1);
  }
  console.log("OK: no new balance mismatches found in the sampled merchants.");
}

main().catch((err) => {
  console.error("Verification script failed:", err);
  process.exit(1);
});
