import { describe, expect, it } from "vitest";

import { toApiErrorResponse } from "@/lib/api/errors";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";

describe("toApiErrorResponse()", () => {
  it("maps AuthenticationError to 401", () => {
    expect(toApiErrorResponse(new AuthenticationError("nope")).status).toBe(401);
  });

  it("maps AuthorizationError to 403", () => {
    expect(toApiErrorResponse(new AuthorizationError("nope")).status).toBe(403);
  });

  it("maps TenantIsolationError to 403 with a deliberately generic message", async () => {
    const res = toApiErrorResponse(
      new TenantIsolationError("staff of merchant X accessed merchant Y's membership record"),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toMatch(/merchant/i);
  });

  it("maps ValidationError to 400", () => {
    expect(toApiErrorResponse(new ValidationError("bad input")).status).toBe(400);
  });

  it("maps NotFoundError to 404", () => {
    expect(toApiErrorResponse(new NotFoundError("missing")).status).toBe(404);
  });

  it("maps ConflictError to 409", () => {
    expect(toApiErrorResponse(new ConflictError("duplicate")).status).toBe(409);
  });

  it("maps unknown errors to 500 without leaking internal details", async () => {
    const res = toApiErrorResponse(new Error("stack trace with internal file paths"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toMatch(/stack trace|internal file/i);
  });
});
