# modules/shared/

Cross-module types, the Firestore client wrapper, permission-guard helpers, and auth-context builder
described in `FINAL-ARCHITECTURE.md` §31 (`/modules/shared`).

Bootstrap stage: empty boundary. Business-logic modules (`identity`, `membership`, `merchant`, `branch`,
`staff`, `rbac`, `points`, `reward`, `coupon`, `promotion-automation`, `notification`, `report`,
`billing-entitlement`, `audit`, `event`) are created starting in Phase 1, not during bootstrap.

Reminder (`FINAL-ARCHITECTURE.md` §2, §31): modules are pure business logic importable from both Next.js
API Routes and Cloud Functions — never duplicate logic between the two runtimes, and never let a React
component write Firestore directly for anything that changes business state.
