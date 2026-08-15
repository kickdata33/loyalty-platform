import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPlatformCustomer, resolveOrCreatePlatformCustomer } from "@/modules/identity/service";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS } from "@/modules/shared/firestore";

import { getDb } from "./setup";

describe("Global Customer Identity foundation (emulator)", () => {
  it("rejects an unverified subject for provider !== 'manual'", async () => {
    await expect(
      resolveOrCreatePlatformCustomer({
        provider: "phone",
        providerScope: null,
        subject: `+66${Date.now()}`,
        verified: false,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("requires providerScope (lineProviderId) for provider='line'", async () => {
    await expect(
      resolveOrCreatePlatformCustomer({
        provider: "line",
        providerScope: null,
        subject: randomUUID(),
        verified: true,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("resolves the same PlatformCustomer for the same verified identity on repeat calls", async () => {
    const subject = randomUUID();
    const first = await resolveOrCreatePlatformCustomer({
      provider: "phone",
      providerScope: null,
      subject,
      verified: true,
    });
    const second = await resolveOrCreatePlatformCustomer({
      provider: "phone",
      providerScope: null,
      subject,
      verified: true,
    });
    expect(second).toBe(first);

    const db = getDb();
    const customerSnap = await db.collection(COLLECTIONS.platformCustomers).doc(first).get();
    expect(customerSnap.exists).toBe(true);
  });

  it("normalizes subject (case/whitespace) to the same identity", async () => {
    const base = randomUUID();
    const a = await resolveOrCreatePlatformCustomer({
      provider: "email",
      providerScope: null,
      subject: ` ${base}@Example.com `,
      verified: true,
    });
    const b = await resolveOrCreatePlatformCustomer({
      provider: "email",
      providerScope: null,
      subject: `${base}@example.com`,
      verified: true,
    });
    expect(b).toBe(a);
  });

  it("is race-safe: N concurrent calls for the same new identity all resolve to one PlatformCustomer", async () => {
    const subject = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        resolveOrCreatePlatformCustomer({
          provider: "phone",
          providerScope: null,
          subject,
          verified: true,
        }),
      ),
    );
    const distinct = new Set(results);
    expect(distinct.size).toBe(1);
  });

  it("createPlatformCustomer() never dedupes — each call is a brand-new customer", async () => {
    const a = await createPlatformCustomer();
    const b = await createPlatformCustomer();
    expect(a).not.toBe(b);
  });
});
