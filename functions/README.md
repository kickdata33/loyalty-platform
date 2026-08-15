# functions/

Firebase Cloud Functions per `FINAL-ARCHITECTURE.md` §31–§32.

**Phase 1**: `onStaffUserWrite` (`src/index.ts`) — the ONE mechanism that sets/revokes Firebase Auth
custom claims for staff/owner users, reacting to every write of `staffUsers/{staffUserId}`. It
delegates the actual claims logic to the framework-agnostic `syncStaffCustomClaims` function in
`../src/modules/rbac/staff-claims.ts` (shared with the Next.js app and its tests — see that
module's doc comment), so there is exactly one implementation of "how do StaffUser fields map to
custom claims" in the whole codebase.

**Later phases** add here: `onEventCreate` (Automation Engine), scheduled jobs
(`dailyReportGenerator`, `pointsExpiration`, `couponExpiration`, ...), and the LINE webhook
receiver. Business logic must import from `/src/modules/*` — never duplicate it here.

## This is a separate TypeScript project

`functions/` has its own `package.json`/`tsconfig.json`/`node_modules` (Firebase Cloud Functions
convention) — it is not part of the root Next.js app's build or lint config
(`eslint.config.mjs` excludes `functions/**`).

```bash
cd functions
npm install       # first time only
npm run build      # tsc → lib/ (gitignored)
npm run typecheck
```

`npm run emulators:functions` (from the repo root) builds this package and starts all three
emulators (Auth + Firestore + Functions) together — the default `npm run emulators` only starts
Auth + Firestore for lighter everyday use, and the automated test suite
(`npm run test:emulator`) intentionally does not include the Functions emulator; see
`syncStaffCustomClaims` usage in `tests/emulator/staff-claims.test.ts` and the Known Limitations
in the Phase 1 report for why.
