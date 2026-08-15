# CLAUDE.md — Persistent Project Instructions

> **Source of Truth**: `docs/architecture/FINAL-ARCHITECTURE.md` คือเอกสารอ้างอิงสูงสุดของโปรเจกต์นี้เสมอ
> ไฟล์นี้ (`CLAUDE.md`) เป็นแค่ **สรุปกติกาที่ต้องจำตลอด session** — ถ้าเนื้อหาในไฟล์นี้ขัดแย้งกับ
> `FINAL-ARCHITECTURE.md` ไม่ว่ากรณีใด **ให้ยึด FINAL-ARCHITECTURE.md เป็นหลักเสมอ** และควรกลับไปอ่าน
> เอกสารนั้นซ้ำก่อนตัดสินใจเรื่องสำคัญ ไฟล์นี้ไม่ได้แทนที่การอ่านเอกสารฉบับเต็ม

**ห้ามใช้ Application Code ที่เคยทดลองสร้างใน environment อื่นก่อนหน้านี้ (เช่น Claude Desktop) เป็นฐานอ้างอิง** — repo นี้เริ่มใหม่ทั้งหมดตาม FINAL-ARCHITECTURE.md เท่านั้น

---

## Product Scope

Self-Service Multi-Tenant Loyalty Platform (~50 merchants เป้าหมายแรก) — **ไม่ใช่ POS, ไม่ใช่ Accounting**
Core: Membership + Loyalty + CRM Activity + Rewards + Coupons + Promotions + Automation + Reports เท่านั้น

**V1 Exclusions (ห้ามเพิ่มเองโดยไม่ได้รับคำสั่งชัดเจน)**: Full POS, Accounting, Inventory, AI Chat/Image/Agent,
Facebook/Instagram Integration, SMS, Native Mobile App, Marketplace, Cross-Merchant Marketing, Wallet,
Customer Payment, Booking System — extension point ออกแบบไว้ได้ แต่ห้าม implement จริง

ห้าม hard-code business logic เฉพาะประเภทร้าน (สนุกเกอร์/ร้านอาหาร/ฯลฯ) — ต้อง config-driven เสมอ
ห้ามแสดง Sales Revenue/Analytics เพราะไม่มี trusted transaction source

**Self-Service Priority Rule**: ก่อนสร้าง feature ใดๆ ถามเสมอว่า "Owner ร้านทั่วไปตั้งค่านี้เองได้หรือไม่
โดยไม่ต้องโทร Support?" — UI ห้ามโชว์ศัพท์ technical (Webhook, Trigger Expression, JSON, Tenant ID)

---

## Approved Technology Stack

- **Frontend/Backend**: Next.js + TypeScript (App Router), deploy บน Firebase App Hosting
- **Auth**: Firebase Authentication
- **Database**: Firestore เดียว (ไม่ใช่ database-per-tenant)
- **Backend Compute**: Next.js API Route + Firebase Cloud Functions
- **Storage**: Firebase Storage
- **Secrets**: Google Secret Manager เท่านั้น — ห้ามมี secret ใน source code หรือ client-accessible document
- **LINE**: LINE Login, LIFF, LINE Messaging API
- **Reporting V1**: Firestore only — ห้ามใช้ BigQuery ใน V1
- **ห้ามอยู่ใน V1**: POS Integration, AI ทุกชนิด, Payment Gateway integration จริง (extension point เท่านั้น)

ก่อนเพิ่ม library/dependency ใหม่นอกเหนือจากที่ระบุ **ต้องเสนอเหตุผลก่อนเสมอ** และหลีกเลี่ยง dependency ที่ไม่จำเป็น

---

## Architecture Constraints

- **Modular Monolith** บน Next.js + Firebase — ไม่ใช่ Microservices
- แบ่ง 3 ชั้น: Presentation (`/dashboard`, `/m/[merchantSlug]`, `/superadmin`) → Application/Domain (`/modules/*`
  แยกตาม bounded context) → Data/Infra (Firestore, Cloud Functions, Storage, Auth)
- `/modules/*` เป็น pure business logic ใช้ร่วมกันได้ทั้ง Next.js API Route และ Cloud Functions — **ห้ามมี
  logic ซ้ำสองที่**
- **ห้าม UI/React component เขียน Firestore ตรงสำหรับ operation ที่มีผลต่อ business state** (points, coupon,
  reward, ฯลฯ) — ต้องผ่าน module service function เท่านั้น
- ทุกการเชื่อมต่อภายนอก (LINE, POS อนาคต, Payment Gateway อนาคต) ต้องผ่าน **Adapter/Integration Layer** เสมอ
  — ห้าม Domain Logic เรียก external API ตรง

