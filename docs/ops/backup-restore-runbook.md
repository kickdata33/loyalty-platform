# Firestore Backup / Restore Runbook

Source of truth: `FINAL-ARCHITECTURE.md` §29 (Backup Strategy) and §38.3 (Phase 10 Blocker 3,
Locked — Option A).

**Scope note (§38.3, locked):** this document and `scripts/verify-restore.mjs` are the complete
Phase 10 *code-completable* deliverable for this exit criterion. Actually provisioning the export
below and running a live restore drill against a real GCP project is an **out-of-session
infrastructure/operations action** — §29's exit criterion ("Restore runbook ต้องเขียนและทดสอบจริง
อย่างน้อย 1 ครั้ง") is only fully satisfied once that action is performed and confirmed outside
this coding session. Being code-complete does not, by itself, satisfy it.

## 1. Scheduled export

Firestore's native "Export and Import" (via `gcloud`) is the mechanism — no third-party tooling.

```bash
# One-time: create the destination bucket in the SAME region as the Firestore database.
gsutil mb -l <FIRESTORE_REGION> -p <PROJECT_ID> gs://<PROJECT_ID>-firestore-backups

# Daily export — ALL collections (retention >= 30 days, §29).
gcloud firestore export gs://<PROJECT_ID>-firestore-backups/daily/$(date +%Y-%m-%d) \
  --project=<PROJECT_ID>

# Higher-frequency export for financial/loyalty-critical collections (§29 explicitly names
# these as needing more than daily frequency — propose every 6 hours):
gcloud firestore export gs://<PROJECT_ID>-firestore-backups/critical/$(date +%Y-%m-%dT%H) \
  --project=<PROJECT_ID> \
  --collection-ids=pointsLedger,pointsLots,voucherInstances,couponInstances,auditLogs
```

Automate both via Cloud Scheduler → a Cloud Function (or `gcloud scheduler jobs create` invoking
a Cloud Run job) — see `docs/ops/monitoring-alerting-policy.md` for the paired alerting policy
that should watch for a failed/missed export.

**Retention:** apply a lifecycle rule on the bucket deleting objects older than 30 days (§29's
stated minimum):

```bash
gsutil lifecycle set - gs://<PROJECT_ID>-firestore-backups <<'JSON'
{ "rule": [{ "action": {"type": "Delete"}, "condition": {"age": 30} }] }
JSON
```

## 2. Restore drill

Restore into a **separate, throwaway GCP project** — never restore over the live project.

```bash
# 1. Create/select a scratch project with Firestore enabled (same region).
gcloud config set project <SCRATCH_PROJECT_ID>

# 2. Import the most recent daily export.
gcloud firestore import gs://<PROJECT_ID>-firestore-backups/daily/<DATE> \
  --project=<SCRATCH_PROJECT_ID>

# 3. Run the verification script against the scratch project (see scripts/verify-restore.mjs).
FIRESTORE_PROJECT_ID=<SCRATCH_PROJECT_ID> node scripts/verify-restore.mjs
```

## 3. Verification checklist (also automated by `scripts/verify-restore.mjs`)

- [ ] Import completes without error.
- [ ] Spot-check document counts per collection are within expected range of the pre-export
      snapshot (the script checks `memberships`, `pointsLedger`, `staffUsers`, `merchants`).
- [ ] Balance Reconciliation (§12, §38.4) re-run against the restored data reports **zero new**
      mismatches beyond what was already known before the export (the script re-runs
      `findBalanceMismatchesForMerchant` for a sample of merchants).
- [ ] `auditLogs` for the export window are present and unmodified (append-only invariant, §18).
- [ ] Record the drill's outcome (date, operator, scratch project id, result) in this file's
      history section below.

## 4. Drill history

| Date | Operator | Scratch project | Result |
|---|---|---|---|
| _(none yet — see §38.3 scope note above)_ | | | |
