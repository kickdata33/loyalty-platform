import { afterEach, describe, expect, it, vi } from "vitest";

import { putSecretViaClient, type SecretManagerClientLike } from "@/modules/shared/secret-store";

/**
 * Regression coverage for the retry-safety fix (staging incident: `connectLineChannel()`'s first
 * `putSecret()` call hit a transient `UNAVAILABLE`/502 from Secret Manager whose `createSecret`
 * had actually succeeded server-side; retrying then failed hard with `ALREADY_EXISTS` since the
 * deterministic secret name collided with itself). `putSecretViaClient` is the extracted,
 * dependency-injected core of `GcpSecretManagerStore.putSecret` — tested here against a fake
 * client so no real GCP credentials/project are needed.
 */

const PARENT = "projects/loyalty-platform-staging-01";
const NAME = "line-messaging-secret-abc123";

function fakeClient(overrides: Partial<SecretManagerClientLike>): SecretManagerClientLike {
  return {
    createSecret: vi.fn(),
    addSecretVersion: vi.fn(),
    ...overrides,
  } as SecretManagerClientLike;
}

describe("putSecretViaClient()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first-time creation: calls createSecret then addSecretVersion, returns the version ref", async () => {
    const createSecret = vi.fn().mockResolvedValue([{ name: `${PARENT}/secrets/${NAME}` }]);
    const addSecretVersion = vi.fn().mockResolvedValue([{ name: `${PARENT}/secrets/${NAME}/versions/1` }]);
    const client = fakeClient({ createSecret, addSecretVersion });

    const ref = await putSecretViaClient(client, PARENT, NAME, "super-secret-value");

    expect(createSecret).toHaveBeenCalledTimes(1);
    expect(createSecret).toHaveBeenCalledWith({
      parent: PARENT,
      secretId: NAME,
      secret: { replication: { automatic: {} } },
    });
    expect(addSecretVersion).toHaveBeenCalledTimes(1);
    expect(addSecretVersion).toHaveBeenCalledWith({
      parent: `${PARENT}/secrets/${NAME}`,
      payload: { data: Buffer.from("super-secret-value", "utf8") },
    });
    expect(ref).toBe(`${PARENT}/secrets/${NAME}/versions/1`);
  });

  it("retries safely when the secret already exists: reuses it and still adds a version", async () => {
    const alreadyExists = Object.assign(new Error("Secret [...] already exists."), { code: 6 });
    const createSecret = vi.fn().mockRejectedValue(alreadyExists);
    const addSecretVersion = vi.fn().mockResolvedValue([{ name: `${PARENT}/secrets/${NAME}/versions/2` }]);
    const client = fakeClient({ createSecret, addSecretVersion });

    const ref = await putSecretViaClient(client, PARENT, NAME, "super-secret-value");

    expect(createSecret).toHaveBeenCalledTimes(1);
    // No read/list call needed — the deterministic resource name is reconstructed directly.
    expect(addSecretVersion).toHaveBeenCalledTimes(1);
    expect(addSecretVersion).toHaveBeenCalledWith({
      parent: `${PARENT}/secrets/${NAME}`,
      payload: { data: Buffer.from("super-secret-value", "utf8") },
    });
    expect(ref).toBe(`${PARENT}/secrets/${NAME}/versions/2`);
  });

  it("does not treat a non-ALREADY_EXISTS createSecret error as reusable — rethrows, never calls addSecretVersion", async () => {
    const unavailable = Object.assign(new Error("502:Bad Gateway"), { code: 14 });
    const createSecret = vi.fn().mockRejectedValue(unavailable);
    const addSecretVersion = vi.fn();
    const client = fakeClient({ createSecret, addSecretVersion });

    await expect(putSecretViaClient(client, PARENT, NAME, "super-secret-value")).rejects.toBe(unavailable);
    expect(addSecretVersion).not.toHaveBeenCalled();
  });

  it("does not treat an error without a numeric ALREADY_EXISTS code as reusable", async () => {
    const genericError = new Error("network hiccup");
    const createSecret = vi.fn().mockRejectedValue(genericError);
    const addSecretVersion = vi.fn();
    const client = fakeClient({ createSecret, addSecretVersion });

    await expect(putSecretViaClient(client, PARENT, NAME, "super-secret-value")).rejects.toBe(genericError);
    expect(addSecretVersion).not.toHaveBeenCalled();
  });

  it("never logs or exposes the secret payload, on the create path or the retry path", async () => {
    const secretValue = "THIS-MUST-NEVER-APPEAR-IN-LOGS-9f8e7d";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Create path.
    const createSecret1 = vi.fn().mockResolvedValue([{ name: `${PARENT}/secrets/${NAME}` }]);
    const addSecretVersion1 = vi.fn().mockResolvedValue([{ name: `${PARENT}/secrets/${NAME}/versions/1` }]);
    await putSecretViaClient(fakeClient({ createSecret: createSecret1, addSecretVersion: addSecretVersion1 }), PARENT, NAME, secretValue);

    // Retry/ALREADY_EXISTS path.
    const alreadyExists = Object.assign(new Error("Secret [...] already exists."), { code: 6 });
    const createSecret2 = vi.fn().mockRejectedValue(alreadyExists);
    const addSecretVersion2 = vi.fn().mockResolvedValue([{ name: `${PARENT}/secrets/${NAME}/versions/2` }]);
    await putSecretViaClient(fakeClient({ createSecret: createSecret2, addSecretVersion: addSecretVersion2 }), PARENT, NAME, secretValue);

    const allLoggedArgs = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)));

    for (const logged of allLoggedArgs) {
      expect(logged).not.toContain(secretValue);
    }
    // Also confirm the mock call arguments captured by the client itself never carry the value
    // anywhere except the one expected Buffer payload field (i.e. no accidental duplication into
    // a differently-shaped/logged field).
    const createCallArgs = JSON.stringify([...createSecret1.mock.calls, ...createSecret2.mock.calls]);
    expect(createCallArgs).not.toContain(secretValue);
  });
});
