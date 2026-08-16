import "server-only";

/**
 * Secret storage abstraction (FINAL-ARCHITECTURE.md §1, §19, §26: "ห้ามเก็บ secret ใน source code
 * หรือ client-accessible document" — secrets referenced from Firestore, stored in Google Secret
 * Manager). Mirrors the `LineClientProvider` interface-then-implementation pattern already
 * established in Phase 2 (§22): domain code (`line-channel`, `notification/adapters`) depends only
 * on this interface, never on `@google-cloud/secret-manager` directly, so tests can substitute an
 * in-memory fake without touching real GCP.
 *
 * `ref` values are opaque strings this module controls the shape of (Secret Manager resource
 * names) — callers store only `ref`, never the secret value, in Firestore (`accessTokenRef`,
 * `channelSecretRef` on `lineChannelConfigs`).
 */
export interface SecretStore {
  /** Stores `value` under a new secret, returning its `ref` for persistence in Firestore. */
  putSecret(name: string, value: string): Promise<string>;
  /** Resolves a previously-stored secret's current value. Never logged/echoed by any caller. */
  getSecret(ref: string): Promise<string>;
}

let cachedStore: SecretStore | undefined;

/**
 * Real Google Secret Manager-backed implementation. Lazily constructed (same reasoning as
 * `getFirebaseAdminApp` in `src/lib/firebase/admin.ts`) so importing this module never requires
 * GCP credentials until a caller actually needs one.
 */
class GcpSecretManagerStore implements SecretStore {
  private client: import("@google-cloud/secret-manager").SecretManagerServiceClient | undefined;

  private async getClient() {
    if (!this.client) {
      const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
      this.client = new SecretManagerServiceClient();
    }
    return this.client;
  }

  private projectId(): string {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error("NEXT_PUBLIC_FIREBASE_PROJECT_ID is required for Secret Manager access.");
    return projectId;
  }

  async putSecret(name: string, value: string): Promise<string> {
    const client = await this.getClient();
    const parent = `projects/${this.projectId()}`;
    const [secret] = await client.createSecret({
      parent,
      secretId: name,
      secret: { replication: { automatic: {} } },
    });
    const [version] = await client.addSecretVersion({
      parent: secret.name,
      payload: { data: Buffer.from(value, "utf8") },
    });
    return version.name!;
  }

  async getSecret(ref: string): Promise<string> {
    const client = await this.getClient();
    const [accessResponse] = await client.accessSecretVersion({ name: ref });
    const data = accessResponse.payload?.data;
    if (!data) throw new Error(`Secret Manager returned no payload for ref.`);
    return data.toString("utf8");
  }
}

export function getSecretStore(): SecretStore {
  if (!cachedStore) cachedStore = new GcpSecretManagerStore();
  return cachedStore;
}

/** Test-only substitute — never used by production code paths. Emulator/unit tests inject this
 * via `setSecretStoreForTesting` instead of touching real GCP. */
export class InMemorySecretStore implements SecretStore {
  private store = new Map<string, string>();
  private counter = 0;

  async putSecret(name: string, value: string): Promise<string> {
    const ref = `in-memory://${name}/${++this.counter}`;
    this.store.set(ref, value);
    return ref;
  }

  async getSecret(ref: string): Promise<string> {
    const value = this.store.get(ref);
    if (value === undefined) throw new Error(`No secret found for ref.`);
    return value;
  }
}

/** Test-only seam (mirrors no equivalent elsewhere in this codebase yet — the first module needing
 * a swappable singleton for tests rather than a per-call parameter, since `line-channel`/
 * `notification` services call `getSecretStore()` internally rather than taking it as an argument,
 * to keep their own public signatures unchanged from the rest of this codebase's service-function
 * shape `(ctx, input)`). */
export function setSecretStoreForTesting(store: SecretStore): void {
  cachedStore = store;
}
