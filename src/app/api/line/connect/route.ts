import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { connectLineChannel } from "@/modules/line-channel/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface ConnectBody {
  lineProviderId?: unknown;
  messagingChannelId?: unknown;
  messagingChannelSecret?: unknown;
  messagingChannelAccessToken?: unknown;
  loginChannelId?: unknown;
  loginChannelSecret?: unknown;
}

/** Owner-only (`requireOwner` inside `connectLineChannel`) — the §20 "เชื่อมต่อ" button. */
export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as ConnectBody;

    for (const key of [
      "lineProviderId",
      "messagingChannelId",
      "messagingChannelSecret",
      "messagingChannelAccessToken",
      "loginChannelId",
      "loginChannelSecret",
    ] as const) {
      if (typeof body[key] !== "string" || (body[key] as string).trim().length === 0) {
        throw new ValidationError(`${key} is required.`);
      }
    }

    const webhookBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!webhookBaseUrl) throw new ValidationError("NEXT_PUBLIC_APP_URL is not configured.");

    const config = await connectLineChannel(
      ctx,
      {
        lineProviderId: body.lineProviderId as string,
        messagingChannelId: body.messagingChannelId as string,
        messagingChannelSecret: body.messagingChannelSecret as string,
        messagingChannelAccessToken: body.messagingChannelAccessToken as string,
        loginChannelId: body.loginChannelId as string,
        loginChannelSecret: body.loginChannelSecret as string,
      },
      webhookBaseUrl,
    );

    return NextResponse.json({ overallStatus: config.overallStatus }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
