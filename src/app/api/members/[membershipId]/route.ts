import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getMembership } from "@/modules/membership/service";
import { generateMemberQrCodeDataUrl } from "@/modules/points/qr";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { membershipId } = await params;
    const membership = await getMembership(ctx, membershipId);
    const qrCodeDataUrl = await generateMemberQrCodeDataUrl(membership.memberCode);
    return NextResponse.json({ ...membership, qrCodeDataUrl });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
