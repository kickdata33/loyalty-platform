/**
 * Shared error taxonomy for all modules.
 *
 * FINAL-ARCHITECTURE.md §10: the Authorization Service must throw `AuthorizationError` and
 * `TenantIsolationError` as distinct, identifiable error types so callers (API routes, tests)
 * can tell "you don't have this permission" apart from "you tried to touch another tenant's
 * data" without parsing error messages.
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The caller's identity/token could not be established or was malformed. Fail closed. */
export class AuthenticationError extends AppError {
  constructor(message: string) {
    super(message, "UNAUTHENTICATED");
  }
}

/** The caller is authenticated but lacks the permission required for this operation. */
export class AuthorizationError extends AppError {
  constructor(message: string) {
    super(message, "PERMISSION_DENIED");
  }
}

/**
 * The caller attempted to access/modify a resource belonging to a merchant other than the one
 * in their verified auth context (FINAL-ARCHITECTURE.md §3, §26 threat checklist). Kept distinct
 * from AuthorizationError so tenant-isolation violations can be asserted on specifically in tests
 * and alerted on more loudly than an ordinary permission error.
 */
export class TenantIsolationError extends AppError {
  constructor(message: string) {
    super(message, "TENANT_ISOLATION_VIOLATION");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT");
  }
}
