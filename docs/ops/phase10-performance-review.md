# Phase 10 — Static Performance Review

Per §38's locked scoping: this is a **static/code-level review only** — no live production
traffic exists yet to load-test against (per §33's own rollout plan, real merchant scale grows
only after Phase 10). Feeds the §35 item 4 (`subscriptionStatusCache`) decision, which was
explicitly deferred to "พิจารณาใหม่ที่ Phase 10."

## Method

1. Every composite-index-requiring query added since Phase 1 checked against
   `firestore.indexes.json` for coverage.
2. Every loop that issues a Firestore read/write per iteration reviewed for its scaling shape at
   the platform's own stated near-term target (~50 merchants, §33).

## Findings

### Index coverage — no gaps found

Every `.where()` combination with an `orderBy`/range filter across `src/modules/*` and
`functions/src/index.ts` has a matching entry in `firestore.indexes.json` (verified by
cross-reference during Phase 9 and Phase 10 additions — the Phase 10 `broadcasts` rate-limit
query was the one new case, and its `(merchantId, sentAt desc)` index was added alongside it).
Pure multi-equality queries (no range/orderBy) — e.g. the Phase 9 staff-count entitlement check,
the Phase 10 reconciliation lot query — correctly need no composite index (Firestore serves
equality-only queries from automatic single-field indexes).

### N+1-shaped loops (existing, pre-Phase-10, documented not modified)

- `sendBroadcast()` (Phase 7): one sequential `adapter.send()` + one `writeNotificationLog()`
  write per matching member. At a Business-tier merchant (10,000+ members, §25) this is thousands
  of sequential round trips per broadcast. **Recommendation: not a Phase 10 fix** — changing this
  shape (e.g. batched/parallel sends) is a Phase 7 behavior change outside this phase's approved
  scope (CLAUDE.md: "ห้ามเปลี่ยน Core Business Rules เอง... ต้องหยุดและเสนอทางเลือกก่อน implement");
  flagged here for a future phase's explicit approval if/when it becomes a real bottleneck.
- `dailyAutomationBatch()` (Phase 6/8): one pass per merchant per membership, several reads per
  membership. Same "pre-existing, not modified in Phase 10" note as above.

### New Phase 10 loop: `balanceReconciliationJob`

Per merchant, per membership, one `pointsLots` query — at ~50 merchants × up to ~500 members
(Starter tier default, §25) this is on the order of 10,000–25,000 sequential Firestore reads per
nightly run. Acceptable at current/near-term scale for a nightly (not user-facing-latency) job;
Cloud Functions v2 scheduled functions support execution timeouts well beyond what this requires
at this scale. **Flagged, not changed**: if merchant count grows substantially beyond the ~50
target (§33's stated Phase 10 milestone), this loop should be revisited (e.g. sharded across
multiple scheduled invocations) — not a Phase 10 action item, a documented future consideration.

## Conclusion: `subscriptionStatusCache` (§35 item 4)

**Recommendation: do not introduce it.** `resolveEntitlement()`/`resolveEntitlementTx()` cost 2
document reads (subscription + package), invoked only at "create new" checkpoints
(`createMembership`/`createStaffUser`/`createBranch`, §37.3) — not on every page load or
high-frequency path. There is no static or load-test evidence at this platform's current scale
that this is a bottleneck. Introducing a cache without that evidence would violate both §0's
"หลีกเลี่ยง premature infrastructure complexity" and §25's own explicit default ("ไม่สร้าง field นี้
จนกว่าจะมีหลักฐานจาก performance review ว่าจำเป็นจริง"). This review found no such evidence — the
decision to not build it is itself this review's concrete, actionable output. Revisit only if a
future phase has real production metrics showing entitlement reads as a measurable cost.
