import { randomUUID } from "node:crypto";

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import { getAdminAuth } from "@/lib/firebase/admin";

/**
 * Test-only helper that gets REAL, signature-valid Firebase ID Tokens from the Auth emulator via
 * the actual client SDK — as opposed to the fabricated decoded-token objects
 * `tests/unit/auth-context.test.ts` uses to test `buildAuthContext`'s parsing logic in isolation.
 * These tests specifically need a token that `getAdminAuth().verifyIdToken()` will really
 * accept/reject, since that's exactly what's being locked down in Phase 2 (§8).
 */

let clientApp: FirebaseApp | undefined;

function getTestClientApp(): FirebaseApp {
  if (clientApp) return clientApp;
  const projectId = process.env.GCLOUD_PROJECT ?? "loyalty-platform-dev-9a0c5";
  // apiKey doesn't need to be real — the Auth emulator doesn't validate it.
  clientApp = initializeApp({ apiKey: "test-api-key", projectId }, `test-client-${randomUUID()}`);
  const auth = getAuth(clientApp);
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
  connectAuthEmulator(auth, `http://${host}`, { disableWarnings: true });
  return clientApp;
}

export interface TestClientUser {
  uid: string;
  email: string;
  password: string;
}

/** Creates a brand-new Auth emulator user via the client SDK (real signup flow) and returns its
 * credentials — callers typically then use `uid` to create a StaffUser/Merchant server-side. */
export async function createTestClientUser(emailPrefix: string): Promise<TestClientUser> {
  const auth = getAuth(getTestClientApp());
  const email = `${emailPrefix}-${randomUUID()}@example.test`;
  const password = "test-password-123";
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;
  await signOut(auth);
  return { uid, email, password };
}

/** Signs in and returns a freshly-minted ID Token — call this AFTER setting custom claims
 * server-side, since a token obtained before that won't carry them (signing in again always gets
 * the current claims from the Auth server, unlike a cached client session). */
export async function getFreshIdToken(user: TestClientUser): Promise<string> {
  const auth = getAuth(getTestClientApp());
  const cred = await signInWithEmailAndPassword(auth, user.email, user.password);
  const idToken = await cred.user.getIdToken(true);
  await signOut(auth);
  return idToken;
}

/**
 * For fixtures created via the Admin SDK directly (e.g. `createMerchantFixture` in ./setup,
 * which has no password) — mints a custom token server-side and exchanges it for a real ID Token
 * via the client SDK, so tests can call route handlers with a token that
 * `getAdminAuth().verifyIdToken()` actually verifies end to end.
 */
export async function getIdTokenForExistingUid(authUid: string): Promise<string> {
  const customToken = await getAdminAuth().createCustomToken(authUid);
  const auth = getAuth(getTestClientApp());
  const cred = await signInWithCustomToken(auth, customToken);
  const idToken = await cred.user.getIdToken(true);
  await signOut(auth);
  return idToken;
}
