/**
 * LineClientProvider abstraction (FINAL-ARCHITECTURE.md §22, Final Security Note 2).
 *
 * Customer Portal business logic/components must NEVER call `liff.getProfile()`,
 * `liff.login()`, `liff.getIdToken()`, etc. directly — everything goes through this interface so
 * a future move to LINE MINI App (or any other channel) is "implement one new adapter", not "redo
 * the Customer Portal" (§22 scope).
 *
 * Phase 2 defines this interface and wires the Customer Portal skeleton to consume it exclusively
 * (see `NotImplementedLineClientProvider`) — the concrete `LiffClientProvider` that actually wraps
 * the LIFF SDK is Phase 7 (§22, §33 Definition of Done). Nothing in Phase 2 performs a real LINE
 * login or fabricates a fake success — see `NotImplementedLineClientProvider`.
 */

export interface LineClientContext {
  /** Whether the current webview is running inside the LINE app. */
  isInClient: boolean;
}

export interface LineClientProvider {
  /** Triggers the provider's login flow. */
  login(): Promise<void>;
  /**
   * Returns the raw ID Token to send to the backend for verification (§21). The backend payload
   * shape (`{ idToken }`) never changes regardless of which provider implementation is behind
   * this interface (§22).
   */
  getIdToken(): Promise<string>;
  getContext(): Promise<LineClientContext>;
}