---

## Multi-Tenant / Tenant Isolation

หลักการ 3 ชั้น บังคับทุกชั้น ไม่มีข้อยกเว้น:

1. **Schema**: ทุก merchant-scoped collection มี `merchantId` เป็น direct field
2. **Security Rules (defense-in-depth ชั้นที่สอง)**: เช็ค `request.auth.token.merchantId == resource.data.merchantId`
3. **Application (primary boundary)**: ทุก service function derive `merchantId` จาก **authenticated
   session/verified custom claims เท่านั้น** — แม้ client ส่ง `merchantId` ปลอมมาใน request payload ต้อง
   **ignore เสมอ** และใช้ค่าจาก token

Firestore เดียวรวมทุก merchant (ไม่ใช่ database-per-tenant) — ใช้ Firestore auto-id/ULID ไม่ใช่ sequential id

**บังคับต้องมี automated test**: login merchant A พยายามอ่าน/เขียน document merchant B ต้อง fail เสมอ,
แก้ `merchantId` ใน payload ต้องถูก server เพิกเฉย

---

## Global Customer Identity

- **ห้าม assume ว่า LINE userId เดียวกันใช้ข้าม Merchant ได้** — LINE userId unique ต่อ Provider ไม่ใช่ต่อบุคคล
- แยก 3 concept ชัดเจน: `PlatformCustomer` (global, ไม่มี PII) / `customerIdentities` (server-only resolve
  index) / `Membership` (merchant-scoped, ที่เก็บ profile/points/coupon จริง)
- `identityId = deterministicHash(provider, providerScope, normalizedSubject)` — resolve/create ผ่าน
  Firestore Transaction แบบ read-then-conditional-create เท่านั้น (กัน race condition สร้างซ้ำ)
- สำหรับ `provider !== 'manual'` (line/phone/email) ค่า `subject` **ต้องเป็นค่าที่ backend verify แล้วเท่านั้น**
  ห้ามรับดิบจาก client
- `platformCustomers` เก็บแค่ `createdAt` — **ไม่มี PII ระดับ platform เด็ดขาด**
- Cross-merchant identity linking เป็น **opt-in ผ่าน verified phone/email (OTP) เท่านั้น**
- **ห้าม auto-merge จาก LINE Display Name/รูปโปรไฟล์** เด็ดขาด
- `platformCustomers`/`customerIdentities` เป็น **deny-all client access 100%** — server-side เท่านั้น
  ไม่มีข้อยกเว้นแม้แต่ Super Admin ผ่าน client SDK ปกติ
- Staff ร้าน A ต้องไม่มี query path ใดๆ ที่ join ไปเห็น Membership ของร้าน B ได้ แม้ระบบจะรู้ว่าเป็นคนเดียวกัน

---

## Owner / Manager / Staff RBAC (Permission Matrix V1 — LOCKED)

**ห้ามแก้ Permission Matrix โดยไม่ได้รับการอนุมัติใหม่อย่างชัดเจน**

- **Owner**: full merchant access ทุกอย่าง รวม Manage Staff/Permissions/Settings/LINE/Billing, ปิด/ลบ Merchant
- **Manager**: operational control เต็มยกเว้น — ห้ามเปลี่ยน Owner, ห้ามแก้ Owner permissions, ห้ามจัดการ LINE
  credentials, ห้ามจัดการ Package/Billing, ห้ามปิด/ลบ Merchant
- **Staff**: counter operations เท่านั้น (add points ตาม rule, manual add ภายใน limit, redeem reward/coupon,
  view history) — **ห้าม** adjust/reverse points, สร้าง reward/coupon/promotion/automation, broadcast,
  ดู management reports, manage staff/permissions/settings/LINE/billing

Staff Limits (`maxPointsPerTransaction`, `maxPointsPerHour`, `maxPointsPerDay`, `manualAdjustmentLimit`,
`managerApprovalThreshold`) เก็บที่ `merchants/{id}.staffLimits` **config-driven ห้าม hard-code** และต้องตรวจ
**ภายใน transaction เดียวกับการเขียน ledger entry** ไม่ใช่ check-then-write แยก step

---

## Server-Side Authorization Requirements

- Backend ตรวจ permission **ทุกครั้ง** จาก custom claims + StaffUser document ผ่าน **Centralized
  Authorization Service เดียว** เท่านั้น — **ห้ามใส่ permission check กระจายตาม UI component**
- Frontend permission list ใช้แค่ซ่อน/แสดง UI (UX เท่านั้น ไม่ใช่ security boundary)
- Authorization Service ต้องมี `requirePermission(ctx, permission, resourceMerchantId)`,
  `requireOwner(ctx, resourceMerchantId)`, `requireBranchScope(staff, branchId)`
