import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createPackage, listPackages, type UpsertPackageInput } from "@/modules/billing-entitlement/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireSuperAdminAuthContext(request);
    const packages = await listPackages();
    return NextResponse.json(packages);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

function parsePackageInput(body: unknown): UpsertPackageInput {
  const b = (body ?? {}) as Partial<Record<keyof UpsertPackageInput, unknown>>;
  if (typeof b.name !== "string") throw new ValidationError("name is required.");
  if (typeof b.memberLimit !== "number") throw new ValidationError("memberLimit is required.");
  if (typeof b.staffLimit !== "number") throw new ValidationError("staffLimit is required.");
  if (typeof b.branchLimit !== "number") throw new ValidationError("branchLimit is required.");
  if (typeof b.price !== "number") throw new ValidationError("price is required.");
  const features = (b.features ?? {}) as Record<string, unknown>;
  return {
    name: b.name,
    memberLimit: b.memberLimit,
    staffLimit: b.staffLimit,
    branchLimit: b.branchLimit,
    price: b.price,
    features: {
      automation: Boolean(features.automation),
      advancedReports: Boolean(features.advancedReports),
      segments: Boolean(features.segments),
    },
  };
}

/** Package CRUD — Super Admin only (§25, §37.3). Read is public to any signed-in user via
 * `firestore.rules` already (plan comparison UI needs it) — this route only handles the write. */
export async function POST(request: Request) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const body = await request.json().catch(() => ({}));
    const input = parsePackageInput(body);
    const packageId = await createPackage(admin, input);
    return NextResponse.json({ packageId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
