import type { Timestamp } from "firebase-admin/firestore";

/** Schema per FINAL-ARCHITECTURE.md §5/§6. `line` is listed for schema completeness — actual
 * LINE ID Token verification is Phase 7 scope (§21); Phase 1 only builds the generic resolve
 * mechanism, callable with any already-verified subject. */
export type IdentityProvider = "line" | "phone" | "email";

export interface PlatformCustomerRecord {
  id: string;
  createdAt: Timestamp;
}

export interface CustomerIdentityRecord {
  /** = deterministicHash(provider, providerScope, normalizedSubject) — also the document id. */
  id: string;
  provider: IdentityProvider;
  /** e.g. lineProviderId for provider='line'; null for phone/email. */
  providerScope: string | null;
  providerSubjectHash: string;
  platformCustomerId: string;
  verifiedAt: Timestamp | null;
  createdAt: Timestamp;
}