- `resourceMerchantId` ที่ส่งเข้า `requirePermission()` ต้องมาจาก **data ที่โหลดจาก server แล้วเท่านั้น**
  ไม่ใช่จาก unvalidated client input
- Custom claims (`merchantId`, `role`, `staffUserId`, `branchScope`) ตั้งได้จาก **Firestore Trigger เดียว**
  (`onStaffUserWrite`) เท่านั้น — ห้าม client set เอง ห้ามมี code path อื่นตั้ง claims
- Firestore Security Rules เป็น defense-in-depth ชั้นที่สองเท่านั้น — business-sensitive write ต้องผ่าน
  server เสมอ ไม่เปิด client write ตรงบน collection ที่กระทบ business state

---

## Points Ledger / Lots / FIFO / Reversal Constraints

- `pointsLedger` = **immutable append-only** source of truth ของ "เกิดอะไรขึ้น" — ห้ามแก้ย้อนหลังเด็ดขาด
- `pointsLots` = FIFO working state ("แต้มก้อนไหนเหลือเท่าไหร่") — field เดียวที่ mutate ได้คือ
  `remainingAmount`
- `pointsLotConsumptions` = append-only allocation trace ("การใช้แต้มครั้งหนึ่งหักจาก lot ไหนบ้าง")
- `membership.pointsBalance` เป็นแค่ **cache** — source of truth จริงคือผลรวม `pointsLots.remainingAmount`
  (status=ACTIVE) — ต้อง update แบบ transactional คู่กับ ledger เสมอ
- Spend ใช้ **FIFO ตาม `expiresAt asc, createdAt asc`** (หมดอายุเร็วสุดใช้ก่อน) ภายใน **transaction เดียวจบ**
  — ถ้าไม่พอ throw ทั้ง transaction abort (ห้าม partial write)
- **ห้าม hard delete** points transaction — ผิดพลาดต้องใช้ Reversal pattern (Original → Reversal →
  Correct) เท่านั้น audit history ต้องอยู่ครบ
- Reversal ของ EARN ลด lot ต้นทาง (หรือสร้าง ADJUSTMENT ติดลบถ้า lot หมดแล้ว); Reversal ของ SPEND สร้าง
  **lot ใหม่** เสมอ ไม่พยายามคืนกลับ lot เดิม
- Manual Add Points โดย staff **ไม่ผ่าน Rule Engine** — กรอกตรงตาม Staff Limit
- Rule stacking: BASE rule เลือกได้ 1 ตัวต่อเหตุการณ์, MULTIPLIER default `HIGHEST_ONLY` (ต้อง opt-in
  `MULTIPLICATIVE` ชัดเจน), BONUS_EVENT เป็น `ADDITIVE` เสมอ
- ต้องมี Balance Reconciliation job รายคืนเทียบ lot sum กับ cached balance

---

## LINE / LIFF Security Constraints

- LIFF ผูกได้เฉพาะ **LINE Login Channel** เท่านั้น (ไม่ใช่ Messaging API Channel) — Provider หนึ่งมีทั้ง
  Messaging API Channel + LINE Login Channel ที่ link กัน
- **`liff.getProfile()` และค่าใดๆ จาก client ถือเป็น untrusted เสมอ** — ห้ามส่ง userId/profile จาก client
  SDK ตรงไปสร้าง/แก้ PlatformCustomer หรือ Membership
- Flow บังคับ: client ส่งเฉพาะ `id_token` → **Backend verify ID Token กับ LINE เสมอ** (aud=loginChannelId,
  iss, exp) → ใช้ `sub` จากผล verify เท่านั้นเป็น lineUserId จริง → ถ้า verify ล้มเหลว **ปฏิเสธทันที** ไม่สร้าง/
  แก้ไขอะไรทั้งสิ้น
- `resolveOrCreatePlatformCustomer()` ต้อง reject ถ้า `verified=false` สำหรับ provider `line`/`phone`/`email`
- Webhook LINE ต้อง **verify `x-line-signature` ทุก request** ก่อนประมวลผล ใช้ event/message ID ของ LINE
  เป็น idempotency key
- **ห้ามเก็บ LINE Secret/Access Token ใน client-accessible Firestore document เด็ดขาด** — เก็บ reference
  ไปยัง Secret Manager เท่านั้น (`lineChannelConfigs` ไม่มี client read)
