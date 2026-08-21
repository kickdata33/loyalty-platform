import { type App, applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";

/**
 * Firebase Admin SDK bootstrap — server-side only (never import from a Client Component).
 *
 * Bootstrap stage only — no Auth/Firestore admin service instances are exported here yet.
 * Add `getAuth()`/`getFirestore()` wrappers here once a Phase actually needs them, so every
 * server code path (Next.js API Routes and Cloud Functions alike — see `/modules/shared`) shares
 * the same singleton app instance.
 *
 * Credential resolution (never hard-code a service account or private key here):
 * 1. Emulator: `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` set → no real credentials
 *    needed, `initializeApp({ projectId })` is enough (`npm run emulators`, see .env.example).
 * 2. Local dev / Codespaces against the real dev project: Application Default Credentials, via
 *    either `gcloud auth application-default login` or a locally-stored, gitignored service
 *    account key referenced by `GOOGLE_APPLICATION_CREDENTIALS` — that file must never be
 *    committed (see .gitignore).
 * 3. Firebase App Hosting / Cloud Functions runtime (future): `applicationDefault()` picks up the
 *    ambient service identity automatically — no configuration needed.
 */

let cachedApp: App | undefined;

function isEmulatorEnv(): boolean {
  return Boolean(
    process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST,
  );
}

/**
 * Returns the singleton Firebase Admin app, initializing it lazily on first use.
 *
 * Intentionally lazy (not initialized at module load) so importing this file never breaks the
 * build or tests when no credentials are configured yet — the error only surfaces when a caller
 * actually needs Firebase Admin.
 */
export function getFirebaseAdminApp(): App {
  if (cachedApp) return cachedApp;

  if (getApps().length > 0) {
    cachedApp = getApp();
    return cachedApp;
  }

  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  cachedApp = isEmulatorEnv()
    ? initializeApp({ projectId })
    : initializeApp({ credential: applicationDefault(), projectId });

  return cachedApp;
}

let cachedAuth: Auth | undefined;

/** Returns the singleton Firebase Admin Auth service (custom claims, ID token verification). */
export function getAdminAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseAdminApp());
  return cachedAuth;
}
