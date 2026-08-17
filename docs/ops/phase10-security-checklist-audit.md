# Phase 10 — §26 Security Threat Checklist Audit

Maps every bullet in `FINAL-ARCHITECTURE.md` §26's Security Threat Checklist to the automated
test file(s) that cover it, per Phase 10's exit criterion ("Security review เต็มรูปแบบ (checklist
หัวข้อ 26)"). This is a coverage-confirmation artifact, not new test code — it references the
existing suite (built incrementally across Phase 1–9) plus the three new Phase 10 tests.

| §26 checklist item | Status | Covered by |
|---|---|---|
| Cross-tenant read/write via guessed/forged id | ✅ Covered | `tests/emulator/tenant-isolation.test.ts`, `tests/emulator/merchant-rbac.test.ts`, `tests/security-rules/firestore-rules.test.ts` (every merchant-scoped collection) |
| Client forges `merchantId` in request payload | ✅ Structurally impossible | No service function accepts a `merchantId` parameter that overrides `ctx.merchantId` (§3, §10) — enforced by code shape, not runtime validation; `tests/emulator/tenant-isolation.test.ts` documents this explicitly |
| Client forges LINE userId to impersonate a Membership | ✅ Covered | `tests/unit/line-id-token-verification.test.ts`, `tests/emulator/line-webhook.test.ts`, `tests/unit/line-client-boundary.test.ts` |
| Privilege escalation via forged custom claims | ✅ Covered | `tests/emulator/staff-claims.test.ts`, `tests/security-rules/firestore-rules.test.ts` ("invalid role string denied") |
| LINE secret/token leak via client-readable doc | ✅ Covered | `tests/security-rules/firestore-rules.test.ts` (`lineChannelConfigs` deny-all) |
| Webhook spoofing (no signature check) | ✅ Covered | `tests/emulator/line-webhook.test.ts` |
| Double-submit on Add Points/Redeem | ✅ Covered | `tests/emulator/points-ledger.test.ts`, `tests/emulator/reward-redeem-use.test.ts`, `tests/emulator/coupon-issue-redeem.test.ts`, `tests/emulator/race-conditions.test.ts` |
| Race condition: concurrent redeem of same coupon/reward | ✅ Covered | `tests/emulator/race-conditions.test.ts` |
| Staff exceeding limit via parallel requests | ✅ Covered | `tests/emulator/race-conditions.test.ts` (`maxPointsPerHour` concurrent test) |
| Automation runaway / safety limit not enforced in execution path | ✅ Covered | `tests/emulator/automation-execution.test.ts`, `tests/emulator/race-conditions.test.ts` |
| **Broadcast spam / message flooding (rate limit per merchant)** | ✅ **Newly closed, Phase 10** | `tests/emulator/broadcast-rate-limit.test.ts` (§38.1) — previously an open gap, confirmed unimplemented at Phase 10 kickoff |
| Super Admin support mode not audited | ✅ Covered | `tests/emulator/support-session.test.ts` (Phase 9) |
| Input validation on public-facing forms | ✅ Covered | `tests/emulator/api-onboarding.test.ts`, `tests/emulator/line-webhook.test.ts`, per-module `ValidationError` checks throughout |
| Sensitive data in error message/log Support sees | ✅ Reviewed, no gap found | Grep audit (Phase 10) confirmed no email/phone/authUid interpolated into any client-facing error message anywhere in `src/modules`/`src/app/api` |
| Unverified phone/email used as cross-merchant merge key | N/A — not yet built | `resolveOrCreatePlatformCustomer` only ever called with `provider: 'line'` in this codebase (§35 item 1, Phone OTP Provider, remains an open decision for a future phase that actually builds phone/email verification) — not a Phase 10 gap, correctly still deferred |

**New in Phase 10 (not a §26 bullet, but the same hardening spirit):** `tests/emulator/critical-alert.test.ts`
and `tests/emulator/balance-reconciliation.test.ts` cover the new §38.2/§38.4 mechanisms.