- Business logic ของ Customer Portal **ห้ามเรียก `liff.*` ตรงจาก component/page** — ต้องผ่าน
  `LineClientProvider` interface (`login()`, `getIdToken()`, `getContext()`) เสมอ เพื่อเปิดทางย้ายไป
  LINE MINI App ในอนาคตได้โดยไม่รื้อ Customer Portal
- ไม่มี Public API สร้าง Provider/Channel ใหม่ — ขั้นตอนที่ต้องทำผ่าน Console โดยมนุษย์ (สร้าง OA,
  สร้าง Login Channel, Link OA เข้า Login Channel) ห้าม assume ว่า automate ได้

---

## Subscription / Entitlement Source of Truth

- `subscriptions/{merchantId}` คือ **Single Source of Truth เพียงจุดเดียว** ของ subscription state
  (`packageId`, `status`, `trialEndsAt`, `currentPeriodEnd`, `overrides`, `history`)
- `packages/{packageId}` จัดการโดย **Super Admin เท่านั้น**
- **`merchants/{merchantId}` ห้ามเก็บ `packageId`/`subscriptionStatus`/`trialEndsAt` ซ้ำเด็ดขาด** — default
  คือไม่มี cache field นี้เลย อ่าน `subscriptions/{merchantId}` ตรงทุกครั้ง — ถ้าจำเป็นต้อง cache ในอนาคต
  ต้องตั้งชื่อ `subscriptionStatusCache` และ sync ทางเดียวจาก Firestore Trigger เท่านั้น
- Entitlement คำนวณสดเสมอ: `merge(package.features/limits, subscription.overrides)` — ไม่เก็บเป็น state
- V1 ไม่มี Automatic Subscription Billing — Super Admin กำหนดผ่าน manual action เท่านั้น
- Limit behavior ต้องไม่ทำลาย UX: hard limit บล็อกเฉพาะ "สร้างใหม่" ไม่ลบ member/points; suspended
  merchant ยังให้ customer portal อ่านได้เสมอ

---

## Audit / Event / Idempotency Requirements

- **Event** (`events/{eventId}`) = business fact ที่เกิดแล้ว, ขับเคลื่อน Automation/Report — เขียนใน
  **transaction เดียวกับ state change เสมอ** (atomic)
- **Audit Log** (`auditLogs`) = ใครทำอะไรกับข้อมูลอะไร — แยกจาก Event ชัดเจน — เขียนได้จาก **server-side
  เท่านั้น**, **ห้าม update/delete แม้แต่ Super Admin ผ่าน Dashboard**, Super Admin เข้า Support/View-as-Owner
  Mode ต้อง audit ทุกครั้ง
- ทุก collection append-only (`pointsLedger`, `pointsLotConsumptions`, `auditLogs`, `events`,
  `automationActionExecutions`) — security rule อนุญาต create จาก server เท่านั้น ไม่มี update/delete จาก
  client เลย
- **Idempotency บังคับ** สำหรับ: Add Points, Redeem Reward, Redeem Coupon, Issue Coupon, Automation Action,
  Webhook — ใช้ `idempotencyKeys/{key}` เช็คภายใน transaction เดียวกับการเขียนจริงเสมอ — กดปุ่มซ้ำ/network
  retry **ต้องไม่ทำให้แต้ม/คูปองซ้ำ** ไม่ว่ากรณีใด
- Automation Action ใช้ deterministic `executionKey = hash(eventId, automationId, membershipId, actionIndex)`
  — at-least-once event delivery ต้องแปลงเป็น at-most-once execution ต่อ action เสมอ

---

## Phase Boundaries

Phase 1 (Foundation: RBAC/Tenant Isolation/Identity foundation, ไม่มี Points/Rewards/LINE UI) → Phase 2
(Merchant Setup + `LineClientProvider` skeleton) → Phase 3 (Points) → Phase 4 (Rewards) → Phase 5 (Coupons)
→ Phase 6 (Promotion/Automation) → Phase 7 (LINE, ต้อง spike LIFF Server API ก่อน) → Phase 8 (Reports) →
Phase 9 (Platform Admin) → Phase 10 (Hardening)

**ห้ามข้าม Phase โดยไม่ได้รับอนุมัติ — ห้ามเพิ่ม Feature นอก Scope ของ Phase ที่อนุมัติแล้ว**

รายละเอียดเนื้อหาแต่ละ Phase (files/exit criteria) อ้างอิง §33 ใน FINAL-ARCHITECTURE.md เสมอ ก่อนเริ่ม Phase
ใดๆ ต้องอ่านเอกสารทั้งหมดอีกครั้งและสรุป Implementation Plan ก่อนแก้ไฟล์จริง

---

## Development Workflow

ทุกครั้งก่อนเริ่ม Phase/งานใหม่ ต้องทำตามลำดับนี้ (Final Development Rule):

