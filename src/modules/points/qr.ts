import "server-only";

import QRCode from "qrcode";

/**
 * QR Member (§33 Phase 3). Encodes a member's `memberCode` (never `membershipId`/`platformCustomerId`
 * — `memberCode` is already the member-facing identifier shown/printed on a card, so scanning it
 * reveals nothing beyond what's already visible on the card itself). Server-side generation via
 * the `qrcode` package (see dependency rationale in the Phase 3 report) — returns a data: URL
 * embeddable directly in an `<img src>`, no client-side QR rendering library needed.
 */
export async function generateMemberQrCodeDataUrl(memberCode: string): Promise<string> {
  return QRCode.toDataURL(memberCode, { errorCorrectionLevel: "M", margin: 1, width: 256 });
}
