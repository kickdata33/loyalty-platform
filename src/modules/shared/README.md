# modules/shared/

Cross-module code described in `FINAL-ARCHITECTURE.md` §31 (`/modules/shared`):

- `types.ts` — `Role`, `AuthContext`, and other cross-module shared types
- `errors.ts` — the error taxonomy every module throws (`AuthenticationError`,
  `AuthorizationError`, `TenantIsolationError`, `ValidationError`, `NotFoundError`,
  `ConflictError`)
- `firestore.ts` — the Firestore client wrapper (`getDb()`) and canonical collection names
- `auth-context.ts` — builds a verified `AuthContext` from a decoded Firebase ID token
- `ids.ts` — non-sequential id generation helper (§3)

Phase 2+ modules (`points`, `reward`, `coupon`, `promotion-automation`, `notification`, `report`,
`event`) are not implemented yet — this directory only contains what Phase 1
(`identity`, `membership`, `merchant`, `staff`, `rbac`, `billing-entitlement`, `audit`) needs.

Reminder (`FINAL-ARCHITECTURE.md` §2, §31): modules are pure business logic importable from both Next.js
API Routes and Cloud Functions — never duplicate logic between the two runtimes, and never let a React
component write Firestore directly for anything that changes business state.
