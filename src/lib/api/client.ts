import { getFirebaseAuth } from "@/lib/firebase/client";

/**
 * Shared authenticated API client — implements the client side of the locked Phase 2
 * Architecture Decision (FINAL-ARCHITECTURE.md §8, "Staff/Owner API Authentication Transport").
 *
 * Never stores the ID Token itself (no `localStorage`/`sessionStorage`) — every call pulls a
 * fresh token from the Firebase Auth SDK, which owns all persistence/refresh/lifecycle. This is
 * the ONLY place in the app that should attach an `Authorization` header; components/pages call
 * `apiFetch()` instead of the raw `fetch()` for any protected endpoint.
 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

/**
 * Fetches `path` with a fresh Firebase ID Token attached. Throws `ApiClientError` if the caller
 * isn't signed in, or if the response is not ok (2xx) — callers can `catch` and read `.status`.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    throw new ApiClientError("Not signed in.", 401, "UNAUTHENTICATED");
  }

  // `getIdToken()` (no force-refresh) returns the SDK's cached token and transparently refreshes
  // it if expired — the SDK, not this code, decides when a refresh is needed.
  const idToken = await user.getIdToken();

  const { body, headers, ...rest } = options;
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${idToken}`,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return response;
}

/** Convenience wrapper: `apiFetch` + parse JSON + throw `ApiClientError` on non-2xx. */
export async function apiFetchJson<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new ApiClientError(
      data.message ?? `Request failed with status ${response.status}.`,
      response.status,
      data.error ?? "UNKNOWN_ERROR",
    );
  }

  return data as T;
}