1. สรุปว่าจะทำอะไร
2. บอก Files/Collections ที่จะเพิ่มหรือแก้
3. บอก Security implications
4. บอก Test cases
5. **รอ Approval ก่อนเสมอ**
6. Implement
7. Run tests (typecheck, lint, unit tests, build)
8. สรุปผล
9. Commit เป็น logical checkpoint

---

## Testing Requirements

- **Tenant isolation**: login merchant A พยายามเข้าถึงข้อมูล merchant B ต้อง fail เสมอ + ปลอม `merchantId`
  ใน payload ต้องถูก server เพิกเฉย (บังคับตั้งแต่ Phase 1)
- **RBAC**: ทดสอบทั้ง Owner/Manager/Staff ตาม Permission Matrix V1
- **Race condition**: concurrent redeem coupon/reward เดียวกัน, staff ยิง request ขนานเกิน limit
- **Idempotency**: double-submit บน Add Points/Redeem ต้องไม่เกิดผลซ้ำ
- **LINE ID Token verification**: automated test บังคับก่อนถือว่า Phase 7 เสร็จ (Definition of Done)
- ทุก security-sensitive assumption **ต้องมี automated test ไม่ใช่แค่ design doc**

---

## Security Requirements

หลักการ: Least privilege, server-side authorization, tenant isolation, secure secret storage, no secrets
in frontend, input validation, rate limiting สำหรับ sensitive action, idempotency, audit logging, secure
webhook verification, secure LINE credential handling

Security Threat Checklist ที่ต้องตรวจก่อน production (ดูรายละเอียดเต็ม §26): cross-tenant access, ปลอม
`merchantId`/LINE userId ใน payload, privilege escalation ผ่าน custom claims, secret รั่วผ่าน
client-readable doc, webhook spoofing, double-submit, race condition บน redeem, staff เกิน limit ผ่าน
request ขนาน, automation runaway, broadcast spam, Super Admin support mode ไม่ audit, unverified
phone/email ใช้เป็น merge key

---

## ห้ามทำ / ห้ามเพิ่มนอก Scope (สรุปรวม)

- ห้ามใช้ Application Code จาก environment ทดลองก่อนหน้าเป็นฐานอ้างอิง
- ห้ามเปลี่ยน Core Business Rules เอง — ถ้าพบ requirement ขัดกัน/ไม่ปลอดภัย/มีทางออกดีกว่า **ต้องหยุดและ
  เสนอทางเลือกก่อน implement**
- ห้ามเพิ่ม Feature นอก Scope ของ Phase ที่อนุมัติ, ห้ามข้าม Phase โดยไม่ได้รับอนุมัติ
- ห้ามใส่ secrets จริงใน source code
- ห้าม trust ค่าใดๆ จาก client โดยตรงสำหรับ `merchantId`, `role`, LINE identity
- ห้าม hard-code: business logic เฉพาะประเภทร้าน, Staff Limits, Package Limits, Segment threshold,
  timezone เป็นไทยทั้งระบบ
- ห้าม auto-merge Customer Identity จาก LINE display name/รูปโปรไฟล์
- ห้ามแสดง Sales Revenue/Analytics
- ห้าม hard delete points transaction หรือ financial/loyalty event ใดๆ
- ห้ามแก้ Audit Log ไม่ว่าจากที่ใด
- ห้ามใส่ permission check กระจายตาม UI component
- ก่อนเพิ่ม library ใหม่ ต้องเสนอเหตุผลก่อนเสมอ
- V1 ห้ามมี: Full POS, Accounting, Inventory, AI (Chat/Image/Agent), Facebook/Instagram Integration, SMS,
  Native Mobile App, Marketplace, Cross-Merchant Marketing, Wallet, Customer Payment, Booking System

---

## Override Rule (ย้ำ)

ลำดับความสำคัญเมื่อพบข้อความขัดกัน (จากมากไปน้อย): **Permission Matrix V1 (locked) > Security Addendum v4
> LINE Architecture v3 > Revision v2 > Architecture v1** — ทั้งหมดนี้ถูก merge ไว้แล้วใน
`docs/architecture/FINAL-ARCHITECTURE.md` ซึ่งเป็นไฟล์เดียวที่ต้องอ่านเพื่อเข้าใจ architecture เต็มรูปแบบ

**ไฟล์นี้ (`CLAUDE.md`) เป็นสรุปช่วยจำเท่านั้น ไม่ใช่ source of truth — เมื่อไม่แน่ใจ ให้กลับไปอ่าน
`docs/architecture/FINAL-ARCHITECTURE.md` เสมอ**
