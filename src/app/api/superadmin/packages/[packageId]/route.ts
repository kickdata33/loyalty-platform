import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { updatePackage, type UpsertPackageInput } from "@/modules/billing-entitlement/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ packageId: string }> },
) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const { packageId } = await params;
    const body = await request.json().catch(() => ({}));
    const input = parsePackageInput(body);
    await updatePackage(admin, packageId, input);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
