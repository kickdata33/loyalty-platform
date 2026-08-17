import "server-only";

import { NextResponse } from "next/server";

import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ServiceSuspendedError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";

/**
 * Maps a thrown error from a service function (or this file's own auth helpers) to an HTTP
 * response. Centralized here so every API route handles errors identically — "authenticate →
 * authorize → validate input → call service → map response" (route handlers should never
 * hand-roll their own status-code logic).
 */
export function toApiErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 401 });
  }
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 403 });
  }
  if (error instanceof TenantIsolationError) {
    // Deliberately generic message — never confirm to the caller that the resource they guessed
    // exists under a different merchant (§3, §26 IDOR/cross-tenant threat checklist).
    return NextResponse.json(
      { error: "PERMISSION_DENIED", message: "You do not have access to this resource." },
      { status: 403 },
    );
  }
  if (error instanceof ValidationError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 404 });
  }
  if (error instanceof ConflictError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
  }
  if (error instanceof ServiceSuspendedError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
  }

  // Server-side diagnostic only — never sent to the client.
  console.error("[api] unhandled error", error);
  return NextResponse.json(
    { error: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
    { status: 500 },
  );
}
