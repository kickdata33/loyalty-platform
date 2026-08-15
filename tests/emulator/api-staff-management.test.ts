import { describe, expect, it } from "vitest";

import { GET as getStaff, POST as postStaff } from "@/app/api/staff/route";
import { PATCH as patchRole } from "@/app/api/staff/[staffUserId]/role/route";
import { POST as postSuspend } from "@/app/api/staff/[staffUserId]/suspend/route";

import { createTestClientUser } from "./client-auth";
import { addStaffFixture, createMerchantFixture, idTokenFor, jsonRequest } from "./setup";

function withParams(staffUserId: string) {
  return { params: Promise.resolve({ staffUserId }) };
}

describe("Staff management authorization at the HTTP/API boundary (emulator)", () => {
  it("GET /api/staff: Staff role (no STAFF_MANAGE) gets 403", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const token = await idTokenFor(staff.authUid);

    const res = await getStaff(jsonRequest("http://localhost/api/staff", { token }));
    expect(res.status).toBe(403);
  });

  it("POST /api/staff: Staff role gets 403; Manager succeeds", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const newHire = await createTestClientUser("new-hire");

    const asStaff = await postStaff(
      jsonRequest("http://localhost/api/staff", {
        method: "POST",
        token: await idTokenFor(staff.authUid),
        json: { email: newHire.email, role: "STAFF" },
      }),
    );
    expect(asStaff.status).toBe(403);

    const asManager = await postStaff(
      jsonRequest("http://localhost/api/staff", {
        method: "POST",
        token: await idTokenFor(manager.authUid),
        json: { email: newHire.email, role: "STAFF" },
      }),
    );
    expect(asManager.status).toBe(201);
  });

  it("POST /api/staff: unknown email returns 400 with a self-service-friendly message", async () => {
    const { ownerCtx } = await createMerchantFixture();

    const res = await postStaff(
      jsonRequest("http://localhost/api/staff", {
        method: "POST",
        token: await idTokenFor(ownerCtx.authUid),
        json: { email: "nobody-registered@example.test", role: "STAFF" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH /api/staff/[id]/role: Manager cannot change the Owner's role (403)", async () => {
    const { ownerCtx, ownerStaffUserId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    const res = await patchRole(
      jsonRequest(`http://localhost/api/staff/${ownerStaffUserId}/role`, {
        method: "PATCH",
        token: await idTokenFor(manager.authUid),
        json: { role: "MANAGER" },
      }),
      withParams(ownerStaffUserId),
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/staff/[id]/suspend: cross-tenant target (staffUserId from a different merchant) is denied, not silently ignored", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const staffOfB = await addStaffFixture(merchantB.ownerCtx, "STAFF");

    // Owner of A tries to suspend a staffUserId that belongs to merchant B.
    const res = await postSuspend(
      jsonRequest(`http://localhost/api/staff/${staffOfB.staffUserId}/suspend`, {
        method: "POST",
        token: await idTokenFor(merchantA.ownerAuthUid),
      }),
      withParams(staffOfB.staffUserId),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    // Deliberately generic — never confirms the target belongs to a different merchant.
    expect(body.message).not.toMatch(/merchant/i);
  });

  it("POST /api/staff/[id]/suspend: Owner suspending their own merchant's Staff succeeds", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    const res = await postSuspend(
      jsonRequest(`http://localhost/api/staff/${staff.staffUserId}/suspend`, {
        method: "POST",
        token: await idTokenFor(ownerCtx.authUid),
      }),
      withParams(staff.staffUserId),
    );
    expect(res.status).toBe(200);
  });
});
