import type { Role, StaffStatus } from "@/modules/shared/types";

/** `staffUsers/{staffUserId}` — top-level, indexed by merchantId (§5). */
export interface StaffUserRecord {
  id: string;
  merchantId: string;
  authUid: string;
  role: Role;
  /** Permissions granted in addition to the role default — see permission-matrix.ts. */
  permissionOverrides: string[];
  /** Empty = unrestricted (all branches), §11. */
  branchScope: string[];
  status: StaffStatus;
}
