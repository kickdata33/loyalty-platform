# functions/

Reserved for Firebase Cloud Functions (triggers, scheduled jobs, webhooks) per `FINAL-ARCHITECTURE.md`
§31–§32 — e.g. `onStaffUserWrite` (custom claims), `onEventCreate` (Automation Engine), scheduled jobs
(`dailyReportGenerator`, `pointsExpiration`, `couponExpiration`, ...), and the LINE webhook receiver.

Bootstrap stage: intentionally empty. No Cloud Functions runtime/package.json is initialized yet and the
Firebase emulator config does not wire up a `functions` emulator, so `npm run emulators` only starts
Auth + Firestore. Functions code and the emulator wiring are added when a Phase actually needs them
(business logic must import from `/src/modules/*` — see that folder's README — never duplicate it here).
