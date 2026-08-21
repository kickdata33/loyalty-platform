import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import {
  listMemberships,
  searchMemberships,
  MEMBER_LIST_DEFAULT_PAGE_SIZE,
  type ListMembershipsPage,
} from "@/modules/membership/service";
import type { MembershipRecord } from "@/modules/membership/types";

export const runtime = "nodejs";

/** Wire-safe projection of a `MembershipRecord` for this list/search endpoint only — every other
 * membership-returning route is unchanged. Deliberately omits `platformCustomerId` and
 * `merchantLineIdentity` (contains `lineUserId`) — neither is a display concern for the Owner/Staff
 * member list, and both are identity-adjacent values this codebase otherwise treats as
 * server-only (§6, §21, §26). Also omits `merchantId`/`branchId`/`tags` — not among the requested
 * display columns and not needed client-side. */
interface MemberListItem {
  id: string;
  memberCode: string;
  displayName: string;
  phone: string | null;
  pointsBalance: number;
  joinedAt: string;
  lastVisitAt: string | null;
}

function toMemberListItem(m: MembershipRecord): MemberListItem {
  return {
    id: m.id,
    memberCode: m.memberCode,
    displayName: m.merchantProfile.displayName,
    phone: m.merchantProfile.phone,
    pointsBalance: m.pointsBalance,
    joinedAt: m.joinedAt.toDate().toISOString(),
    lastVisitAt: m.activityStats.lastVisitAt ? m.activityStats.lastVisitAt.toDate().toISOString() : null,
  };
}

interface MemberListResponse {
  memberships: MemberListItem[];
  nextCursor: string | null;
}

function toResponse(page: ListMembershipsPage): MemberListResponse {
  return { memberships: page.memberships.map(toMemberListItem), nextCursor: page.nextCursor };
}

/**
 * Default member list + search, unified (§33 — Owner/Staff need to see members without already
 * knowing a name/phone/code, e.g. right after a customer joins through LINE). An empty/missing `q`
 * means "show all members" (paginated, newest first) via `listMemberships()`; a non-empty `q`
 * delegates to the existing `searchMemberships()` prefix search — reusing both existing service
 * functions rather than a parallel data-access path. `cursor`/`pageSize` only apply to the default
 * list; `searchMemberships()` is already self-limited per field (`PREFIX_QUERY_LIMIT`).
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();

    if (q.length === 0) {
      const cursor = url.searchParams.get("cursor");
      const pageSizeParam = url.searchParams.get("pageSize");
      const pageSize = pageSizeParam ? Number(pageSizeParam) : MEMBER_LIST_DEFAULT_PAGE_SIZE;
      const page = await listMemberships(ctx, {
        pageSize: Number.isFinite(pageSize) ? pageSize : MEMBER_LIST_DEFAULT_PAGE_SIZE,
        cursor,
      });
      return NextResponse.json(toResponse(page));
    }

    const results = await searchMemberships(ctx, q);
    return NextResponse.json(toResponse({ memberships: results, nextCursor: null }));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
