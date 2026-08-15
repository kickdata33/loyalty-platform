import {
  type FirebaseApp,
  type FirebaseOptions,
  getApp,
  getApps,
  initializeApp,
} from "firebase/app";
import { type Auth, connectAuthEmulator, getAuth } from "firebase/auth";

/**
 * Firebase Web SDK client bootstrap.
 *
 * All config comes from `NEXT_PUBLIC_*` env vars (see `.env.example`) — never hard-code Firebase
 * config values in source (FINAL-ARCHITECTURE.md §1, §26).
 */

// The subset of FirebaseOptions this app requires — databaseURL/measurementId are optional
// fields on FirebaseOptions that we don't use, so they're intentionally excluded here.
type RequiredConfigKey =
  | "apiKey"
  | "authDomain"
  | "projectId"
  | "storageBucket"
  | "messagingSenderId"
  | "appId";

const ENV_VAR_BY_CONFIG_KEY = {
  apiKey: "NEXT_PUBLIC_FIREBASE_API_KEY",
  authDomain: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  projectId: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  storageBucket: "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  appId: "NEXT_PUBLIC_FIREBASE_APP_ID",
} as const satisfies Record<RequiredConfigKey, string>;

function readConfig(): FirebaseOptions {
  const config: Record<RequiredConfigKey, string | undefined> = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

  const missingKeys = (Object.keys(config) as RequiredConfigKey[]).filter(
    (key) => !config[key],
  );

  if (missingKeys.length > 0) {
    const missingEnvVars = missingKeys.map((key) => ENV_VAR_BY_CONFIG_KEY[key]);
    throw new Error(
      `[firebase/client] Missing required env var(s): ${missingEnvVars.join(", ")}. ` +
        "Copy .env.example to .env.local and fill in the Firebase Web App config.",
    );
  }

  return config as FirebaseOptions;
}

let cachedApp: FirebaseApp | undefined;

/**
 * Returns the singleton Firebase client app, initializing it lazily on first use.
 *
 * Intentionally lazy (not initialized at module load) so importing this file never breaks
 * `next build`/`next dev`/tests when env vars aren't set yet — the error only surfaces when a
 * caller actually needs Firebase.
 */
export function getFirebaseApp(): FirebaseApp {
  if (cachedApp) return cachedApp;
  cachedApp = getApps().length > 0 ? getApp() : initializeApp(readConfig());
  return cachedApp;
}

let cachedAuth: Auth | undefined;
let emulatorConnected = false;

/**
 * Returns the singleton Firebase Auth client instance. Firebase Auth SDK owns all token
 * persistence/lifecycle from here on (§8 Phase 2 Architecture Decision) — this codebase never
 * reads/writes the ID token itself; callers always go through `user.getIdToken()` (see
 * `src/lib/api/client.ts`).
 */
export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseApp());

  if (!emulatorConnected && process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST) {
    connectAuthEmulator(cachedAuth, `http://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST}`, {
      disableWarnings: true,
    });
    emulatorConnected = true;
  }

  return cachedAuth;
}
