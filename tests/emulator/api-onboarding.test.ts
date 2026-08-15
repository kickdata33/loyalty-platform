import { describe, expect, it } from "vitest";

import { POST as postMerchants } from "@/app/api/merchants/route";

import { createTestClientUser, getFreshIdToken } from "./client-auth";
import { jsonRequest, uniqueSlug } from "./setup";

describe("Onboarding authorization (POST /api/merchants, emulator)", () => {
  it("rejects an unauthenticated onboarding attempt", async () => {
    const res = await postMerchants(
      jsonRequest("http://localhost/api/merchants", {
        method: "POST",
        json: { name: "No Auth Shop", slug: uniqueSlug("noauth"), businessType: "cafe", timezone: "Asia/Bangkok" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request missing required fields", async () => {
    const user = await createTestClientUser("onboard-missing");
    const token = await getFreshIdToken(user);

    const res = await postMerchants(
      jsonRequest("http://localhost/api/merchants", {
        method: "POST",
        token,
        json: { name: "Incomplete Shop" }, // missing slug/businessType/timezone
      }),
    );
    expect(res.status).toBe(400);
  });

  it("succeeds for an authenticated, complete request", async () => {
    const user = await createTestClientUser("onboard-ok");
    const token = await getFreshIdToken(user);
    const slug = uniqueSlug("onboard-ok");

    const res = await postMerchants(
      jsonRequest("http://localhost/api/merchants", {
        method: "POST",
        token,
        json: { name: "Onboard OK Shop", slug, businessType: "cafe", timezone: "Asia/Bangkok" },
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { merchantId: string; branchId: string; staffUserId: string };
    expect(body.merchantId).toBeTruthy();
    expect(body.staffUserId).toBeTruthy();
  });

  it("rejects a duplicate slug with 409", async () => {
    const userA = await createTestClientUser("onboard-dup-a");
    const userB = await createTestClientUser("onboard-dup-b");
    const slug = uniqueSlug("dup");

    const bodyFor = (name: string) => ({ name, slug, businessType: "cafe", timezone: "Asia/Bangkok" });

    const first = await postMerchants(
      jsonRequest("http://localhost/api/merchants", {
        method: "POST",
        token: await getFreshIdToken(userA),
        json: bodyFor("First"),
      }),
    );
    expect(first.status).toBe(201);

    const second = await postMerchants(
      jsonRequest("http://localhost/api/merchants", {
        method: "POST",
        token: await getFreshIdToken(userB),
        json: bodyFor("Second"),
      }),
    );
    expect(second.status).toBe(409);
  });
});
