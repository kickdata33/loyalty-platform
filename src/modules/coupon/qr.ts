import "server-only";

import QRCode from "qrcode";

/**
 * QR Coupon (§14: "Customer เปิดคูปอง → แสดง QR/code"). Encodes a coupon instance's `code` (never
 * the raw Firestore `instanceId`) — same reasoning as `points/qr.ts`'s member QR: `code` is
 * already the customer-facing identifier, so scanning it reveals nothing beyond what the customer
 * already sees. Reuses the same `qrcode` package already approved/added in Phase 3 — no new
 * dependency.
 */
export async function generateCouponQrCodeDataUrl(code: string): Promise<string> {
  return QRCode.toDataURL(code, { errorCorrectionLevel: "M", margin: 1, width: 256 });
}
