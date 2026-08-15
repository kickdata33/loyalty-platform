"use client";

import { onIdTokenChanged, type User } from "firebase/auth";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { getFirebaseAuth } from "@/lib/firebase/client";

/**
 * Client-side auth state for the Staff Portal (`/dashboard`).
 *
 * There is no session cookie in this app (§8 Phase 2 Architecture Decision: Bearer ID Token
 * only) — a normal page navigation/SSR render has no way to know if the visitor is signed in.
 * Route protection for `/dashboard/*` therefore happens client-side: this provider tracks
 * Firebase Auth's own state (`onIdTokenChanged`, which also fires on token refresh so
 * `claims` stays current — §8's documented custom-claims-cache caveat) and pages/layouts decide
 * what to render based on it, showing an explicit loading state until the first check resolves.
 */

export interface StaffClaims {
  merchantId?: string;
  role?: string;
  staffUserId?: string;
}

interface AuthState {
  user: User | null;
  claims: StaffClaims | null;
  /** True until the first auth-state check has resolved. */
  loading: boolean;
  /** Forces a fresh ID Token fetch — call right after onboarding creates a merchant, since
   * custom claims are cached client-side until the token is refreshed (§8). */
  refreshClaims: () => Promise<void>;
}

const AuthContextReact = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<StaffClaims | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getFirebaseAuth();
    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (nextUser) {
        const result = await nextUser.getIdTokenResult();
        setClaims(result.claims as StaffClaims);
      } else {
        setClaims(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const refreshClaims = async () => {
    const current = getFirebaseAuth().currentUser;
    if (!current) return;
    const result = await current.getIdTokenResult(/* forceRefresh */ true);
    setClaims(result.claims as StaffClaims);
  };

  return (
    <AuthContextReact.Provider value={{ user, claims, loading, refreshClaims }}>
      {children}
    </AuthContextReact.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContextReact);
  if (!ctx) throw new Error("useAuth() must be used within an <AuthProvider>.");
  return ctx;
}
