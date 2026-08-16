# FINAL-ARCHITECTURE.md
## Self-Service Multi-Tenant Loyalty Platform — Final Approved Architecture

**สถานะเอกสาร**: Final Approved Architecture — รวม Architecture v1 + Revision v2 + LINE Architecture v3 + Security Addendum v4 + Permission Matrix V1 (locked) เป็นฉบับเดียว ไม่มีความกำกวมระหว่างเวอร์ชัน

**วิธีอ่านเอกสารนี้**: เอกสารนี้ถูกออกแบบให้ **self-contained** — Claude Code session ใหม่ (หรือวิศวกรคนใหม่) ที่ไม่มีประวัติแชตใดๆ ควรอ่านไฟล์นี้ไฟล์เดียวแล้วเข้าใจ Architecture ทั้งหมดของโปรเจกต์ได้ โดยไม่ต้องอ้างอิงเอกสาร v1/v2/v3/v4 แยกอีกต่อไป (เอกสารเหล่านั้นยังเก็บไว้เป็น history/rationale แต่ **ไฟล์นี้คือ Source of Truth ปัจจุบัน**)

**หมายเหตุสำคัญเรื่อง Implementation**: มีการทดลองสร้าง Application Code ใน environment ทดลอง (Claude Desktop) มาก่อนหน้านี้ในช่วง "Phase 1" — **โค้ดชุดนั้นไม่ใช่ Source of Truth และไม่ควรใช้เป็นฐานอ้างอิง** GitHub repository จริงของโปรเจกต์นี้ยังว่างอยู่ และการ implementation จะเริ่มใหม่ทั้งหมดใน GitHub Codespaces โดยยึดตามเอกสารนี้เท่านั้น

**กฎการ Override**: เมื่อพบข้อความที่ขัดกันระหว่างส่วนต่างๆ ของโปรเจกต์ ให้ยึดลำดับความสำคัญดังนี้ (เรียงจากมีน้ำหนักมากสุด): **Permission Matrix V1 (locked) > Security Addendum v4 > LINE Architecture v3 > Revision v2 > Architecture v1**. เอกสารฉบับนี้ได้ทำการ merge ตามลำดับนี้ไว้ให้แล้วในทุกหัวข้อ

---

## สารบัญ

0. [Product Scope & V1 Exclusions](#0-product-scope--v1-exclusions)
1. [Technology Stack](#1-technology-stack)
2. [System Architecture](#2-system-architecture)
3. [Multi-Tenant Architecture & Tenant Isolation](#3-multi-tenant-architecture--tenant-isolation)
4. [Domain Model & Entity Relationships](#4-domain-model--entity-relationships)
5. [Firestore Data Model (Full Collection Reference)](#5-firestore-data-model-full-collection-reference)
6. [Global Customer Identity](#6-global-customer-identity)
7. [Merchant-Scoped Membership / Profile](#7-merchant-scoped-membership--profile)
8. [Authentication Architecture](#8-authentication-architecture)
9. [Permission Matrix V1 (LOCKED)](#9-permission-matrix-v1-locked)
10. [Authorization Enforcement & RBAC Principles](#10-authorization-enforcement--rbac-principles)
11. [Points Rules](#11-points-rules)
12. [Points Ledger + Lots + FIFO + Expiration + Reversal](#12-points-ledger--lots--fifo--expiration--reversal)
13. [Rewards / Vouchers](#13-rewards--vouchers)
14. [Coupons](#14-coupons)
15. [Visit / Activity Model](#15-visit--activity-model)
16. [Promotion / Automation](#16-promotion--automation)
17. [Event Model + Idempotency](#17-event-model--idempotency)
18. [Audit Log](#18-audit-log)
19. [LINE Architecture (OA + LINE Login + LIFF)](#19-line-architecture-oa--line-login--liff)
20. [LINE Merchant Onboarding Flow](#20-line-merchant-onboarding-flow)
21. [LINE ID Token Backend Verification](#21-line-id-token-backend-verification)
22. [LineClientProvider Abstraction](#22-lineclientprovider-abstraction)
23. [Notification Architecture](#23-notification-architecture)
24. [Reports](#24-reports)
25. [Subscription / Packages / Entitlements](#25-subscription--packages--entitlements)
26. [Security Requirements](#26-security-requirements)
27. [Idempotency Strategy (General)](#27-idempotency-strategy-general)
28. [Firestore Indexes](#28-firestore-indexes)
29. [Backup Strategy](#29-backup-strategy)
30. [Monitoring / Error Strategy](#30-monitoring--error-strategy)
31. [Project Structure (Next.js + Cloud Functions)](#31-project-structure-nextjs--cloud-functions)
32. [Cloud Functions / Backend Responsibilities](#32-cloud-functions--backend-responsibilities)
33. [Phase 1–10 Implementation Plan](#33-phase-110-implementation-plan)
34. [Development Rules and Prohibitions](#34-development-rules-and-prohibitions)
35. [Remaining Open Decisions](#35-remaining-open-decisions)
36. [Document Changelog](#36-document-changelog)

---

## 0. Product Scope & V1 Exclusions

### Product Principle

ระบบนี้คือ **Self-Service Multi-Tenant Loyalty Platform** สำหรับร้านค้าประมาณ 50 ร้านในระยะแรก — เจ้าของร้านสมัคร สร้างร้าน ตั้งค่าระบบสมาชิก เชื่อม LINE และเปิดใช้งานได้ด้วยตัวเองทั้งหมด โดยไม่ต้องให้ทีมงาน setup ให้ทีละร้าน

**นี่ไม่ใช่ POS และไม่ใช่ Accounting Software.** Core Product คือ **Membership + Loyalty + CRM Activity + Rewards + Coupons + Promotions + Automation + Reports** เท่านั้น ระบบต้องไม่แสดงหรืออ้างว่าเป็น Sales/Revenue Analytics เพราะไม่มีข้อมูลยอดขายจาก POS หรือ transaction source ที่เชื่อถือได้

### Initial Target

~50 merchants ระยะแรก: ร้านสนุกเกอร์/พูล, ร้านอาหาร, Cafe, ร้านนวด, Salon, Car Wash, Fitness และธุรกิจบริการที่มี repeat customers อื่นๆ **ระบบต้องไม่ hard-code logic สำหรับธุรกิจประเภทใดประเภทหนึ่ง** — business-specific behavior มาจาก configuration/template เท่านั้น

### V1 Exclusions — ห้ามเพิ่มเองโดยไม่ได้รับคำสั่งชัดเจน

Full POS, Accounting, Inventory Management, AI Chat, AI Image Generation, AI Agent, Facebook Integration, Instagram Integration, SMS, Native Mobile App, Marketplace, Cross-Merchant Marketing, Wallet, Customer Payment, Booking System

Extension point สำหรับสิ่งเหล่านี้ออกแบบไว้ได้ (เช่น POS Integration Layer ในหัวข้อ 32) แต่**ไม่ implement จริง**ใน V1

### Pilot Strategy

Phase 0 → internal test merchant, Phase 1 → 3 pilot merchants, Phase 2 → 10 paying merchants, Phase 3 → ~50 merchants — ออกแบบให้ดีพอสำหรับการขยาย แต่หลีกเลี่ยง premature infrastructure complexity (ไม่ optimize สำหรับ 1,000 merchants)

### Language & Timezone

ภาษาไทยเป็นหลักใน V1, architecture เตรียม i18n ไว้แต่ไม่ต้องแปลหลายภาษา — Timezone default คือ `Asia/Bangkok` แต่ระบบต้อง timezone-aware ไม่ hard-code เป็นเวลาไทยทั้งระบบ (รองรับขยายประเทศในอนาคต)

### Self-Service Priority Rule

ก่อนสร้าง feature ใดๆ ให้ถามเสมอ: **"Owner ร้านทั่วไปสามารถตั้งค่านี้เองได้หรือไม่ โดยไม่ต้องโทรหา Support?"** ถ้าไม่ได้ ให้ปรับ UX ก่อนเพิ่ม complexity — UI ต้องหลีกเลี่ยงศัพท์ technical (Webhook, Trigger Expression, JSON, Event Type, Tenant ID) และแสดงเป็นภาษาคน เช่น "เมื่อลูกค้าไม่ได้กลับมา 30 วัน" แทน `INACTIVE_CUSTOMER_TRIGGER`

---

## 1. Technology Stack

- **Frontend/Backend**: Next.js + TypeScript (App Router) — deploy บน **Firebase App Hosting** (เลือกแทน Vercel เพื่อลด cross-platform credential complexity กับ Firebase Admin SDK — ยืนยัน region/latency สำหรับผู้ใช้ไทยระหว่าง implement)
- **Auth**: Firebase Authentication
- **Database**: Firestore (primary datastore เดียว, ไม่ใช้ database-per-tenant)
- **Backend Compute**: Next.js Server/API Route + Firebase Cloud Functions ตามความเหมาะสมของแต่ละ operation (ดูหัวข้อ 32)
- **Storage**: Firebase Storage (media เช่น logo, cover, artwork)
- **Secrets**: Google Secret Manager (ไม่มี secret ใดๆ อยู่ใน source code หรือ client-accessible Firestore document)
- **LINE**: LINE Login, LIFF, LINE Messaging API (ดูหัวข้อ 19-22)
- **Reporting V1**: Firestore only — **ไม่ใช้ BigQuery ใน V1** (พิจารณาใหม่ถ้า report query ช้าเกินไปในอนาคต)
- **Explicitly NOT in V1**: POS Integration, AI (Chat/Image/Agent), Payment Gateway integration (มี extension point เท่านั้น)
- **Source control**: GitHub — implementation จะเริ่มใหม่ใน GitHub Codespaces

ก่อนเลือก library เพิ่มเติมนอกเหนือจากที่ระบุไว้ ให้เสนอเหตุผลก่อนเสมอ และหลีกเลี่ยง dependency ที่ไม่จำเป็น

---

## 2. System Architecture

### แนวคิดหลัก: Modular Monolith

ระบบเป็น **Modular Monolith บน Next.js + Firebase** ไม่ใช่ Microservices ตั้งแต่ต้น เพราะ scale เป้าหมาย (~50 ร้าน, สมาชิกรวมหลักหมื่นถึงแสนคน) ไม่จำเป็นต้องแยก service/deploy ซึ่งจะเพิ่ม operational overhead โดยไม่ได้ประโยชน์จริงกับทีมเล็ก

แบ่งเป็น 3 ชั้นตาม responsibility:

1. **Presentation Layer (Next.js App Router)** — 3 surface แยกกันตาม audience:
   - `/dashboard` — Merchant Owner/Manager/Staff
   - `/m/[merchantSlug]` — Customer Portal (เข้าถึงผ่าน LIFF)
   - `/superadmin` — Platform Super Admin

2. **Application/Domain Layer** — business logic แยกเป็น "modules" ตาม bounded context (Identity, Membership, Points, Reward, Coupon, Promotion/Automation, Notification, Report, Billing/Entitlement, Audit, Event) แต่ละ module มี service function ที่เรียกได้จาก API Route หรือ Cloud Function เท่านั้น — **ห้าม UI เขียน Firestore ตรงสำหรับ operation ที่มีผลต่อ business state** (points, coupon, reward, ฯลฯ)

3. **Data/Infra Layer** — Firestore, Cloud Functions (background jobs/triggers/scheduled tasks), Firebase Storage, Firebase Auth

### ทำไมไม่ใช้ Microservices

ทีมเล็ก, 50 merchants ไม่ต้องการ independent scaling ต่อ service — Modular monolith ยังคง separation of concern ผ่าน module boundary + shared library และย้ายเป็น service แยกทีหลังได้ถ้าจำเป็นจริง (เช่น ถ้า Automation Engine โตเร็วมาก)

### External Integration Boundary

ทุกการเชื่อมต่อภายนอก (LINE, POS ในอนาคต, Payment Gateway ในอนาคต) ต้องผ่าน **Adapter/Integration Layer** เสมอ — ห้าม Domain Logic เรียก external API ตรง (ดูหัวข้อ 19-23 สำหรับ LINE, หัวข้อ 32 สำหรับ future POS)

### Trade-offs

ข้อดี: deploy ง่าย, debug ง่าย, cost ต่ำ, เหมาะกับทีมเล็ก. ข้อเสีย: ถ้า Automation/Notification โตเร็วมากอาจต้องแยก worker service ออกไปภายหลัง (Cloud Functions รองรับการแยกได้อยู่แล้วเพราะเป็น process แยกจาก Next.js server)

---

## 3. Multi-Tenant Architecture & Tenant Isolation

### Hierarchy

```
Platform → Merchant → Branch → Owner/Manager/Staff → Membership → Loyalty Data
```

ทุก Merchant Data ต้องแยกจากกันอย่างเคร่งครัด — Merchant A ต้องไม่มีทางอ่านหรือแก้ข้อมูล Merchant B ได้ แม้ผู้ใช้แก้ URL, request payload, หรือ client-side code เอง

### หลักการ 3 ชั้น (บังคับทุกชั้น ไม่มีข้อยกเว้น)

1. **Schema level**: ทุก merchant-scoped collection มี `merchantId` field บังคับแบบ direct field (ไม่ใช่ join ผ่าน parent เท่านั้น)
2. **Security Rules level (defense-in-depth)**: ทุก collection merchant-scoped เช็ค `request.auth.token.merchantId == resource.data.merchantId` (staff) — ปฏิเสธ read/write ถ้าไม่ match; Security Rules **ไม่ใช่ primary boundary** — business-sensitive write ต้องผ่าน server code เท่านั้น
3. **Application level (primary boundary)**: ทุก service function รับ `merchantId` context จาก **authenticated session/verified custom claims เท่านั้น ไม่ใช่จาก request payload** — แม้ client ส่ง `merchantId` ปลอมมาใน body, server ต้อง derive merchantId จริงจาก custom claims เสมอและ ignore ค่าที่ client ส่งมา

### Single Firestore Database (ไม่ใช้ database-per-tenant)

ใช้ Firestore เดียวรวมทุก merchant + top-level collections + `merchantId` field เพื่อให้ query ข้าม entity ง่าย (เช่น Super Admin query ข้าม merchant) — **ไม่แนะนำ database-per-tenant** ที่ scale นี้เพราะเพิ่ม operational complexity มหาศาลโดยไม่จำเป็น (พิจารณาใหม่เฉพาะถ้ามี merchant enterprise tier ที่ต้องการ dedicated infrastructure ตามสัญญาในอนาคต)

### Automated Tests ที่บังคับต้องมี (Phase 1 และ Phase 10)

- Login merchant A → พยายามอ่าน/เขียน document ของ merchant B ด้วย id ที่เดา — ต้อง fail เสมอ (ใช้ Firestore auto-id หรือ ULID ไม่ใช้ sequential id)
- แก้ `merchantId` ใน request payload → ยืนยันว่า server เพิกเฉยและใช้ context ของ token แทน

---

## 4. Domain Model & Entity Relationships

### Core Aggregates

```
PlatformCustomer (Global Identity, ไม่มี PII)
  └─ customerIdentities[] (server-only index — provider/providerScope/subject)

Merchant
  ├─ Branch[]
  ├─ StaffUser[] (Owner/Manager/Staff)
  ├─ pointRules[]
  ├─ RewardTemplate[]
  ├─ CouponTemplate[]
  ├─ automations[] (ครอบคลุมทั้ง Automation และ Promotion)
  ├─ NotificationSettings
  ├─ BrandingConfig
  ├─ subscriptions/{merchantId} (1:1, single source of truth)
  └─ lineChannelConfigs/{merchantId} (Messaging API Channel + LINE Login Channel)

Membership (PlatformCustomer × Merchant — merchant-scoped)
  ├─ merchantProfile (displayName/phone/email เฉพาะร้านนี้)
  ├─ merchantLineIdentity (LINE identity เฉพาะร้านนี้)
  ├─ pointsBalance (cached, source of truth = pointsLots)
  ├─ activityStats (segment/lastVisitAt/ฯลฯ)
  ├─ VoucherInstance[] (Redeemed Reward)
  ├─ CouponInstance[]
  └─ tags[]
```

### หลักการออกแบบสำคัญ

- **Membership คือ join entity** ระหว่าง PlatformCustomer กับ Merchant — merchant-scoped data ทั้งหมด (points, coupon, reward, profile, history) attach เข้ากับ Membership **ไม่ attach เข้ากับ PlatformCustomer ตรงๆ** เพื่อรักษา isolation
- **Template vs Instance pattern** ใช้ซ้ำหลาย domain (Reward Template→Voucher Instance, Coupon Template→Coupon Instance) เพื่อแยก "กติกา" ออกจาก "สิ่งที่เกิดขึ้นจริงกับสมาชิกคนหนึ่ง" — จำเป็นสำหรับ Report ที่ต้องรู้ issued vs used vs expired แยกกัน
- **Points Ledger เป็น Event Log ไม่ใช่ state** — balance เป็น derived/cached value เท่านั้น (ดูหัวข้อ 12)
- **`pointsBalance` denormalize บน Membership** เพื่อ read performance — ต้อง update แบบ transactional คู่กับการเขียน ledger entry ทุกครั้ง

### Entity Relationships (Final)

```
PlatformCustomer 1───* customerIdentities (server-only index)
PlatformCustomer 1───* Membership *───1 Merchant
Membership 1───1 merchantProfile (embedded)
Membership 1───1 merchantLineIdentity (embedded, ผูกกับ merchant provider เดียวเท่านั้น)
Membership 1───* Visit
Membership 1───* pointsLots ───* pointsLotConsumptions *───1 pointsLedger (SPEND entries)
Membership 1───* pointsLedger
Membership 1───* VoucherInstance / CouponInstance
Merchant 1───* Branch
Merchant 1───* StaffUser
Merchant 1───* pointRules
Merchant 1───* RewardTemplate ───* VoucherInstance ───1 Membership
Merchant 1───* CouponTemplate ───* CouponInstance ───1 Membership
Merchant 1───* automations (ครอบคลุมทั้ง Automation และ Promotion) ───* automationActionExecutions
Merchant 1───1 subscriptions ───1 packages (referenced)
Merchant 1───1 lineChannelConfigs
```

**Key invariant**: ทุก entity ที่ไม่ใช่ `PlatformCustomer`/`customerIdentities` ต้องมี `merchantId` แบบ direct field เพื่อให้เขียน security rule และ query แบบ merchant-scoped ได้ตรงไปตรงมาในทุก collection

---

## 5. Firestore Data Model (Full Collection Reference)

นี่คือ schema ฉบับรวมล่าสุด (v1 base + v2/v3 diff รวมเข้าแล้ว) — **ใช้ตารางนี้เป็นฉบับ implement จริง**

```
platformCustomers/{customerId}
  - createdAt
  # ไม่มี PII ใดๆ โดยตั้งใจ — ดูหัวข้อ 6

customerIdentities/{identityId}
  # identityId = deterministicHash(provider, providerScope, normalizedSubject) — ใช้เป็น Document ID ตรงๆ
  - provider: 'line' | 'phone' | 'email'
  - providerScope: lineProviderId (บังคับสำหรับ provider='line' — ดูหัวข้อ 19) | null (สำหรับ phone/email)
  - providerSubjectHash
  - platformCustomerId
  - verifiedAt (null = unverified)
  - createdAt
  # Security Rule: deny-all client read/write — server-side เท่านั้น

merchants/{merchantId}
  - name, slug, businessType, branding{}, timezone
  - staffLimits{ maxPointsPerTransaction, maxPointsPerHour, maxPointsPerDay,
                 manualAdjustmentLimit, managerApprovalThreshold }
  - segmentRulesConfig{ inactiveAfterDays, atRiskAfterDays, regularMinVisits30d, ... }
  - ownerUserId, createdAt
  # ห้ามมี packageId/subscriptionStatus/trialEndsAt — อยู่ที่ subscriptions/{merchantId} เท่านั้น (หัวข้อ 25)

merchants/{merchantId}/branches/{branchId}
  - name, address, isActive

staffUsers/{staffUserId}          // top-level, indexed by merchantId
  - merchantId, authUid, role ('OWNER'|'MANAGER'|'STAFF'), permissionOverrides[], branchScope[]
  - status ('ACTIVE'|'SUSPENDED')

memberships/{membershipId}        // top-level: platformCustomerId + merchantId
  - platformCustomerId, merchantId, branchId (optional home branch)
  - memberCode, joinedAt
  - merchantProfile{ displayName, phone, email, consentMarketing,
                      profileSource: 'CUSTOMER_INPUT'|'STAFF_INPUT'|'LINE_PROFILE_AUTOFILL' }
  - merchantLineIdentity{ channelId, lineUserId, linkedAt, friendshipStatus } | null
  - pointsBalance (cached), pointsBalanceUpdatedAt
  - tags[], activityStats{ lastVisitAt, visitCount30d, visitCount90d, firstVisitAt,
                            segment: 'NEW'|'ACTIVE'|'REGULAR'|'VIP'|'AT_RISK'|'INACTIVE' }

pointRules/{ruleId}               // แทน merchant.pointsRuleConfig เดิม — หลายกติกาพร้อมกัน
  - merchantId, name, enabled
  - type: 'PER_UNIT'|'PER_VISIT'|'AMOUNT_BASED'|'BONUS_EVENT'|'MULTIPLIER'
  - role: 'BASE'|'MODIFIER'
  - branchScope[], startAt, endAt, priority
  - stackingPolicy: 'ADDITIVE'|'HIGHEST_ONLY'|'MULTIPLICATIVE'
  - config{} (เฉพาะ type — ดูหัวข้อ 11)
  - createdAt, updatedAt

pointsLedger/{entryId}            // top-level, immutable append-only — audit history
  - merchantId, membershipId, branchId
  - type: 'EARN'|'SPEND'|'ADJUSTMENT'|'REVERSAL'|'EXPIRATION'
  - delta, reason, sourceType, sourceRefId
  - appliedRules? [{ruleId, ruleName, contribution}]
  - actorType ('staff'|'system'|'customer'), actorId
  - reversedBy?, reversalOf?
  - createdAt, idempotencyKey

pointsLots/{lotId}                // 1 lot ต่อ 1 EARN entry (หรือ positive ADJUSTMENT/REVERSAL)
  - merchantId, membershipId, originLedgerEntryId
  - earnedAmount, remainingAmount (mutable เท่านั้น field นี้)
  - expiresAt (null = ไม่หมดอายุ)
  - status: 'ACTIVE'|'DEPLETED'|'EXPIRED'
  - createdAt

pointsLotConsumptions/{consumptionId}   // append-only allocation record
  - merchantId, membershipId, spendLedgerEntryId, lotId, amountConsumed, createdAt

idempotencyKeys/{key}
  - merchantId, operationType, resultRef, createdAt (TTL cleanup ~30 วัน)

visits/{visitId}
  - merchantId, membershipId, branchId
  - source: 'STAFF_SCAN'|'STAFF_SEARCH'|'MANUAL_ENTRY'|'AUTOMATION'
  - countsAsVisit: bool
  - relatedRefs{ pointsLedgerEntryId?, couponInstanceId?, voucherInstanceId? }
  - recordedAt, createdBy

rewardTemplates/{rewardId}
  - merchantId, requiredPoints, stock, limitPerMember, branchScope[]
  - startAt, endAt, voucherExpiryRule

voucherInstances/{voucherId}
  - merchantId, membershipId, rewardTemplateId
  - status: 'AVAILABLE'|'USED'|'EXPIRED'
  - redeemedAt, usedAt, usedByStaffId, usedBranchId

couponTemplates/{couponId}
  - merchantId, type, conditions{}, distribution rules

couponInstances/{instanceId}
  - merchantId, membershipId, couponTemplateId, issuedVia
  - status: 'AVAILABLE'|'USED'|'EXPIRED'
  - issuedAt, expiresAt, usedAt, usedByStaffId

automations/{id}                  // Single Source of Truth — ครอบคลุมทั้ง Automation และ Promotion
  - merchantId
  - trigger{ type: 'MEMBER_CREATED'|'BIRTHDAY'|'POINTS_REACHED'|'INACTIVE_DAYS'|
             'COUPON_EXPIRING'|'COUPON_REDEEMED'|'REWARD_REDEEMED'|'SCHEDULE' }
    // `BIRTHDAY` — DEFERRED, Phase 6 Architecture Decision (Locked). Type kept in the union for
    // forward compatibility only; no `merchantProfile.birthDate` (or any birth-date field) exists
    // anywhere in this schema. See หัวข้อ 16 "BIRTHDAY — Deferred for Phase 6" for the full locked
    // decision.
  - conditions[{ field, operator, value }]
  - actions[{ type: 'ADD_POINTS'|'ISSUE_COUPON'|'ISSUE_REWARD'|'ADD_TAG'|
              'CHANGE_TIER'|'SEND_NOTIFICATION'|'NOTIFY_OWNER', params{} }]
    // `CHANGE_TIER` — DEFERRED, Phase 6 Architecture Decision (Locked). Type kept in the union for
    // forward compatibility only; no Membership Tier system exists. See หัวข้อ 16 "CHANGE_TIER —
    // Deferred for Phase 6" for the full locked decision.
  - limits{ maxExecPerCustomerPerDay, maxExecPerPromotion, pointBudget, couponBudget, cooldownHours }
  - presentedAs: 'AUTOMATION'|'PROMOTION'  // label เท่านั้น ไม่กระทบ execution
  - marketing?{ title, description, bannerImageUrl, visibleInCustomerPortal }  // เฉพาะ presentedAs='PROMOTION'
  - status: 'DRAFT'|'TEST'|'ACTIVE'|'PAUSED'|'ENDED'
  - lastTestRunSnapshot

automationActionExecutions/{executionKey}   // executionKey = deterministicHash(eventId, automationId, membershipId, actionIndex)
  - merchantId, eventId, automationId, membershipId, actionIndex, actionType
  - status: 'EXECUTED'|'SKIPPED_LIMIT'|'FAILED'
  - resultRef, createdAt

events/{eventId}                  // business event log
  - merchantId, type, payload{}, membershipId?, schemaVersion, processingStatus?, createdAt

auditLogs/{logId}                 // append-only, server-only
  - merchantId, actorType ('staff'|'superAdmin'|'system'), actorId
  - action, targetType, targetId, before{}, after{}, reason?
  - metadata{ ip?, userAgent?, requestId }
  - createdAt

notificationSettings/{merchantId}
notificationLog/{logId}
  - merchantId, membershipId, channel, templateType, status, error?

lineChannelConfigs/{merchantId}   // ไม่มี client read — ดูหัวข้อ 19
  - lineProviderId
  - messagingChannel{ channelId, channelSecretRef, accessTokenRef, status }
  - loginChannel{ channelId, channelSecretRef, accessTokenRef, liffId, status }
  - linkedVerifiedAt
  - overallStatus: 'CONNECTED'|'PARTIAL'|'DISCONNECTED'|'ERROR'

reports/{reportId}
  - merchantId, type ('daily'|'weekly'|'monthly'), periodStart, periodEnd
  - snapshotData{} (frozen), generatedAt, deliveredChannels[]

merchantDailyStats/{merchantId_date}   // aggregate cache สำหรับ Dashboard real-time KPI

systemHealth/{component}          // Database/LINE/AutomationWorker/Scheduler/Reports/Auth/ErrorJobs

supportTickets/{ticketId}

packages/{packageId}              // จัดการโดย Super Admin เท่านั้น
  - name, memberLimit, staffLimit, branchLimit, features{}, price

subscriptions/{merchantId}        // Single Source of Truth ของ subscription state
  - packageId, status: 'TRIAL'|'ACTIVE'|'PAST_DUE'|'GRACE'|'SUSPENDED'|'CANCELLED'
  - trialEndsAt, currentPeriodEnd
  - overrides?{ memberLimit?, staffLimit?, branchLimit? }
  - history[{ from, to, changedBy, changedAt, reason }]
```

### เหตุผลสำคัญที่ต้องยึด

- LINE token/secret ของทั้งสอง channel **ไม่เก็บใน document ที่ client อ่านได้เลย** — เก็บ reference ไปยัง Secret Manager เท่านั้น
- `pointsLedger`, `pointsLotConsumptions`, `auditLogs`, `events`, `automationActionExecutions` เป็น **append-only** — security rule อนุญาต create จาก server context เท่านั้น ไม่มี update/delete จาก client เลย
- `platformCustomers`/`customerIdentities` เป็น **deny-all client access ทั้งหมด 100%** ไม่มีข้อยกเว้นแม้แต่ Super Admin ผ่าน client SDK

### สิ่งที่เปลี่ยนจาก v1 (สรุป diff)

**เพิ่มใหม่**: `customerIdentities`, `pointsLots`, `pointsLotConsumptions`, `pointRules`, `visits`, `automationActionExecutions`
**ลบออก**: `promotions` (รวมเข้า `automations`), `merchants.pointsRuleConfig` (แทนด้วย `pointRules`), `identityLinks` array บน `platformCustomers` (แทนด้วย `customerIdentities`)
**แก้ไข**: `platformCustomers` เหลือแค่ `createdAt`; `memberships` เพิ่ม `merchantProfile`/`merchantLineIdentity`/`activityStats`; `merchants` ตัด subscription fields ออก; `automations` เพิ่ม `presentedAs`/`marketing`/`status`; `pointsLedger` เพิ่ม `type`/`appliedRules`; `lineChannelConfigs` เก็บ 2 channel แทน 1

---

## 6. Global Customer Identity

### ปัญหาที่ต้องแก้ (จาก draft แรกสุด)

Global Customer Identity **ห้ามผูกกับ LINE userId โดยตรง** เพราะ LINE userId เป็นค่าที่ unique ต่อ **Provider** (ไม่ใช่ต่อบุคคลข้าม merchant) — ลูกค้าคนเดียวกันที่ใช้ LINE กับ merchant คนละ Provider จะได้ userId ต่างกันเสมอ **ห้าม assume ว่า LINE userId เดียวกันใช้ข้าม Merchant ได้**

### แนวคิด — แยก 3 concept ออกจากกันชัดเจน

```
PlatformCustomer          → Global Platform Identity (ไม่มี PII)
customerIdentities        → Index สำหรับ resolve/merge identity (server-only)
Membership                → ความสัมพันธ์เฉพาะ Merchant หนึ่งราย
MerchantLineIdentity      → LINE identity เฉพาะร้านนั้น (อยู่ใน Membership)
```

**หลักการล็อก**: LINE userId ที่ได้จาก merchant หนึ่ง **ไม่ถูกใช้เป็น key ของ Global Identity โดยตรง** ใช้เป็นแค่ `merchantLineIdentity` ที่ผูกกับ Membership เดียวเท่านั้น การเชื่อม PlatformCustomer เดียวกันข้าม merchant ทำผ่านช่องทางที่ verify ได้จริง (เบอร์โทร/อีเมล) เท่านั้น

### Identity Index — Deterministic ID + Idempotent Resolve/Create

```
customerIdentities/{identityId}
  identityId = deterministicHash(provider, providerScope, normalizedSubject)
```

เพราะ `identityId` เป็น deterministic hash (ไม่ใช่ auto-id) การ resolve/create จึงทำได้ปลอดภัยด้วย Firestore Transaction แบบ read-then-conditional-create:

```
function resolveOrCreatePlatformCustomer(provider, providerScope, subject, verified):
  identityId = sha256(`${provider}:${providerScope ?? ''}:${normalize(subject)}`)
  return runTransaction(tx => {
    existing = tx.get(customerIdentities/{identityId})
    if existing.exists: return existing.data().platformCustomerId
    newCustomerId = newId()
    tx.create(platformCustomers/{newCustomerId}, { createdAt })
    tx.create(customerIdentities/{identityId}, {
      provider, providerScope, providerSubjectHash: hash(subject),
      platformCustomerId: newCustomerId, verifiedAt: verified ? now : null, createdAt
    })
    return newCustomerId
  })
```

สอง request ที่ล็อกอินพร้อมกันด้วย identity เดียวกัน (เช่น double-tap ปุ่ม login) จะชน document เดียวกัน — Firestore transaction รับประกันว่ามีแค่ transaction เดียวที่ `create` สำเร็จ อีกอันเห็นว่า document มีอยู่แล้วเมื่อ retry (auto-retry ของ SDK) จึงไม่มีทางสร้าง PlatformCustomer ซ้ำจาก race condition

**สำคัญ**: สำหรับ `provider !== 'manual'` (คือ `line`/`phone`/`email`) ค่า `subject` ที่ส่งเข้าฟังก์ชันนี้ **ต้องเป็นค่าที่ backend verify แล้วเท่านั้น** — ห้ามรับค่าดิบจาก client (ดูหัวข้อ 21)

### PlatformCustomer เก็บอะไร

เก็บ**น้อยที่สุดโดยตั้งใจ** — ไม่มี PII:

```
platformCustomers/{id}
  - createdAt
  # ไม่มี name/phone/email ระดับ platform — อยู่ที่ memberships.merchantProfile เท่านั้น
```

เหตุผล: ลด attack surface และตอบโจทย์ privacy — "Merchant ห้ามอ่าน Global Customer Profile โดยตรง" ทำได้ง่ายที่สุดเมื่อไม่มี Global Profile ที่มีสาระให้อ่านตั้งแต่แรก

### Cross-Merchant Identity Linking — Opt-in ผ่าน Verified Phone/Email เท่านั้น

โดย default ลูกค้าที่สมัครที่ merchant A และ merchant B จะได้ **PlatformCustomer แยกกัน** (ปลอดภัยที่สุด ไม่ auto-merge) — ถ้าลูกค้าต้องการให้บัญชีทุกร้านเห็นเป็นบัญชีเดียวกันในสายตาแอป (เพื่อสลับดูได้ง่าย ไม่ใช่การแชร์ข้อมูลข้ามร้าน) ต้อง:

1. กด "เชื่อมบัญชี" ใน Portal → กรอกเบอร์โทร → รับ OTP → verify
2. `resolveOrCreatePlatformCustomer(provider='phone', providerScope=null, subject=normalizedPhone, verified=true)`
3. ถ้าเบอร์นี้เคย verify แล้วที่ merchant อื่นมาก่อน → Membership ที่เพิ่งสร้างถูกย้ายให้ชี้ไปที่ `platformCustomerId` เดิมแทน (ไม่ merge ข้อมูลแต้ม/คูปองใดๆ — Membership ยัง merchant-scoped 100% เหมือนเดิม มีแค่ "เจ้าของ" ที่ชี้ไปที่ PlatformCustomer เดียวกัน)

**ห้าม auto-merge จาก LINE Display Name/รูปโปรไฟล์** — เปลี่ยนได้ ปลอมได้ ไม่ใช่ verified identity ใช้เป็น auto-merge key จะเสี่ยง merge ผิดคนหรือถูกใช้เป็นช่องโหว่

การ merge นี้**ไม่กระทบ Data Isolation**เลย — Merchant A ยังคงไม่เห็นข้อมูล Merchant B เหมือนเดิมทุกประการ แม้ระบบจะ "รู้" ว่าเป็นคนเดียวกันในระดับ platform

---

## 7. Merchant-Scoped Membership / Profile

Membership ไม่ใช่แค่ join entity แต้ม/คูปอง แต่เป็นที่เก็บ **profile ที่ merchant นั้นเห็นได้เท่านั้น**:

```
memberships/{membershipId}
  - platformCustomerId, merchantId, branchId (home branch, optional)
  - memberCode
  - merchantProfile{ displayName, phone, email, consentMarketing,
                      profileSource: 'CUSTOMER_INPUT'|'STAFF_INPUT'|'LINE_PROFILE_AUTOFILL' }
  - merchantLineIdentity{ channelId, lineUserId, linkedAt, friendshipStatus }
  - pointsBalance, pointsBalanceUpdatedAt (cache — source of truth = pointsLots)
  - tags[], activityStats{}
  - joinedAt
```

**Staff Search (Name/Phone/Member ID)** ทำงานบน `memberships` collection กรอง `merchantId` เสมอ — query ไม่มีทางแตะ `platformCustomers`/`customerIdentities` เลย ตอบโจทย์ว่า Staff เห็นได้แค่ profile ที่กรอกไว้กับร้านตัวเอง

### Privacy / Data Isolation Model

| ข้อมูล | เก็บที่ | ใครอ่านได้ |
|---|---|---|
| ตัวตนกลาง (มีบัญชีเดียวกันหลายร้านหรือไม่) | `platformCustomers` + `customerIdentities` | Server-side เท่านั้น — **ไม่มี client อ่านได้เลย แม้แต่ Super Admin ผ่าน UI ปกติ** |
| ชื่อ/เบอร์/อีเมลที่ลูกค้าใช้กับร้าน A | `memberships/{A}.merchantProfile` | Staff/Owner ของร้าน A เท่านั้น |
| ชื่อ/เบอร์/อีเมลที่ลูกค้าใช้กับร้าน B | `memberships/{B}.merchantProfile` | Staff/Owner ของร้าน B เท่านั้น |
| แต้ม/คูปอง/ประวัติ | ผูกกับ Membership ของแต่ละร้าน | เฉพาะร้านนั้น |

แม้ระบบจะ "รู้" ว่า Membership A และ B เป็นคนเดียวกัน (ผ่าน `platformCustomerId` ที่ตรงกันหลัง merge ด้วยเบอร์โทร) **ก็ไม่มี query path หรือ UI ใดที่ให้ Staff ร้าน A มองเห็นแล้ว join ไปดู Membership ของร้าน B ได้** — Security Rule และ API layer ปิดทุก cross-membership query ที่ไม่ได้ filter ด้วย `merchantId` ของตัวเอง

---

## 8. Authentication Architecture

### ผู้ใช้ 3 กลุ่ม แยก Auth Context

1. **Staff/Owner** — Firebase Auth (email/password หรือ Google) → custom claims: `{ merchantId, role, staffUserId, branchScope }` เซ็ตผ่าน **Firestore Trigger เดียว** ที่ react ต่อการเขียน `staffUsers/{id}` เท่านั้น (ห้าม client set claims เอง, ห้ามมี code path อื่นตั้ง claims)
2. **Customer (Member)** — LINE Login/LIFF เป็นทางหลัก, รองรับ phone/OTP เป็นทางเลือกสำรอง (เพราะห้ามผูก Customer Identity กับ LINE เพียงอย่างเดียว) → หลัง verify แล้ว map เข้า Firebase Custom Token ที่ผูกกับ `platformCustomerId`
3. **Super Admin** — Firebase Auth + custom claim `{ superAdmin: true }` จัดการนอก self-service flow (สร้างผ่าน script/console เท่านั้น ไม่มี UI สมัคร)

### Flow: Customer ผ่าน LINE (รายละเอียดเต็มในหัวข้อ 20-21)

```
LIFF (ผูกกับ LINE Login Channel ของ merchant) → LINE Login → id_token
→ Backend verify id_token กับ LINE โดยตรง (ห้ามเชื่อ client)
→ resolveOrCreatePlatformCustomer(provider='line', providerScope=lineProviderId, subject=verified sub, verified=true)
→ หา/สร้าง Membership สำหรับ merchant นั้น
→ ออก Firebase Custom Token (uid = platformCustomerId)
→ Client signInWithCustomToken
```

### เหตุผลที่ใช้ Custom Token แทน LINE token ตรงๆ

Firestore Security Rules อ่านได้แค่ Firebase Auth token — ต้องแปลง LINE identity เป็น Firebase identity แบบ server-controlled เพื่อให้ rule ตรวจสอบ `request.auth.uid` ได้อย่างปลอดภัย

### ข้อจำกัดที่ต้องรู้

- Custom claims มีขนาดจำกัด (< 1000 bytes) — v1 สมมติ staff 1 คนต่อ 1 merchant เพื่อความง่าย (multi-merchant staff เป็น future — ดูหัวข้อ 35)
- Custom claims cache ฝั่ง client จนกว่าจะ refresh token — ต้อง force refresh token หลังเปลี่ยน role/permission หรือหลังสมัคร merchant ใหม่

### Staff/Owner API Authentication Transport (Phase 2 Architecture Decision — Resolved, 2026-08-15)

**ขอบเขต**: มตินี้ครอบคลุมเฉพาะวิธีที่ Staff/Owner authenticate เข้า Next.js API Routes เท่านั้น — ไม่กระทบ Customer/LINE flow ด้านบน (ยังใช้ Firebase Custom Token + `signInWithCustomToken` ตามเดิมทุกประการ) และไม่กระทบ Super Admin เอกสารฉบับก่อนหน้านี้ไม่เคยระบุ transport mechanism ที่เป็นรูปธรรมสำหรับ Staff/Owner API call ไว้เลย (มีแค่หลักการทั่วไปใน §3: "authenticated session/verified custom claims") — มตินี้เติมช่องว่างนั้นสำหรับ Phase 2 โดยไม่ override ข้อความใดที่มีอยู่เดิม:

```
Firebase Client Auth (email/password หรือ Google)
  → getIdToken() ผ่าน Firebase Auth SDK เท่านั้น
  → shared authenticated API client แนบ header ก่อนทุก request:
      Authorization: Bearer <Firebase ID Token>
  → Next.js API Route
  → Firebase Admin verifyIdToken() (reject ถ้า invalid/expired/revoked)
  → verified uid → resolve StaffUser server-side จาก uid (ไม่ใช่จาก client input)
  → buildAuthContext() (หัวข้อ 10) → Authorization Service (RBAC + tenant isolation) ตามเดิม
```

**Security constraints (ยึดหลักการเดิมของเอกสารทั้งฉบับ — ไม่ใช่กฎใหม่ เป็นการนำหลักการเดิมมาระบุให้เจาะจงกับ transport นี้)**:

- ห้าม trust `uid` จาก request body/query/header อื่นใดนอกจากผลของ `verifyIdToken()` เท่านั้น
- ห้าม trust `role`/`permissions` จาก client โดยเด็ดขาด — resolve จาก StaffUser document + custom claims ฝั่ง server เสมอ (§9, §10)
- ห้าม trust `merchantId` จาก client เพื่อใช้ authorize คำขอ — merchant context ใดๆ ที่ client ส่งมาถือเป็นแค่ "requested resource" เท่านั้น ต้อง validate สิทธิ์จริงต่อ merchant นั้นฝั่ง server เสมอผ่าน `requirePermission()`/`requireOwner()` (§3, §10) เหมือนที่ Phase 1 Authorization Service ทำอยู่แล้ว
- ทุก protected API route ต้อง verify Firebase ID Token ฝั่ง server ก่อนเสมอ ไม่มีข้อยกเว้น
- Token persistence/lifecycle (เก็บ, refresh, revoke) เป็นหน้าที่ของ Firebase Auth SDK ทั้งหมด — **ห้ามเก็บ ID Token เองใน `localStorage`/`sessionStorage`**; shared API client ดึง token สดผ่าน SDK ก่อนแนบทุก request เท่านั้น
- V1 (Phase 2) ยังไม่ใช้ custom session cookie สำหรับ flow นี้ — ใช้ Bearer ID Token ตรงทุกครั้ง จนกว่าจะมีเหตุผลด้าน security/UX ที่ต้องเปลี่ยนและได้รับการอนุมัติใหม่

**เหตุผลที่ไม่ขัดกับ Architecture เดิม**: รูปแบบนี้เป็นการนำหลักการที่ล็อกไว้แล้วมาปรับใช้กับ transport ที่เป็นรูปธรรม — server เป็น authority เดียวสำหรับ identity เสมอ (§3, §10, §26), ไม่ trust ค่าใดๆ จาก client โดยตรง (หลักการเดียวกับ §21 LINE ID Token verification ที่ใช้กับฝั่ง Customer), และไม่มีข้อความใดในเอกสารฉบับนี้กำหนดหรือห้าม transport mechanism แบบใดแบบหนึ่งไว้เป็นการเฉพาะสำหรับ Staff/Owner API มาก่อน

---

## 9. Permission Matrix V1 (LOCKED)

**เอกสารนี้คือฉบับล็อกล่าสุด** — override ข้อความ "Permission list ตามข้อ 24" ที่กว้างๆ ใน Architecture v1 เดิมทั้งหมด ห้ามแก้ไขโดยไม่ได้รับการอนุมัติใหม่อย่างชัดเจน

### Owner — Role สูงสุด, Full Merchant Access

- Full merchant access
- View / Search / Create Members
- Add / Adjust / Reverse Points
- View Points History
- Redeem Rewards / Coupons
- Create/Edit Rewards, Coupons, Promotions, Automations
- Broadcast
- View Reports และ Staff Activity
- Manage Staff
- Manage Permissions
- Manage Merchant Settings / Branding
- Manage LINE Connection
- Manage Package / Billing

### Manager — Full Operational Control ยกเว้น Owner-Only Powers

- View / Search / Create Members
- Add / Adjust / Reverse Points
- View Points History
- Redeem Rewards / Coupons
- Create/Edit Rewards, Coupons, Promotions, Automations
- Broadcast
- View Reports และ Staff Activity
- Manage Staff
- Manage Merchant operational settings / branding
- **ห้ามเปลี่ยน Owner**
- **ห้ามแก้ Owner permissions**
- **ห้ามจัดการ LINE credentials**
- **ห้ามจัดการ Package/Billing**
- **ห้ามปิด/ลบ Merchant**

### Staff — Counter Operations เท่านั้น

- View / Search / Create Members
- Add Points ตาม Rule (ผ่าน Points Rule Engine ปกติ)
- Manual Add Points เฉพาะภายใน Staff Limit
- View Points History
- Redeem Rewards
- Redeem Coupons
- **ห้าม Adjust/Reverse Points**
- **ห้ามสร้าง Reward/Coupon/Promotion/Automation**
- **ห้าม Broadcast**
- **ห้ามดู Management Reports**
- **ห้าม Manage Staff/Permissions/Settings/LINE/Billing**

### Staff Limits — Config-Driven (ห้าม Hard-code)

เก็บที่ `merchants/{id}.staffLimits` ต่อ merchant:

- `maxPointsPerTransaction`
- `maxPointsPerHour`
- `maxPointsPerDay`
- `manualAdjustmentLimit`
- `managerApprovalThreshold`

ตรวจใน service layer **ภายใน transaction เดียวกับการเขียน points ledger entry ทุกครั้ง** ไม่ใช่ check-then-write แบบแยก step (ป้องกัน race condition — ดูหัวข้อ 26 Security Threat Checklist)

---

## 10. Authorization Enforcement & RBAC Principles

### หลักการบังคับใช้ (บังคับ — ไม่มีข้อยกเว้น)

**Backend ตรวจ permission ทุกครั้งจาก custom claims + StaffUser document เสมอ ผ่าน Centralized Authorization Service เดียว** — Frontend ใช้ permission list แค่เพื่อซ่อน/แสดง UI (UX เท่านั้น ไม่ใช่ security boundary) **ห้ามใส่ permission check กระจายตาม UI component**

Authorization Service ต้องมี capability อย่างน้อย:
- `requirePermission(ctx, permission, resourceMerchantId)` — ตรวจทั้ง permission และ tenant match ในฟังก์ชันเดียว (throw `AuthorizationError` หรือ `TenantIsolationError` แยกประเภทกัน)
- `requireOwner(ctx, resourceMerchantId)` — guard สำหรับ action ที่ Manager ทำไม่ได้แม้จะมี MANAGE_STAFF กว้างๆ (เช่น แก้ Owner เอง)
- `requireBranchScope(staff, branchId)` — สำหรับ staff ที่ scope เฉพาะบางสาขา

### Firestore Security Rules = Defense-in-Depth ชั้นที่สอง

สำหรับ read/write ที่ไม่ได้ผ่าน Cloud Function/API Route (เช่น real-time listener อ่านข้อมูลของตัวเอง) — operation ที่มีผลต่อ business state (points, redeem) **ต้องบังคับให้ผ่าน server เท่านั้น ไม่เปิด client write ตรงบน collection เหล่านั้นเลย**

### สรุป Tenant Isolation ที่ผูกกับ Authorization (ย้ำจากหัวข้อ 3)

ทุกครั้งที่เรียก `requirePermission()` ต้องส่ง `resourceMerchantId` ที่มาจาก **data ที่โหลดจาก server แล้วเท่านั้น** (เช่น document ที่กำลังจะแก้) ไม่ใช่จาก unvalidated client input — ทำให้ authorization check และ tenant isolation check เป็นเรื่องเดียวกันเสมอ

---

## 11. Points Rules

ต้องรองรับ**หลายกติกาพร้อมกัน** ไม่ใช่ config เดียว:

```
pointRules/{ruleId}
  - merchantId, name, enabled
  - type: 'PER_UNIT' | 'PER_VISIT' | 'AMOUNT_BASED' | 'BONUS_EVENT' | 'MULTIPLIER'
  - role: 'BASE' | 'MODIFIER'
  - branchScope[] (empty = all branches)
  - startAt, endAt (null = ไม่มีกำหนด)
  - priority (number, ค่าน้อย = สำคัญกว่าเมื่อ config ชนกัน)
  - stackingPolicy: 'ADDITIVE' | 'HIGHEST_ONLY' | 'MULTIPLICATIVE' (มีความหมายเฉพาะกับ role=MODIFIER)
  - config{}:
      PER_UNIT:     { unit: 'HOUR'|'MINUTE', pointsPerUnit }
      PER_VISIT:    { pointsPerVisit }
      AMOUNT_BASED: { pointsPer, amountPer }   // เตรียมไว้ ยังไม่ใช้จริงจนมี trusted amount source (POS ในอนาคต)
      BONUS_EVENT:  { event: 'NEW_MEMBER'|'BIRTHDAY', points, multipliable: bool }
      MULTIPLIER:   { factor, dayOfWeek: [0-6], timeRange: {start,end}, appliesToRoles: ['BASE'] }
  - createdAt, updatedAt
```

`role: BASE` (PER_UNIT/PER_VISIT/AMOUNT_BASED) กำหนด "แต้มตั้งต้น" — `role: MODIFIER` (MULTIPLIER, BONUS_EVENT) ปรับผลลัพธ์เพิ่มเติม — **Manual Add Points โดย staff ไม่ผ่าน Rule Engine เลย** (staff กรอกจำนวนตรงๆ ตาม Staff Limit)

### Rule Stacking Algorithm (Deterministic, ปลอดภัยเป็น Default)

1. **BASE rule เลือกได้แค่ 1 ตัวต่อเหตุการณ์** — จับคู่ตาม `type` ที่ตรงกับ source ของเหตุการณ์ ถ้ามีมากกว่า 1 rule ชนกัน UI ต้องป้องกันไม่ให้ Owner สร้าง BASE rule ที่ scope ซ้อนทับกันตั้งแต่ config-time; ถ้าหลุดรอด ใช้ `priority` ต่ำสุดชนะ + log warning
2. **MULTIPLIER default คือ `HIGHEST_ONLY`** — ถ้ามีหลาย multiplier active พร้อมกัน ใช้ตัวคูณสูงสุดตัวเดียว ไม่คูณต่อกัน (ป้องกัน Owner ตั้งค่าพลาดจนแจกแต้มเกินจริงแบบ exponential) — Owner ต้องตั้ง `stackingPolicy: 'MULTIPLICATIVE'` อย่างชัดเจนที่ rule นั้นถึงจะคูณต่อกันได้ (opt-in)
3. **BONUS_EVENT เป็น `ADDITIVE` เสมอ** — บวกตรงๆ ไม่ว่าจะมีกี่ตัว
4. **BONUS ถูกคูณด้วย Multiplier หรือไม่ ขึ้นกับ flag `multipliable`** (default false) — ป้องกันความประหลาดใจ

```
basePoints = evaluate(matched BASE rule)
effectiveMultiplier = HIGHEST_ONLY: max(matched MULTIPLIER.factor)
                       หรือ MULTIPLICATIVE: product(matched MULTIPLIER.factor ที่ตั้ง MULTIPLICATIVE)
bonusPoints = Σ matched BONUS_EVENT rules, each ? (bonus.multipliable ? bonus.points × effectiveMultiplier : bonus.points)
finalPoints = round(basePoints × effectiveMultiplier) + bonusPoints
```

ทุกครั้งที่คำนวณ บันทึก breakdown ลงใน ledger entry เดียว (`appliedRules: [{ruleId, ruleName, contribution}]`) — คำนวณและตัดสินใจทั้งหมดที่ server-side ภายใน transaction เดียวกับการเขียน ledger

---

## 12. Points Ledger + Lots + FIFO + Expiration + Reversal

### หลักการสูงสุด: Ledger เป็น Source of Truth, Lot เป็น Working State, Balance เป็น Cache

```
pointsLedger/{entryId}    // immutable audit history — ห้ามแก้ย้อนหลังเด็ดขาด
  - type: 'EARN'|'SPEND'|'ADJUSTMENT'|'REVERSAL'|'EXPIRATION'
  - delta, reason, sourceType, sourceRefId, appliedRules?, actorType, actorId, idempotencyKey
  - reversalOf? / reversedBy?

pointsLots/{lotId}        // 1 lot ต่อ 1 EARN entry — FIFO working state
  - originLedgerEntryId, earnedAmount, remainingAmount (mutable field เดียว)
  - expiresAt, status: 'ACTIVE'|'DEPLETED'|'EXPIRED'

pointsLotConsumptions/{consumptionId}   // append-only allocation trace
  - spendLedgerEntryId, lotId, amountConsumed
```

**เหตุผลที่ต้องมี Lot แยกจาก Ledger**: Ledger เก็บแค่ `delta` รวมไม่พอสำหรับ FIFO expiration (ตัวอย่าง: Jan +10 exp 1 เม.ย., Feb +10 exp 1 พ.ค., ใช้ -7 → ต้องรู้ว่า Jan lot เหลือ 3 ไม่ใช่หักจาก pool รวม) — Ledger ตอบว่า "เกิดอะไรขึ้น" (ห้ามแก้ย้อนหลัง), Lot ตอบว่า "แต้มก้อนไหนเหลือเท่าไหร่" (ต้อง mutate ได้), Consumption ตอบว่า "การใช้แต้มครั้งหนึ่งหักจาก lot ไหนบ้าง" (สืบย้อนได้ 100% โดยไม่แก้ประวัติเดิม)

### Spend Flow (FIFO Consumption — Transaction เดียวจบ)

```
runTransaction:
  1. read membership.pointsBalance → pre-check >= spendAmount
  2. query pointsLots: merchantId, membershipId, status=ACTIVE,
     order by expiresAt asc (null สุดท้าย), createdAt asc   // หมดอายุเร็วสุดใช้ก่อน
  3. walk lots ทีละก้อนจนกว่า spendAmount จะครบ:
       amt = min(lot.remainingAmount, remaining)
       tx.update(lot, { remainingAmount -= amt, status: (เหลือ0? DEPLETED : ACTIVE) })
       tx.create(pointsLotConsumptions/{id}, { spendLedgerEntryId, lotId, amountConsumed: amt })
  4. ถ้ารวมแล้วไม่พอ → throw → transaction abort ทั้งหมด (ไม่มี partial write)
  5. tx.create(pointsLedger/{entryId}, { type:'SPEND', delta: -spendAmount, ... })
  6. tx.update(membership, { pointsBalance -= spendAmount })
  7. tx.create(idempotencyKeys/{key}, { resultRef: entryId })
```

### Concurrency Safety — ไม่ต้องสร้าง Distributed Lock เพิ่ม

Firestore Transaction ให้ serializable isolation บนเอกสารที่ transaction นั้นอ่าน/เขียนจริง — สอง redemption request พร้อมกันสำหรับ Membership เดียวกันจะแตะ `pointsLots` และ `membership.pointsBalance` เอกสารเดียวกัน → Firestore ตรวจพบ contention และให้ transaction ที่ช้ากว่า retry อัตโนมัติ ผลคือ serialize กันเองโดยธรรมชาติ ไม่มีทางเกิด double-spend

ข้อจำกัด: Firestore transaction จำกัด 500 writes — ไม่ชนขีดนี้ที่ scale 50 merchants ปกติ แต่ถ้า membership หนึ่งมี lot กระจัดกระจายมาก พิจารณา **Lot Consolidation job** เป็น future optimization (ไม่ทำใน V1)

### Expiration Flow (Scheduled Cloud Function รายวัน)

```
สำหรับแต่ละ membership ที่มี lot status=ACTIVE และ expiresAt <= now:
  runTransaction:
    - รวม remainingAmount ของทุก lot ที่หมดอายุ = totalExpired
    - update lots ทั้งหมด → status=EXPIRED (remainingAmount คงค่าไว้เป็นหลักฐาน ไม่ zero-out แบบไม่มีร่องรอย)
    - tx.create(pointsLedger, { type:'EXPIRATION', delta: -totalExpired, expiredLotIds: [...] })
    - tx.update(membership, { pointsBalance -= totalExpired })
```

### Reversal

- **Reversal ของ EARN**: ลด `remainingAmount` ของ lot ต้นทางเท่าที่เหลือ ถ้า lot ถูกใช้หมดแล้ว → สร้าง `ADJUSTMENT` entry ติดลบใหม่แทน (บันทึกเหตุผล)
- **Reversal ของ SPEND**: ไม่พยายามคืนกลับเข้า lot เดิม (อาจถูกใช้/หมดอายุไปแล้ว) แต่สร้าง **pointsLot ใหม่** ด้วยจำนวนที่ reverse ตามนโยบายวันหมดอายุปัจจุบันของ merchant — deterministic และปลอดภัยที่สุด แม้ไม่ตรงกับวันหมดอายุเดิมเป๊ะ

### No Hard Delete

Points Transaction ที่ผิดห้าม delete เพื่อปกปิดประวัติ — ใช้ Original → Reversal → Correct Transaction เสมอ audit history ต้องอยู่ครบ

### Balance Reconciliation (Safety Net)

Job รายคืนเทียบ `Σ pointsLots.remainingAmount (status=ACTIVE)` กับ `membership.pointsBalance` ต่อ membership — ถ้าไม่ตรงกัน เขียน alert เข้า `systemHealth`/ops channel

### Point Expiration Policy — Config-driven

Merchant เลือกได้: Never expire / Expire X days after earning / Expire fixed date / Season based — เก็บ `expiresAt` ต่อ lot ตามกติกาของ merchant ตอนที่แต้มถูกให้ (Expiration Reminder เป็น future)

---

## 13. Rewards / Vouchers

Reward Template (กติกา) → Redeem → Voucher Instance (สิทธิ์จริงของสมาชิกคนหนึ่ง)

Reward types: Fixed Discount, Percentage Discount, Free Product, Free Service, Privilege, Physical Reward, Custom Reward — กำหนดได้: Required Points, Total/Unlimited Stock, Limit per Member, Start/End Date, Voucher Expiration, Allowed Branches

### Redeem Flow (idempotent + transactional)

```
1. ตรวจ requiredPoints ≤ pointsBalance ปัจจุบัน
2. ตรวจ stock/limitPerMember/branchScope/dateRange
3. Transaction:
   - หัก pointsBalance ผ่าน FIFO consumption (หัวข้อ 12), เขียน ledger entry (type=SPEND, sourceType=REWARD_REDEMPTION)
   - ลด stock (ถ้ามี)
   - สร้าง voucherInstances/{id} status=AVAILABLE, expiresAt คำนวณจาก voucherExpiryRule
   - เขียน event "reward.redeemed"
```

### Use Flow (แยกจาก Redeem เสมอ)

Redeem (แลกแต้ม → ได้ Voucher) ≠ Use (ใช้สิทธิ์จริง) — แยกกันเพื่อให้ Report รู้ redeemed vs used vs expired แยกกัน: Staff scan/ยืนยัน → validate (merchant/branch/expiry/status) → set `status=USED, usedAt, usedByStaffId` → เขียน event "reward.used"

Physical Reward ที่ต้องจัดส่ง/นัดรับ — V1 แค่ mark USED โดย staff เป็นการยืนยันว่ามอบของแล้ว ไม่ทำ fulfillment/shipping tracking

---

## 14. Coupons

โครงสร้างคล้าย Reward: CouponTemplate → CouponInstance — แต่ Coupon **ไม่ต้องแลกด้วยแต้มเสมอไป**

Coupon Types: Percentage Discount, Fixed Discount, Free Product, Free Service, Buy X Get Y, Privilege, Custom
Conditions รองรับ: Minimum Amount, Maximum Discount, Valid Days/Hours, Branch, Usage Limit, Total Limit, Per Member Limit, Start/End, Expire X days after issued, Stackable/Non-stackable

### Distribution (แจกได้จากหลายทาง)

Manual, Segment, Promotion, Birthday, New Member, Inactive Customer, Points Milestone, Campaign, Coupon Code, QR Campaign — บางประเภทอยู่ V2 ได้ แต่ data model ต้องรองรับตั้งแต่ต้น — `issuedVia` field บอกที่มาของแต่ละ instance เพื่อ trace ย้อนกลับได้

### Redemption Flow — สอง-step confirm เหมือน Reward

```
Customer เปิดคูปอง → แสดง QR/code (status ยังเป็น AVAILABLE)
→ Staff scan → Backend validate (expiry, usageLimit, perMemberLimit, membership match, merchant match, branch,
   minAmount ถ้ามี — ให้ staff confirm ยอดเองกรณีไม่มี POS)
→ Staff confirm → status=USED
```

`minimumAmount`/`maximumDiscount` เก็บเป็น metadata ให้ staff อ่านและยืนยันด้วยสายตา — ระบบไม่ enforce เชิงตัวเลขจริงจนกว่าจะมี POS integration (นอก scope V1)

Coupon Code (ลูกค้ากรอกโค้ดเอง) และ QR-only ต้องรองรับทั้งคู่ (implementation cost ต่ำ)

### Coupon Usage Limit & Redemption Atomicity — Phase 5 Architecture Decision (Locked, 2026-08-16)

**ขอบเขต**: มตินี้ชี้แจงความหมายของคำว่า "Usage Limit" ในรายการ Conditions ด้านบน ที่เอกสารก่อนหน้านี้ไม่เคยนิยามแยกจาก "Total Limit"/"Per Member Limit" ไว้ชัดเจน และล็อกกติกา redemption atomicity สำหรับ V1 — ไม่กระทบ field/schema อื่นของ `couponInstances` ใน §5 ที่มีอยู่แล้ว ไม่ override ข้อความใดที่มีอยู่เดิม:

- สำหรับ V1: **1 `couponInstances/{instanceId}` = redeem/use ได้ 1 ครั้งเท่านั้น** — "Usage Limit" ในความหมายของ V1 คือขอบเขตนี้เอง ไม่ใช่แนวคิดที่แยกจาก "Total Limit" (จำนวน instance ทั้งหมดที่ template สร้างได้) หรือ "Per Member Limit" (จำนวนครั้งที่สมาชิกคนเดียวรับ template นี้ได้) — **ไม่เพิ่ม field ใหม่** เช่น `maxUses`/`remainingUses` และ**ไม่เปลี่ยน** `status` enum จาก `'AVAILABLE'|'USED'|'EXPIRED'` ที่ระบุไว้แล้วใน §5
- Redemption (ขั้น "Redeem" ของ Coupon = ขั้นใช้จริงตาม Redemption Flow ด้านบน, เปลี่ยนสถานะ AVAILABLE→USED) ต้องเป็น **server-side atomic transaction เดียวจบ** (Firestore transaction) และ **idempotent เสมอ** (idempotencyKey ตาม §27) — ป้องกัน double redemption จาก concurrent request (สอง staff scan คูปองใบเดียวกันพร้อมกัน — ตรงกับ threat ที่ระบุไว้แล้วใน §26) และป้องกัน replay จาก network retry/double-submit
- Instance ที่มี `status='USED'` แล้ว **ต้องไม่มีทางถูก redeem ซ้ำได้อีก** ไม่ว่าจะ lookup ผ่าน code, QR, หรือ instance id — ตรวจ status ภายใน transaction เดียวกับการเขียนเสมอ (ไม่ใช่ check-then-write แยก step, หลักการเดียวกับ §9's Staff Limits)
- **Multi-use coupon (1 instance ใช้ได้หลายครั้ง) ไม่ implement ใน V1** เว้นแต่จะมีการอัปเดตเอกสารนี้ในอนาคตให้ระบุ requirement นั้นไว้ชัดเจนก่อน — ห้าม implement เองโดยไม่ขออนุมัติ schema change ใหม่

**เหตุผลที่ไม่ขัดกับ Architecture เดิม**: ตรงกับ `couponInstances.status` enum ที่ปิดไว้แล้วที่ §5 (ไม่มีค่าที่สามหรือ counter field ใดๆ) และตรงกับ Redemption Flow pseudocode ด้านบนเอง ("Staff confirm → status=USED") ซึ่งเขียนเป็น one-way transition อยู่แล้ว — มตินี้เพียงระบุความหมายของคำที่เอกสารไม่เคยนิยามแยกไว้ให้ตรงกับ schema ที่มีอยู่จริง ไม่ใช่การเปลี่ยนกติกาใด

### Coupon Expiration — Lazy Validation for V1 (Phase 5 Architecture Decision, Locked 2026-08-16)

**ขอบเขต**: มตินี้ระบุจังหวะเวลาที่ `couponExpiration` (ปรากฏในตาราง Scheduled ของหัวข้อ 32) จะถูกสร้างเป็น Cloud Function จริง — ยังไม่ใช่ Phase 5/V1 — ไม่กระทบ field `expiresAt`/`status` ที่มีอยู่แล้วใน §5 ไม่ลบหรือแก้แถว `couponExpiration` ในตารางหัวข้อ 32 และไม่กระทบ scheduled job อื่นในตารางเดียวกัน:

- V1 ใช้ **Lazy Expiration เท่านั้น** — ไม่มี Scheduled Cloud Function/sweep job สำหรับ coupon ใน Phase 5
- ทุก operation ที่เกี่ยวข้องกับ claim/redeem/use ของ coupon **ต้อง validate `expiresAt` เทียบกับเวลา ณ ขณะนั้นฝั่ง server (`serverNow`) ทุกครั้ง** ภายใน transaction เดียวกับการเขียนจริง — ถ้า `expiresAt <= serverNow` ต้อง reject การ redeem/use เสมอ ไม่ว่า `status` field ที่เก็บไว้จะยังเป็น `AVAILABLE` อยู่ก็ตาม
- UI สามารถ derive/แสดงสถานะ "หมดอายุ" จาก `expiresAt` ได้เพื่อ UX (เช่น ไม่โชว์ปุ่ม "ใช้" ให้คูปองที่หมดอายุแล้ว) แต่**ฝั่ง UI ไม่ใช่ security boundary** — การตรวจสอบฝั่ง server เป็น authoritative เสมอ ตรงตามหลักการเดิมของหัวข้อ 10 ("Frontend permission list ใช้แค่ซ่อน/แสดง UI (UX เท่านั้น ไม่ใช่ security boundary)")
- `status` ที่เก็บใน Firestore อาจค้างเป็น `AVAILABLE` แม้เลย `expiresAt` ไปแล้ว จนกว่าจะถูก touch โดย redeem attempt หรือ scheduled sweep ที่จะเพิ่มใน phase หลัง (deferred item) — ยอมรับได้ใน V1 เพราะไม่กระทบความถูกต้องของ transaction ใดๆ
- ต้องมี automated test ครอบคลุม boundary condition ของเวลา (เช่น `expiresAt` เท่ากับ `serverNow` เป๊ะ, `expiresAt` เพิ่งผ่านไปหนึ่งวินาที) สำหรับทั้งกรณี expired และ not-expired

**เหตุผลที่ไม่ขัดกับ Architecture เดิม**: `couponExpiration` ในตารางหัวข้อ 32 ยังคงอยู่ในเอกสารตามเดิม — มตินี้ระบุแค่จังหวะเวลาที่จะสร้าง job นี้จริง (deferred ไปยัง phase ที่มี scheduled-infrastructure เป็นงานปกติอยู่แล้ว เช่น พร้อมกับ `pointsExpiration`/`balanceReconciliation`) ไม่ใช่การยกเลิก requirement — สอดคล้องกับหลัก "หลีกเลี่ยง premature infrastructure complexity" ที่ระบุไว้แล้วในหัวข้อ 0 Pilot Strategy และสอดคล้องกับ pattern เดียวกับที่ Reward's Voucher Expiration (§13) ใช้ตั้งแต่ Phase 4 (lazy validation ที่ redeem/use time เท่านั้น เช่นกัน)

---

## 15. Visit / Activity Model

Entity ใหม่ — เบา ไม่ผูกกับ POS, ต้องใช้งานได้แม้ไม่มี POS

```
visits/{visitId}
  - merchantId, membershipId, branchId
  - source: 'STAFF_SCAN' | 'STAFF_SEARCH' | 'MANUAL_ENTRY' | 'AUTOMATION'
  - countsAsVisit: bool  // default true สำหรับ staff-initiated add points, false สำหรับ correction/automation bonus
  - relatedRefs{ pointsLedgerEntryId?, couponInstanceId?, voucherInstanceId? }
  - recordedAt, createdBy
```

**ห้าม assume ว่า `points.earned` ทุกครั้ง = การมาร้าน** — Manual Adjustment/Correction/Automation bonus ตั้ง `countsAsVisit=false` หรือไม่สร้าง Visit เลย Event `visit.recorded` emit ทุกครั้งที่สร้าง Visit

### Activity Aggregate (cache บน Membership)

```
membership.activityStats: {
  lastVisitAt, visitCount30d, visitCount90d, firstVisitAt,
  segment: 'NEW'|'ACTIVE'|'REGULAR'|'VIP'|'AT_RISK'|'INACTIVE'
}
```

Segment คำนวณจาก **threshold ที่ merchant ตั้งเองได้** (ห้าม hard-code เช่น "30 วัน"): `merchants/{id}.segmentRulesConfig = { inactiveAfterDays, atRiskAfterDays, regularMinVisits30d, ... }` — คำนวณผ่าน **Scheduled Daily Batch Job เดียวกับที่ใช้ประเมิน `INACTIVE_DAYS` trigger ของ Automation Engine** (ไม่สร้างระบบคำนวณซ้ำสองชุด) เพราะ "inactive" เป็นผลจากเวลาที่ผ่านไปโดยไม่มี event ใหม่ ต้องใช้ batch scan ไม่ใช่ real-time trigger อย่างเดียว

---

## 16. Promotion / Automation

### หลักการ — Automation คือ Engine เดียว, Promotion คือหน้าตาเท่านั้น

**ไม่มี collection `promotions` แยกต่างหาก** — `automations` เป็น Single Source of Truth ทั้ง trigger/condition/action/safety limit เพียงชุดเดียว ป้องกันความเสี่ยง business rule สองชุดไม่ตรงกัน:

```
automations/{id}
  - merchantId, trigger{}, conditions[], actions[], limits{}
  - presentedAs: 'AUTOMATION' | 'PROMOTION'   // filter/label ใน UI เท่านั้น ไม่กระทบ execution
  - marketing?{ title, description, bannerImageUrl, visibleInCustomerPortal }  // เฉพาะ presentedAs='PROMOTION'
  - status: 'DRAFT' | 'TEST' | 'ACTIVE' | 'PAUSED' | 'ENDED'
  - lastTestRunSnapshot
```

Owner ที่เข้า "สร้าง Promotion" เห็น wizard ง่ายกว่า (preset trigger สำเร็จรูป Welcome/Birthday/Happy Hour + field การตลาด) แต่ข้างหลังสร้าง document เดียวกันกับ Automation — Owner ที่เข้า "สร้าง Automation" (advanced) เห็น trigger/condition/action ดิบเต็มรูปแบบ **ทั้งสอง UI แก้ document เดียวกัน จึงเป็นไปไม่ได้ที่ rule จะไม่ตรงกัน**

### Automation Engine

```
trigger: { type: 'MEMBER_CREATED'|'BIRTHDAY'|'POINTS_REACHED'|'INACTIVE_DAYS'|
           'COUPON_EXPIRING'|'COUPON_REDEEMED'|'REWARD_REDEEMED'|'SCHEDULE' }
conditions: [{ field, operator, value }]
actions: [{ type: 'ADD_POINTS'|'ISSUE_COUPON'|'ISSUE_REWARD'|'ADD_TAG'|
            'CHANGE_TIER'|'SEND_NOTIFICATION'|'NOTIFY_OWNER', params{} }]
limits: { maxExecPerCustomerPerDay, maxExecPerPromotion, pointBudget, couponBudget, cooldownHours }
```

Execution: Event-triggered → query automations ที่ merchant + trigger type ตรงกัน + `status=ACTIVE` → evaluate conditions → ตรวจ safety limits ก่อนรัน action ทุกครั้ง → เขียน execution record (audit + budget tracking) → รัน action ผ่าน service function เดิม (เช่นเรียก service เดียวกับ manual add points — ไม่มี logic path คู่ขนาน)

### Lifecycle

`DRAFT → TEST (dry-run) → ACTIVE ⇄ PAUSED → ENDED (ตาม endAt หรือปิดเอง)` — ใช้ร่วมกันไม่ว่าจะสร้างผ่านมุมมองไหน

### Test Mode (บังคับก่อนเปิด Automation จริง)

Dry-run: query กลุ่มสมาชิกที่ match condition ปัจจุบัน (ไม่รัน action จริง) → คำนวณ estimated affected members / points / coupons / messages → แสดงให้ Owner ยืนยันก่อน Confirm

### Automation Safety (ป้องกัน Owner ตั้งค่าผิด)

Max execution per customer/day, Max execution per promotion, Point budget, Coupon issuance limit, Cooldown — ตรวจใน transaction เดียวกับการรัน action (ดูหัวข้อ 17)

Scheduled trigger (BIRTHDAY, INACTIVE_DAYS, SCHEDULE) ใช้ Cloud Scheduler + batch query รายวัน แทน real-time event — ยอมรับ latency ระดับวันสำหรับ trigger ประเภทนี้

### CHANGE_TIER — Deferred for Phase 6 (Phase 6 Architecture Decision, Locked 2026-08-16)

**ขอบเขต**: มตินี้ชี้แจงสถานะของ action type `CHANGE_TIER` ที่ปรากฏใน `actions[]` enum (หัวข้อ 5 และหัวข้อนี้) ซึ่งเอกสารก่อนหน้านี้ไม่เคยนิยาม Membership Tier ไว้เลย (ไม่มี field, config, หรือ effect ใดๆ ที่เกี่ยวข้องกับ "tier" บน `memberships` — คำว่า "tier" ที่ปรากฏที่อื่นในเอกสารคือ Package Tier ของหัวข้อ 25 ซึ่งเป็นคนละแนวคิดกัน) — ไม่กระทบ field/schema อื่นของ `automations` ใน §5 ที่มีอยู่แล้ว ไม่ override ข้อความใดที่มีอยู่เดิม:

- **`CHANGE_TIER` ยังคงอยู่ใน `actions[].type` enum เพื่อ forward compatibility เท่านั้น** — ไม่ลบออกจาก schema
- **Phase 6 ห้าม implement Membership Tier functionality ใดๆ ทั้งสิ้น** — ห้ามเพิ่ม `membership.tier` field, ห้ามเพิ่ม tier configuration บน `merchants/{id}`, ห้ามเพิ่ม tier rule/progression ใดๆ, ห้ามเพิ่ม domain event ประเภท tier-changed
- **`CHANGE_TIER` ห้ามปรากฏเป็นตัวเลือกใน Owner/Staff UI ใดๆ** ของ Automation/Promotion builder ใน Phase 6
- **`CHANGE_TIER` ห้าม executable โดย Phase 6 automation executor** — ไม่มี dispatch case ใดๆ รองรับ action type นี้
- **ความพยายามใช้ `CHANGE_TIER` โดยตรงผ่าน API/data (ไม่ผ่าน UI)** ต้องถูกปฏิเสธด้วย deterministic server-side validation เสมอ (เช่น `ValidationError` ตอน create/update automation ที่มี action type นี้อยู่ใน `actions[]`) — ไม่ silently ignore, ไม่ partial-accept
- **ห้ามคิดค้น effect ใดๆ ของ `CHANGE_TIER` ต่อ Points, Rewards, Coupons, Membership eligibility, หรือ Reporting** จนกว่าจะมี architecture/product decision cycle แยกต่างหากมาล็อกนิยามที่แท้จริงของ Membership Tier ก่อน (schema, semantics, ความสัมพันธ์กับ Points Rules MULTIPLIER ของหัวข้อ 11 ฯลฯ)
- Membership Tier ที่แท้จริงเป็น **explicitly deferred item** รอ architecture/product decision cycle ใหม่ในอนาคต ไม่ใช่ V1/Phase 6 scope

**เหตุผลที่ไม่ขัดกับ Architecture เดิม**: `actions[].type` enum ที่ §5/§16 ยังคงมี `CHANGE_TIER` อยู่ครบตามเดิม (ไม่ลบ ไม่เปลี่ยน) — มตินี้ระบุแค่ว่ายังไม่มี spec รองรับการ implement จริง จึงต้อง defer ไปก่อน สอดคล้องกับหลัก "ห้ามเดา business rule" ของ CLAUDE.md และ pattern เดียวกับที่ Coupon's `issuedVia` 8 ใน 10 ค่า (หัวข้อ 14) ถูก model ไว้ใน schema โดยไม่มี producer จริงในโค้ดจนกว่า phase ที่เกี่ยวข้องจะมาถึง

### SEND_NOTIFICATION / NOTIFY_OWNER — Delivery remains Phase 7 scope (reaffirmed, not a new decision)

ตามหัวข้อ 23 และหัวข้อ 33 (Phase 7 DoD: "Notification Service + Channel Adapter") — การส่งข้อความจริงผ่าน LINE/ช่องทางใดๆ ยังคงเป็น Phase 7 scope เท่านั้น Phase 6 **ห้าม implement notification delivery จริง** — Phase 6 เตรียมได้แค่ dispatch/idempotency seam (execution record ผ่าน `automationActionExecutions` ตาม deterministic `executionKey` เดียวกับ action type อื่น) โดยไม่มี `ChannelAdapter`/`LineAdapter` จริงอยู่เบื้องหลังจนกว่าจะถึง Phase 7

### BIRTHDAY — Deferred for Phase 6 (Phase 6 Architecture Decision, Locked 2026-08-16)

**ขอบเขต**: มตินี้ชี้แจงสถานะของ trigger type `BIRTHDAY` ที่ปรากฏใน `trigger{}` enum (หัวข้อ 5 และหัวข้อนี้) และ "Promotion presets (welcome/birthday)" ที่ระบุไว้เป็น Phase 6 DoD ในหัวข้อ 33 — เอกสารก่อนหน้านี้ไม่เคยนิยาม field วันเกิดไว้เลยที่ใดใน schema: `memberships/{membershipId}.merchantProfile` (หัวข้อ 5 และหัวข้อ 7) ระบุ field ไว้ครบเป็น `{ displayName, phone, email, consentMarketing, profileSource }` เท่านั้น ไม่มี `birthDate`/`dob` หรือ field รูปแบบวันเกิดใดๆ และไม่มี membership profile-edit API/service ใดๆ ในเอกสารหรือโค้ดที่ implement มาแล้ว (Phase 1–5) ให้ populate field นี้ได้ด้วยซ้ำ — ไม่กระทบ field/schema อื่นของ `automations`/`memberships` ที่มีอยู่แล้ว ไม่ override ข้อความใดที่มีอยู่เดิม:

- **`BIRTHDAY` ยังคงอยู่ใน `trigger{}.type` enum เพื่อ forward compatibility เท่านั้น** — ไม่ลบออกจาก schema
- **Phase 6 ห้ามเพิ่ม `merchantProfile.birthDate`/`dob` หรือ field วันเกิดรูปแบบใดๆ** บน `memberships` — ห้ามเพิ่ม membership profile-edit capability ใหม่เพื่อรองรับ field นี้เช่นกัน
- **Scheduled batch job ของ Phase 6 (หัวข้อ 15, หัวข้อ 16 "Scheduled trigger") ห้าม evaluate `BIRTHDAY` trigger type** — ไม่มี dispatch/query case ใดๆ รองรับ trigger type นี้ในรอบ Phase 6
- **"Birthday" ห้ามปรากฏเป็นตัวเลือก preset ใน Owner-facing Promotion builder UI** ของ Phase 6 — Phase 6 ส่งมอบเฉพาะ "Welcome" preset (ใช้ `MEMBER_CREATED` trigger) ตามที่ระบุไว้ในหัวข้อ 33
- ความพยายามสร้าง/แก้ automation ที่ระบุ `trigger.type='BIRTHDAY'` โดยตรงผ่าน API (ไม่ผ่าน UI) ต้องถูกปฏิเสธด้วย deterministic server-side validation เสมอ เช่นเดียวกับหลักการที่ใช้กับ `CHANGE_TIER` ด้านบน
- Birthday trigger/preset ที่แท้จริงเป็น **explicitly deferred item** รอ architecture/product decision cycle ใหม่ในอนาคตที่จะล็อกนิยาม field วันเกิด (รูปแบบ full date vs. เดือน/วันไม่มีปี, สถานะ PII/consent, ช่องทางที่ Owner/Staff/ลูกค้าจะกรอกค่านี้ได้) ก่อนจึงจะ implement ได้จริง — ไม่ใช่ V1/Phase 6 scope

**เหตุผลที่ไม่ขัดกับ Architecture เดิม**: `trigger{}.type` enum ที่ §5/§16 ยังคงมี `BIRTHDAY` อยู่ครบตามเดิม (ไม่ลบ ไม่เปลี่ยน) — มตินี้ระบุแค่ว่ายังไม่มี field/spec รองรับการ implement จริง จึงต้อง defer ไปก่อน สอดคล้องกับหลัก "ห้ามเดา business rule" ของ CLAUDE.md และหลักการเดียวกับที่ใช้ล็อก `CHANGE_TIER` ด้านบนในหัวข้อนี้ — หัวข้อ 33's "Promotion presets (welcome/birthday)" ยังคงข้อความเดิมไว้ครบ (ไม่แก้ ไม่ลบ) มติแค่ระบุขอบเขตการส่งมอบจริงของ Phase 6 ว่าครอบคลุมเฉพาะส่วน "welcome"

---

## 17. Event Model + Idempotency

### Event Model

Event เป็น **immutable business fact ที่เกิดขึ้นแล้ว** ใช้ขับเคลื่อน Automation/Report/future Analytics — **แยกจาก Audit Log ชัดเจน**: Event บอก "เกิดอะไรขึ้นในเชิงธุรกิจ", Audit บอก "ใครทำอะไรกับข้อมูลอะไร"

Event Types: `customer.created`, `membership.created`, `points.earned`, `points.redeemed`, `points.adjusted`, `points.reversed`, `reward.redeemed`, `reward.used`, `coupon.issued`, `coupon.redeemed`, `coupon.expired`, `promotion.triggered`, `automation.executed`, `staff.login`, `report.generated`, `notification.sent`, `notification.failed`, `visit.recorded`

```
Domain Service เขียน state change (transaction)
  → เขียน events/{eventId} ใน transaction เดียวกัน (atomic — ป้องกัน event หายเมื่อ state เปลี่ยนแต่ event เขียนไม่สำเร็จ)
  → Cloud Function trigger (onCreate events/{eventId})
      → ส่งเข้า Automation Engine (evaluate matching automations)
      → อัปเดต aggregate สำหรับ Report
```

Event schema มี `schemaVersion` field ตั้งแต่ต้นเผื่อ payload structure เปลี่ยนในอนาคต

### Event Consumer Idempotency — Deterministic Execution Key

```
automationActionExecutions/{executionKey}
  // executionKey = deterministicHash(eventId, automationId, membershipId, actionIndex)
  - merchantId, eventId, automationId, membershipId, actionIndex, actionType
  - status: 'EXECUTED' | 'SKIPPED_LIMIT' | 'FAILED'
  - resultRef, createdAt
```

```
Event Trigger (onCreate events/{eventId})
  → หา automations ที่ merchantId + trigger.type ตรงกัน และ status=ACTIVE
  → สำหรับแต่ละ automation ที่ conditions ผ่าน:
      สำหรับแต่ละ action (index i):
        executionKey = hash(eventId, automationId, membershipId, i)
        runTransaction:
          - tx.get(automationActionExecutions/{executionKey})
          - ถ้ามีอยู่แล้ว → no-op (ยังไม่เคยรันเท่านั้นที่รันจริง)
          - เช็ค safety limit (max/day, budget, cooldown) ภายใน transaction เดียวกัน
              → เกิน limit → tx.create(status:'SKIPPED_LIMIT') จบ ไม่ throw
          - รัน side-effect จริง + tx.create(execution record, status:'EXECUTED', resultRef)
```

ตัวอย่างที่ป้องกันได้: `membership.created → Welcome +5` แม้ event ถูก retry, executionKey เดิมทุกครั้ง → ข้ามทันที ไม่แจกแต้มซ้ำ (at-least-once delivery ปลอดภัยแบบ at-most-once execution ต่อ action)

### Failure / Dead-letter Handling (ระดับที่เหมาะกับ 50 merchants)

Action ล้มเหลว → `status:'FAILED'` → function throw ให้ Cloud Functions retry policy มาตรฐานรันใหม่ทั้ง event (ปลอดภัยเพราะ action ที่สำเร็จแล้วถูกข้ามด้วย idempotency key เดิมเสมอ) — ครบ retry สูงสุดแล้วยังไม่สำเร็จ → mark `events/{id}.processingStatus='FAILED'` + alert เข้า System Health ให้ตรวจสอบมือ — ไม่ต้องสร้าง Dead Letter Queue แยก (Pub/Sub DLQ ฯลฯ) เพราะ scale นี้ manual review เพียงพอ

---

## 18. Audit Log

บันทึก **sensitive action ที่มนุษย์/ระบบทำต่อข้อมูล**:

```
auditLogs/{logId}
  - merchantId, actorType('staff'|'superAdmin'|'system'), actorId
  - action (e.g. "staff.permission.updated", "reward.redeemed", "superadmin.support_mode.entered")
  - targetType, targetId, before{}, after{}, reason?
  - metadata{ ip?, userAgent?, requestId }
  - createdAt
```

### กฎสำคัญ (บังคับ)

- เขียนได้จาก **server-side เท่านั้น** — security rule ปิด client write ทั้งหมด
- **ไม่มี update/delete แม้แต่จาก Super Admin ผ่าน Dashboard**
- Super Admin เข้าสู่ Support/View-as-Owner Mode **ต้อง audit ทุกครั้ง**
- Retention: ไม่ archive ไป cold storage ใน V1 เก็บใน Firestore ตรงๆ พอสำหรับ scale นี้

---

## 19. LINE Architecture (OA + LINE Login + LIFF)

> ส่วนนี้คือ**ฉบับที่ตรวจสอบกับ LINE Developers Documentation จริงแล้ว** (แก้ assumption ที่ผิดจากดราฟท์แรก) — ยึดฉบับนี้เป็น final เท่านั้น

### ข้อเท็จจริงจาก LINE Developers Documentation (ยืนยันแล้ว)

- LIFF app เพิ่มได้เฉพาะบน **LINE Login channel** หรือ **LINE MINI App channel** เท่านั้น — เพิ่มบน Messaging API channel ไม่ได้แล้วตั้งแต่ก.พ. 2020
- LIFF Server API (สร้าง/จัดการ LIFF app แบบ programmatic) ต้องใช้ **Channel Access Token ของ LINE Login channel** เท่านั้น
- **userId เป็น unique ต่อ Provider ไม่ใช่ต่อ Channel** — ถ้า Messaging API channel และ LINE Login channel อยู่ใต้ Provider เดียวกัน userId ของผู้ใช้คนเดียวกันจะเท่ากันเสมอไม่ว่าจะได้มาจาก channel ไหน
- การ Link LINE Official Account เข้ากับ LINE Login channel ทำผ่าน Console (Login channel → Basic settings → "Linked LINE Official Account") — ทั้งสอง channel ต้องอยู่ใต้ Provider เดียวกัน
- **ไม่มี Public API สำหรับสร้าง Provider หรือ Channel ใหม่แบบ programmatic** — ต้องทำผ่าน Console โดยมนุษย์เท่านั้น
- Channel Access Token ของทั้งสอง channel ออกได้ผ่าน API (`client_credentials` grant ด้วย Channel ID + Channel Secret) — ไม่ต้อง copy token จาก Console ด้วยมือ

### โครงสร้างที่ถูกต้อง

```
Provider (1 ต่อ 1 Merchant)
  ├─ Messaging API Channel   (LINE OA ของร้าน — ใช้ยิง push message)
  └─ LINE Login Channel      (ใช้ LIFF — ใช้สำหรับ Customer Portal)
       └─ LIFF App (1 ตัว, ผูกกับ Login channel นี้)

Link: LINE Login Channel ──linked──> Messaging API Channel (ตั้งค่าใน Console ครั้งเดียว)
```

เพราะทั้งสอง channel อยู่ใต้ **Provider เดียวกัน** → userId ที่ได้จาก `liff.getProfile()` (ผ่าน Login channel) กับ userId ที่ใช้ยิง push message (ผ่าน Messaging API channel) **เป็นค่าเดียวกันเสมอ** — ทำให้ `merchantLineIdentity` หนึ่งตัวใช้ได้ทั้ง "แสดงข้อมูลใน Portal" และ "ส่งข้อความแจ้งเตือน" โดยไม่ต้องทำ Account Link flow แยกต่างหาก

### Data Model

```
lineChannelConfigs/{merchantId}   // ไม่มี client read
  - lineProviderId
  - messagingChannel{ channelId, channelSecretRef, accessTokenRef, status }
  - loginChannel{ channelId, channelSecretRef, accessTokenRef, liffId, status }
  - linkedVerifiedAt
  - overallStatus: 'CONNECTED' | 'PARTIAL' | 'DISCONNECTED' | 'ERROR'
```

`accessTokenRef`/`channelSecretRef` ทั้งสอง channel เก็บผ่าน Secret Manager reference — ห้ามเก็บ secret ใน client-accessible Firestore document

### สิ่งที่ Platform Backend Automate ได้จริง (หลังจาก channel ถูกสร้างแล้ว)

1. ออก Channel Access Token เองทั้งสอง channel ผ่าน `client_credentials` grant (Owner ให้แค่ ID + Secret, ไม่ต้อง copy token ยาวๆ)
2. สร้าง LIFF App อัตโนมัติผ่าน LIFF Server API (ด้วย Login Channel Access Token) ชี้ endpoint ไปที่ `/m/[merchantSlug]`
3. ตั้งค่า Messaging API Webhook Endpoint อัตโนมัติผ่าน Messaging API
4. ทดสอบ connection (verify token, ping webhook) แล้วอัปเดตสถานะ CONNECTED

### สิ่งที่ Automate ไม่ได้ (ข้อจำกัดจริงของ LINE Platform)

- การสร้าง Provider (ถ้ายังไม่มี)
- การสร้าง Messaging API Channel (ถ้ายังไม่มี OA อยู่ก่อน)
- การสร้าง LINE Login Channel ใหม่ใต้ Provider เดียวกับ OA
- การกด Link "LINE Official Account" เข้ากับ Login Channel ใน Console

ทั้ง 4 ข้อนี้ **ต้องทำผ่าน LINE Developers Console โดยมนุษย์เท่านั้น** — Wizard ทำได้ดีที่สุดคือแนะนำทีละขั้นตอนพร้อมภาพประกอบ/deep-link ไปยังหน้า Console ที่ถูกต้อง

### Webhook Handling

Webhook รับข้อความ LINE เข้ามาต้อง **verify signature (x-line-signature) ทุก request** ก่อนประมวลผล — endpoint กลาง + resolve merchant จาก `destination` field ใน webhook payload (ลดจำนวน registered webhook URL) — ใช้ event/message ID ของ LINE เองเป็น idempotency key กัน retry ซ้ำ

---

## 20. LINE Merchant Onboarding Flow

### เป้าหมาย: ลดขั้นตอนที่ Owner ต้องทำในมือให้เหลือน้อยที่สุดเท่าที่ LINE Platform อนุญาต

```
[ส่วนที่ Owner ต้องทำเองใน LINE Developers Console — ไม่มีทาง automate ได้]

Step 1: ถ้ายังไม่มี LINE OA → สร้างผ่าน LINE Official Account Manager ตามปกติ
        (LINE จะสร้าง Provider + Messaging API Channel ให้อัตโนมัติในขั้นตอนนี้อยู่แล้ว)
        ถ้ามี OA อยู่แล้ว → ข้ามไป Step 2

Step 2: เปิด LINE Developers Console → เข้า Provider เดียวกับ OA
        → กด "Create a new channel" → เลือก "LINE Login"
        → กรอกชื่อ/ข้อมูลพื้นฐาน (Wizard มี screenshot ทีละจุดกำกับตำแหน่งปุ่มให้)

Step 3: เข้า LINE Login Channel ที่สร้างใหม่ → แท็บ "Basic settings"
        → หัวข้อ "Linked LINE Official Account" → เลือก OA ของร้านตัวเอง → Save

Step 4: คัดลอก 4 ค่าจาก Console มาวางใน Dashboard ของเรา:
        - Messaging API: Channel ID, Channel Secret
        - LINE Login:    Channel ID, Channel Secret
        (ไม่ต้อง copy Channel Access Token ใดๆ — ระบบออกเองจาก ID+Secret)

[ส่วนที่ Platform Backend ทำให้อัตโนมัติทั้งหมด — Owner กดปุ่มเดียวคือ "เชื่อมต่อ"]

Step 5: กด "เชื่อมต่อ" → Cloud Function:
        a) ออก Channel Access Token ทั้งสอง channel ด้วย client_credentials grant
        b) เรียก LIFF Server API (ด้วย Login token) → สร้าง LIFF App ชี้ไปที่ /m/[merchantSlug]
        c) เรียก Messaging API (ด้วย Messaging token) → ตั้ง Webhook Endpoint ชี้มาที่ webhook กลาง
        d) Verify ทั้งสองการเชื่อมต่อ → บันทึกสถานะ CONNECTED
        e) Generate Member URL/QR (LIFF URL) → แสดงทันทีบน Dashboard
```

**นี่คือค่าต่ำสุดที่เป็นไปได้จริงบน LINE Platform** — ไม่มีทาง reduce ต่อได้อีกโดยไม่ละเมิดข้อจำกัดของ LINE เอง Wizard ควรออกแบบเป็น checklist step-by-step พร้อมปุ่ม "เปิด Console" ที่ deep-link ตรงไปยังหน้าที่ต้องกดของแต่ละ Step, ปุ่ม "ตรวจสอบอีกครั้ง"/"ยังติดขัด ติดต่อ Support" กำกับทุก step (ซ่อนศัพท์ technical ให้มากที่สุดเท่าที่ทำได้)

### Error/Status ที่ต้องรองรับ

- `Login Channel ยังไม่ Link กับ OA` → แนะนำกลับไป Step 3 พร้อม deep-link
- `OA ที่เลือก Link ไม่ตรงกับ OA ที่กรอก Messaging Channel ID` → validate ก่อนดำเนินการ Step 5
- `Token issuance ล้มเหลว` (ID/Secret ผิด) → แจ้ง error ชัดเจนพร้อมให้แก้ค่าแล้วลองใหม่

### Customer-side (ลูกค้าสมัครสมาชิกร้านหนึ่ง)

```
1. ลูกค้าสแกน QR/กดลิงก์ร้าน → เปิด LIFF ของร้านนั้น (ผูกกับ LINE Login Channel ของร้านนั้น)
2. liff.login() → ได้ id_token
3. ส่ง id_token ไป Backend → Backend verify (หัวข้อ 21) → ได้ verified lineUserId (= sub claim)
4. resolveOrCreatePlatformCustomer(provider='line', providerScope=lineProviderId, subject=verified sub, verified=true)
5. สร้าง/หา Membership(platformCustomerId, merchantId) พร้อม merchantLineIdentity = { channelId, lineUserId, linkedAt }
6. Member Card / Points / Coupon ของร้านนี้พร้อมใช้ทันที — "เพิ่มเพื่อน" เป็น optional สำหรับรับการแจ้งเตือนเท่านั้น ไม่ใช่เงื่อนไขการเป็นสมาชิก
```

**Cross-merchant identity linking** เป็น opt-in ผ่านเบอร์โทร/อีเมลที่ verify แล้วเท่านั้น (ดูรายละเอียดเต็มในหัวข้อ 6) — เพราะแม้ userId จะ deterministic ภายใน 1 Provider แต่ merchant A และ B เป็นคนละ Provider กันเสมอ userId ของลูกค้าคนเดียวกันที่ merchant A กับ merchant B จึงต่างกันเสมอ ไม่มีทาง auto-merge จาก LINE ได้

---

## 21. LINE ID Token Backend Verification

### หลักการ (Security Note บังคับ — ไม่มีข้อยกเว้น)

`liff.getProfile()` เป็นการเรียกฝั่ง **client (browser/LIFF SDK)** — ค่า `userId` ที่ได้จากตรงนี้ หรือค่าใดๆ ที่ client ส่งมาใน request payload (ไม่ว่าจะอ้างว่าเป็น LINE userId หรือ profile ใดก็ตาม) **ถือเป็น untrusted input เสมอ** — client สามารถถูกแก้ไข/ปลอมแปลงให้ส่งค่าอะไรก็ได้

### ข้อบังคับสำหรับทุก Flow ที่ resolve/create PlatformCustomer และ Membership

```
Client (LIFF):
  liff.login() → ได้ id_token (JWT) จาก LINE โดยตรง
  → ส่ง id_token ไปให้ Backend เท่านั้น (ไม่ส่ง userId/profile ที่อ่านจาก client SDK ไปตรงๆ)

Backend (Cloud Function / API Route):
  1. รับ id_token จาก client
  2. เรียก LINE Verify ID Token endpoint (หรือ verify JWT signature/claims ตาม LINE spec:
     aud=loginChannelId, iss ถูกต้อง, exp ยังไม่หมดอายุ)
  3. ใช้ค่า `sub` (subject) ที่ได้จากผล verify ของ LINE เท่านั้น เป็น lineUserId ที่แท้จริง
     — ค่านี้เท่านั้นที่นำไปใช้ใน resolveOrCreatePlatformCustomer()
  4. ถ้า verify ล้มเหลว (signature ผิด, aud ไม่ตรงกับ Login Channel ID ของ merchant นั้น, token หมดอายุ)
     → ปฏิเสธ request ทันที ไม่สร้าง/แก้ไข PlatformCustomer หรือ Membership ใดๆ
```

`resolveOrCreatePlatformCustomer(provider, providerScope, subject, verified)` **ต้องรับ `subject` ที่มาจากผล verify ฝั่ง Backend เท่านั้น** สำหรับ `provider !== 'manual'` — implementation ต้อง reject ถ้า `verified=false` สำหรับ provider เหล่านี้

### เพิ่มเข้า Security Threat Checklist

Client ปลอม LINE userId ผ่าน request payload เพื่อสวมสิทธิ์ Membership ของคนอื่น — ป้องกันด้วยการ verify ID Token ทุกครั้งตามข้างต้น ไม่เชื่อค่าใดๆ ที่ client อ้างว่าเป็น LINE identity โดยไม่ verify

---

## 22. LineClientProvider Abstraction

### หลักการ

Architecture นี้เลือกใช้ **LIFF + LINE Login Channel** เป็น implementation ของ V1 แต่ LINE มีทางเลือกใหม่ในระบบนิเวศคือ **LINE MINI App** ซึ่งอาจเป็นทิศทางที่ LINE ผลักดันในอนาคต (LINE เริ่มแนะนำ "LINE MINI App channel" เป็นทางเลือกคู่กับ LINE Login channel สำหรับ LIFF app ใหม่) ระบบจึงต้อง**ไม่ผูก Business Logic ของ Customer Portal เข้ากับ LIFF SDK โดยตรง**จนเปลี่ยนไปใช้ช่องทางอื่นไม่ได้ในอนาคต

### แนวทางออกแบบ — Channel Adapter Pattern ระดับ Frontend

```
Customer Portal (Business Logic: Member Card, Points, Rewards, Coupons, History)
  → ไม่เรียก liff.* API ตรงจาก component/page logic
  → เรียกผ่าน interface กลาง: LineClientProvider { login(), getIdToken(), getContext() }
      → LiffClientProvider  (implementation ปัจจุบันของ V1, wrap LIFF SDK)
      → [MiniAppClientProvider]  (implementation สำรองในอนาคต ถ้าพิจารณาย้ายไป LINE MINI App)
```

### หลักการที่ต้องยึดตั้งแต่ Phase 2 (Customer Portal Skeleton)

- Route/Component ของ Customer Portal (`/m/[merchantSlug]/...`) เขียนแยกจาก provider-specific SDK call — เรียกผ่าน adapter interface กลางเท่านั้น **ห้ามเรียก `liff.getProfile()`, `liff.login()`, `liff.getIdToken()` ฯลฯ ตรงจากหน้า UI/business logic**
- ค่าที่ Backend ต้องการ (ID Token สำหรับ verify ตามหัวข้อ 21) รับผ่าน interface เดียวกันนี้ — ไม่ว่าที่มาจะเป็น LIFF หรือ MINI App ในอนาคต รูปแบบ payload ที่ส่งเข้า Backend (`{ idToken }`) เหมือนเดิม ไม่กระทบ Backend Verification Logic เลย
- Data Model (`memberships.merchantLineIdentity`, `customerIdentities`) **ไม่ผูกกับคำว่า "LIFF" ในชื่อ field ใดๆ** — ใช้คำว่า `channelId`, `lineUserId` ที่เป็นกลาง

### ขอบเขต (ป้องกัน Over-engineering)

**V1 ยัง implement ด้วย LIFF เท่านั้น** — ข้อนี้ไม่ได้สั่งให้สร้าง MINI App หรือสร้าง adapter หลายตัวจริงใน V1 เพียงแต่กำหนดว่า **จุดต่อ (interface boundary) ต้องถูกวางไว้ตั้งแต่แรก** เพื่อให้การย้ายในอนาคต (ถ้าตัดสินใจย้าย) เป็นการ implement adapter ใหม่ 1 ตัว ไม่ใช่การรื้อ Customer Portal ทั้งหมด

**Definition of Done**: Phase 2 ต้องสร้าง `LineClientProvider` interface ตั้งแต่ skeleton แรก; Phase 7 (LINE Integration) ต้องมี automated test สำหรับ Backend ID Token verification ก่อนถือว่าเสร็จ

---

## 23. Notification Architecture

### Channel Adapter Pattern

```
Domain Service (Automation/Points/Reward/...)
  → NotificationService.send({ merchantId, membershipId, templateType, variables })
    → เลือก channel ที่ merchant เปิดใช้ (notificationSettings)
    → เรียก ChannelAdapter (LineAdapter ตอนนี้, EmailAdapter ในอนาคต)
    → เขียน notificationLog (status: sent/failed)
    → เขียน event "notification.sent"/"notification.failed"
```

Domain Logic **ไม่รู้จัก LINE เลย** — คุยผ่าน interface `ChannelAdapter.send()` เท่านั้น ทำให้เพิ่ม channel ใหม่ (Email, SMS ในอนาคต — นอก scope V1) โดยไม่แตะ business logic

### Template + Preview

`notificationSettings/{merchantId}` เก็บ template ต่อ event type พร้อม placeholder variables (`{{memberName}}`, `{{points}}`) — merchant เปิด/ปิดได้ต่อ event type: Points Earned/Used, Reward Available/Redeemed, Coupon Issued/Expiring/Used, Welcome Member, Promotion — Dashboard ต้อง render preview ด้วยข้อมูลตัวอย่างก่อนบันทึกเสมอ

### Retry Policy

Retry แบบ exponential backoff จำกัด 3 ครั้งใน Cloud Function เมื่อส่งข้อความ LINE ล้มเหลว (rate limit, token expired) แล้ว mark failed พร้อม error ให้ Owner เห็นใน LINE connection status

### Broadcast / Campaign

Owner ส่งได้ตาม Segment (All/Active/At Risk/Inactive/VIP/Points≥X/Has Coupon/Custom Segment ในอนาคต) — Flow: Select Audience → Compose → Preview → Test Send → Schedule/Send → Report

---

## 24. Reports

### Snapshot Pattern (บังคับ — ห้ามคำนวณสดทุกครั้ง)

Report ต้อง**ไม่คำนวณสด**จาก raw data ทุกครั้งเพราะ (1) แพง (2) เปลี่ยน setting วันนี้ต้องไม่กระทบ report เก่า

```
Scheduled Cloud Function (daily/weekly/monthly ตาม merchant.reportSettings)
  → Aggregate จาก events + pointsLedger + voucherInstances + couponInstances ของ period นั้น
  → เขียน reports/{id} พร้อม snapshotData{} แบบ frozen
  → ส่งผ่าน channel ที่เลือก (Dashboard/LINE ตอนนี้, Email อนาคต)
```

Dashboard KPI real-time ใช้ **aggregate collection แยก** (`merchantDailyStats/{merchantId_date}`) อัปเดตแบบ incremental จาก event trigger แทนการ query ledger ทั้งหมดทุกครั้งที่เปิดหน้า Dashboard — ลด read cost และเร็วกว่า

### ห้ามแสดง Sales Revenue

Report/Dashboard เป็น **Loyalty Metrics เท่านั้น** — schema ไม่มี field ชื่อ "revenue"/"sales" ใน V1 (แต้มไม่เท่ากับยอดขาย) KPI ที่แสดง: Total/New/Active/Returning/At Risk/Inactive/VIP Members, Points Earned/Redeemed, Rewards Redeemed/Used, Coupons Issued/Used, Promotion Performance

### Report Types

Daily/Weekly/Monthly (Custom period เป็น future — schema `periodStart/periodEnd` รองรับ arbitrary period อยู่แล้ว) — Owner เลือกติ๊กได้ว่าจะรับ item อะไร (New Members, Active, Points, Rewards, Coupons, Staff Activity สำหรับ Daily; Growth, Returning, At Risk, Inactive, Promotion Performance สำหรับ Weekly; Membership Growth, Retention, Reward/Coupon Performance, Staff Summary สำหรับ Monthly)

### Report Delivery + History

เลือกได้: Dashboard, LINE, Email (future) — Report ที่สร้างแล้วต้องเก็บ Snapshot เสมอ การเปลี่ยน Settings วันนี้ห้ามเปลี่ยน Report เก่า ต้องมี Report History

---

## 25. Subscription / Packages / Entitlements

### Single Source of Truth (บังคับ — ห้ามเก็บ subscription state ซ้ำ)

```
subscriptions/{merchantId}     // ← Source of Truth เพียงจุดเดียวสำหรับ subscription state
  - packageId, status: TRIAL|ACTIVE|PAST_DUE|GRACE|SUSPENDED|CANCELLED
  - trialEndsAt, currentPeriodEnd
  - overrides?: { memberLimit?, staffLimit?, branchLimit? }   // ข้อตกลงพิเศษนอกเหนือ package มาตรฐาน
  - history: [{ from, to, changedBy, changedAt, reason }]

packages/{packageId}           // จัดการโดย Super Admin เท่านั้น
  - name, memberLimit, staffLimit, branchLimit, features{ automation, advancedReports, segments, ... }, price

merchants/{merchantId}         // ← ห้ามเก็บ subscription field ใดๆ ซ้ำอีก
```

`merchants/{id}` **ต้องไม่เก็บ** `packageId`/`subscriptionStatus`/`trialEndsAt` ซ้ำ — ถ้าจำเป็นต้อง cache เพื่อ performance ต้องตั้งชื่อชัดว่า `subscriptionStatusCache` และ sync ทางเดียวจาก Firestore Trigger เท่านั้น (ห้าม service อื่นเขียน field นี้ตรงๆ) — **default ของ V1 คือไม่มี field นี้เลย** อ่าน `subscriptions/{merchantId}` ตรงทุกครั้ง (2 document reads ไม่แพงที่ scale นี้)

### Entitlement Resolution (คำนวณสด ไม่เก็บเป็น state)

```
resolveEntitlement(merchantId):
  sub = get(subscriptions/{merchantId})
  pkg = get(packages/{sub.packageId})
  return merge(pkg.features/limits, sub.overrides ?? {})
```

### Package Tiers (ตัวเลข/ราคายังไม่ final — Config-driven, ห้าม hard-code)

- **Starter**: ~500 Members, 3 Staff, 1 Branch, Basic Loyalty
- **Pro**: ~3,000 Members, 10 Staff, 3 Branches, Automation, Advanced Reports, Segments
- **Business**: 10,000+ Members, 30 Staff, Multiple Branches, Advanced Permission, Future API/POS options

### Limit Behavior (ห้ามทำลาย Customer Experience)

- 80% → Warning banner ใน dashboard
- 100% → Upgrade warning แต่ operation ที่ไม่ใช่ "สร้างใหม่" ยังทำได้
- Hard limit → บล็อกเฉพาะการสร้างใหม่ (New Member, New Staff) **ไม่ลบ Member หรือ Points**

### Suspended Behavior

Customer portal ยังอ่านได้เสมอ (Member Card, Existing Balance) — Merchant operations บางอย่างถูกปิด: Add Points, New Campaign, New Automation, Broadcast

### Billing (V1 ไม่มี Automatic Subscription Billing)

Super Admin กำหนด Package/Trial/Start/Expiry/Paid/Past Due/Suspended เองผ่าน manual action — เตรียม architecture สำหรับ Payment Gateway ภายหลังแต่ไม่ implement ใน V1

---

## 26. Security Requirements

### Security Principles

Least privilege, Server-side authorization, Tenant isolation, Secure secret storage, No secrets in frontend, Validation, Rate limiting สำหรับ sensitive actions, Idempotency สำหรับ redemption/point operations, Audit logging, Input sanitization, Secure webhook verification, Secure LINE credential handling

**ห้ามเก็บ LINE Secret/Access Token ใน client-accessible Firestore document เด็ดขาด**

### Security Threat Checklist (ฉบับรวม — ต้องตรวจทุกข้อก่อน production)

- [ ] Cross-tenant read/write ผ่านการเดา/แก้ id (ทดสอบทุก collection ที่มี merchantId)
- [ ] Client ปลอมแปลง merchantId ใน request payload → server ต้อง ignore เสมอ
- [ ] **Client ปลอม LINE userId ผ่าน request payload เพื่อสวมสิทธิ์ Membership ของคนอื่น** → ป้องกันด้วย ID Token verification (หัวข้อ 21) เสมอ
- [ ] Privilege escalation ผ่านการแก้ custom claims ฝั่ง client (claims set จาก server เท่านั้น ผ่าน trigger เดียว)
- [ ] LINE secret/token รั่วผ่าน client-readable Firestore doc (ตรวจ security rule ทุก deploy)
- [ ] Webhook spoofing (ไม่ verify signature)
- [ ] Double-submit บน AddPoints/Redeem (ต้องมี idempotency key)
- [ ] Race condition: สอง staff กด redeem coupon/reward เดียวกันพร้อมกัน (ใช้ Firestore transaction lock บน document เดียว)
- [ ] Staff เกิน limit (max points/hour) ผ่านการยิง request ขนาน (enforce ใน transaction ไม่ใช่ check-then-write แยก step)
- [ ] Automation loop/runaway (safety limit ต้องบังคับใช้จริงใน execution path ไม่ใช่แค่ UI)
- [ ] Broadcast spam / message flooding (rate limit ต่อ merchant)
- [ ] Super Admin support mode ไม่ audit
- [ ] Input validation ทุก public-facing form (onboarding, webhook payload, staff input)
- [ ] Sensitive data ใน error message/log ที่ Support เห็น (กรอง PII เกินจำเป็น)
- [ ] Unverified phone/email ถูกใช้เป็น cross-merchant merge key (ต้อง verify ผ่าน OTP/click-confirm เสมอ)

### Server-side Authorization (ย้ำจากหัวข้อ 9-10)

Backend/Cloud Function ตรวจ permission ทุกครั้งจาก custom claims + StaffUser document เสมอ ผ่าน Centralized Authorization Service เดียว — ไม่มี permission check กระจายตาม UI

---

## 27. Idempotency Strategy (General)

ทุก operation ต่อไปนี้ต้องรับ **idempotencyKey** จาก client (generate แบบ UUID ตอนกดปุ่ม, คงค่าเดิมถ้า retry): Add Points, Redeem Reward, Redeem Coupon, Issue Coupon, Automation Action, Webhook

```
Collection: idempotencyKeys/{key}
  - merchantId, operationType, resultRef, createdAt (TTL cleanup ~30 วัน)

Service function:
  1. เช็คว่า key เคยถูกใช้หรือยัง (ภายใน transaction เดียวกับการเขียนจริง)
  2. ถ้าเคย → return ผลลัพธ์เดิม (idempotent replay) ไม่เขียนซ้ำ
  3. ถ้ายัง → ดำเนินการ + บันทึก key พร้อม resultRef ใน transaction เดียวกัน
```

Webhook (LINE) ใช้ event/message ID ของ LINE เองเป็น idempotency key — Automation Action ใช้ deterministic `executionKey` แบบเดียวกัน (ดูหัวข้อ 17) — Points Spend flow ใช้ transaction-embedded idempotency key เดียวกับ FIFO consumption (ดูหัวข้อ 12)

การกดปุ่มซ้ำหรือ network retry ต้อง**ไม่ทำให้แต้ม/คูปองซ้ำ**ไม่ว่ากรณีใดก็ตาม

---

## 28. Firestore Indexes

Composite indexes ที่ต้องมี (ยืนยัน/ปรับตาม query จริงตอน implement):

- `memberships`: `(merchantId, pointsBalance desc)`, `(merchantId, joinedAt desc)`, `(merchantId, platformCustomerId)`, `(merchantId, merchantProfile.phone)`, `(merchantId, merchantProfile.displayName)` (สำหรับ Staff Search)
- `pointsLedger`: `(merchantId, membershipId, createdAt desc)`, `(merchantId, createdAt desc)`
- `pointsLots`: `(merchantId, membershipId, status, expiresAt asc)` (FIFO query), `(merchantId, status, expiresAt asc)` (scheduled expiration job ข้ามทุก membership)
- `pointsLotConsumptions`: `(merchantId, spendLedgerEntryId)`, `(merchantId, lotId)`
- `pointRules`: `(merchantId, type, enabled)`, `(merchantId, branchScope, enabled)`
- `voucherInstances` / `couponInstances`: `(merchantId, membershipId, status)`, `(merchantId, status, expiresAt)`
- `visits`: `(merchantId, membershipId, recordedAt desc)`, `(merchantId, recordedAt desc)`
- `automations`: `(merchantId, trigger.type, status)`, `(merchantId, presentedAs, status)`
- `automationActionExecutions`: lookup ด้วย document ID (executionKey) เป็นหลัก + `(merchantId, automationId, membershipId, createdAt desc)` สำหรับเช็ค safety limit ต่อวัน
- `events`: `(merchantId, type, createdAt desc)`
- `auditLogs`: `(merchantId, createdAt desc)`, `(merchantId, actorId, createdAt desc)`
- `staffUsers`: `(merchantId, status)`
- `customerIdentities`: **ไม่ต้องการ composite index** — lookup ด้วย document ID (deterministic hash) โดยตรงเสมอ

หลักการ: ทุก query ที่ merchant-scoped ควรมี `merchantId` เป็น field แรกของ composite index เสมอ เพื่อให้ query เร็วและ security-rule-friendly

**หมายเหตุ Staff Search**: Firestore prefix-query พอสำหรับ V1 (ยังไม่ตัดสินใจ external search index — ดูหัวข้อ 35)

---

## 29. Backup Strategy

- เปิด **Firestore scheduled backup** (Point-in-time recovery ถ้า plan รองรับ, หรืออย่างน้อย daily export ไป Cloud Storage) ตั้งแต่ Phase 1
- Export แยก bucket ต่อ environment (production/staging) พร้อม retention อย่างน้อย 30 วัน
- Financial/loyalty-critical collections (`pointsLedger`, `pointsLots`, `voucherInstances`, `couponInstances`, `auditLogs`) ควรมี export ความถี่สูงกว่า collection อื่น (รายวันเป็นอย่างน้อย)
- Restore runbook ต้องเขียนและทดสอบจริงอย่างน้อย 1 ครั้งก่อน onboard merchant จริงกลุ่มแรก (Phase 10)
- Region: ใช้ region เดียวกับ production พอสำหรับ V1 (data residency พิจารณาใหม่ถ้าขยายประเทศ)

---

## 30. Monitoring / Error Strategy

- **Cloud Functions error reporting** เชื่อมกับ alert (email/LINE ไปยัง internal team) เมื่อ error rate เกิน threshold หรือ scheduled job ล้มเหลว
- **System Health สำหรับ Super Admin**: เก็บ heartbeat/status ของ Database (Firestore quota/latency), LINE (webhook success rate), Automation Worker (execution queue), Scheduler (last run time ของแต่ละ scheduled job), Reports, Authentication, Error Jobs — เก็บใน `systemHealth/{component}` อัปเดตจาก scheduled self-check function
- **Structured logging**: ทุก Cloud Function log พร้อม `merchantId`, `requestId`, `operationType` เพื่อ trace ปัญหาเฉพาะร้านได้เร็วเวลามี Support Ticket
- Error ที่กระทบ business state (เช่น points ledger เขียนไม่สำเร็จหลังหักไปแล้วบางส่วน) ต้องมี alert ระดับ critical แยกจาก error ทั่วไป
- Super Admin ต้องมี Emergency Control: Suspend Staff, Suspend Merchant Operations, Freeze Points Engine, Disable Automation, Disable Broadcast — แต่แยก Service State (เช่น Freeze Points ไม่ควรทำให้ Customer Member Card ล่ม)

---

## 31. Project Structure (Next.js + Cloud Functions)

```
/app
  /(owner)/dashboard/...          # merchant owner/staff app
  /(member)/m/[merchantSlug]/...  # customer portal (เข้าถึงผ่าน LIFF)
  /(admin)/superadmin/...         # platform admin
  /api
    /webhooks/line/route.ts
    /... REST route ต่อ resource
/modules                          # domain modules — ไม่ผูก UI framework, ใช้ร่วมกันได้ทั้ง Next.js และ Cloud Functions
  /identity
  /membership
  /merchant
  /branch
  /staff
  /rbac                           # Permission Matrix + Authorization Service + Staff Limits
  /points
  /reward
  /coupon
  /promotion-automation
  /notification
    /adapters/line-adapter.ts
  /report
  /billing-entitlement
  /audit
  /event
  /shared (types, firestore-client wrapper, permission-guard, auth-context builder)
/functions                        # Cloud Functions (import จาก /modules — โค้ดชุดเดียว ไม่ duplicate logic)
  /triggers (onStaffUserWrite, onEventCreate, onMembershipUpdate, ...)
  /scheduled (dailyReport, expirePoints, expireCoupons, segmentRecalc, ...)
  /webhooks (line webhook handler ถ้าแยก deploy)
/lib (firebase-admin init, firebase-client init, auth helpers)
/components (ui, shared across surfaces)
```

### หลักการ

- `/modules/*` เป็น pure business logic, import ได้ทั้งจาก Next.js API Route และ Cloud Functions เพื่อไม่ให้ logic ซ้ำสองที่ (สำคัญมากสำหรับ idempotency และความถูกต้องของ points)
- ไม่มี Firestore call ตรงจาก React component สำหรับ write operation ที่มีผลต่อ business state — ต้องผ่าน module service function เสมอ
- Customer Portal component เรียก LINE ผ่าน `LineClientProvider` interface เท่านั้น (หัวข้อ 22)

---

## 32. Cloud Functions / Backend Responsibilities

| ประเภท | ตัวอย่าง | เหตุผลที่ต้องเป็น server-side |
|---|---|---|
| Callable/API Route | AddPoints, RedeemReward, RedeemCoupon, CreateAutomation | ต้อง enforce permission, limit, idempotency |
| Firestore Trigger | `onStaffUserWrite` (ตั้ง custom claims — ทาง**เดียว**ที่ตั้งได้), `onEventCreate` → Automation Engine, `onMembershipUpdate` → segment recalculation | react ต่อ state change แบบ decoupled, และเป็นจุดควบคุม privilege เดียว |
| Scheduled | dailyReportGenerator, pointsExpiration, couponExpiration, inactiveSegmentRecalc, birthdayTrigger, balanceReconciliation | งานที่ไม่ผูกกับ user action |
| Webhook | LINE webhook receiver | ต้อง verify signature, ไม่เปิด client-side |
| Auth Trigger | onCreate staff auth user → (ยังไม่ตั้ง claims ตรงนี้ — claims มาจาก `onStaffUserWrite` เท่านั้นเพื่อความสอดคล้อง) | custom claims ต้องมาจาก server เท่านั้น ผ่าน path เดียว |

Next.js API Route ใช้สำหรับ synchronous request ที่ต้องการ response ทันที (เช่น redeem flow ที่ staff กด confirm) — Cloud Function (background) ใช้สำหรับงานที่ไม่ต้องรอ response ของ user โดยตรง

**หมายเหตุ (Phase 5 Architecture Decision, Locked 2026-08-16)**: `couponExpiration` ในตารางข้างต้นยังไม่ถูกสร้างจริงใน Phase 5/V1 — ใช้ Lazy Expiration แทน (validate `expiresAt` ที่ redeem/use time ทุกครั้ง) รายละเอียดเต็มอยู่ที่หัวข้อ 14 "Coupon Expiration — Lazy Validation for V1"

### Future POS Integration Point (ออกแบบไว้ ไม่ implement ใน V1)

```
POS → Connector → Integration Layer → Normalized Transaction → Loyalty Engine
```

Normalized transaction ประกอบด้วย: `externalOrderId`, `merchantId`, `branchId`, customer/membership mapping, `amount`, `items`, `timestamp`, payment metadata — Architecture ต้องเพิ่ม REST API/Webhook/POS Integration ภายหลังได้**โดยไม่ต้องรื้อ Core Loyalty System**

---

## 33. Phase 1–10 Implementation Plan

**Phase 1 — Foundation**: Repo structure, Next.js + TypeScript setup, Environment configuration, Firebase project (dev/staging/prod), Firebase Auth setup, Global Customer Identity foundation (`platformCustomers`+`customerIdentities`, generic provider — ยังไม่ผูก LINE), Merchant/Branch/Membership schema, Owner/Manager/Staff RBAC (Permission Matrix V1 locked ในหัวข้อ 9 + centralized Authorization Service), Tenant Isolation, Audit foundation, Subscription/Entitlement foundation เฉพาะส่วนที่ต้องใช้, Security Rules + server-side authorization foundation, Automated tests สำหรับ tenant isolation และ RBAC
*ไม่ implement: Points UI/Engine, Rewards, Coupons, Promotions, Automation, Reports, Broadcast, LINE Integration UI, POS, AI*
*Exit: สร้าง merchant + staff + membership ผ่าน script ทดสอบได้, isolation test ผ่าน, RBAC test ผ่านทั้ง Owner/Manager/Staff*

**Phase 2 — Merchant Setup**: Onboarding wizard, Branding config + template, Owner Dashboard skeleton, Staff management UI, Customer Portal skeleton (ยังไม่มี points) — **ต้องสร้าง `LineClientProvider` interface ตั้งแต่ skeleton แรก** (หัวข้อ 22, Definition of Done)
*Exit: Owner สมัคร→สร้างร้าน→ตั้ง branding→เห็น dashboard ว่างได้เอง*

**Phase 3 — Points**: QR Member, Staff Scan flow, Search Member flow, `pointRules` config UI (หัวข้อ 11), Points Ledger + Lots service พร้อม idempotency + staff limit (หัวข้อ 12), Adjustment/Reversal, Points History UI, Visit model (หัวข้อ 15)
*ต้องทดสอบจริงกับ pilot merchant ก่อนไป Phase ถัดไป — ตัดสินใจ Staff Search text matching (Firestore prefix vs external search) ที่ Phase นี้*

**Phase 4 — Rewards**: Reward Template CRUD, Redeem flow, Voucher lifecycle, Staff validation UI, Reward History

**Phase 5 — Coupons**: Coupon Template CRUD, Instance generation, Distribution (manual/segment ก่อน), Redemption flow, Condition validation

**Phase 6 — Promotion/Automation**: Trigger/Condition/Action engine (`automations` collection เดียว — หัวข้อ 16), Safety limits, Test Mode, Event Consumer Idempotency (หัวข้อ 17), Promotion presets (welcome/birthday) ผ่าน `presentedAs`/`marketing` fields

**Phase 7 — LINE**: Merchant LINE connection UI + onboarding wizard (หัวข้อ 20), Webhook + signature verification, **Backend ID Token verification พร้อม automated test** (หัวข้อ 21, Definition of Done), `LiffClientProvider` implementation ของ `LineClientProvider` (หัวข้อ 22), Notification Service + Channel Adapter, Template + Preview, Broadcast + Segment targeting — **spike ทดสอบ LIFF Server API auto-provisioning จริงก่อนเริ่ม Phase นี้เต็มรูปแบบ**

**Phase 8 — Reports**: Aggregate collections (`merchantDailyStats`), Dashboard analytics (loyalty metrics only — ห้าม revenue/sales), Daily/Weekly/Monthly generation, Settings, Report History/Snapshot

**Phase 9 — Platform Admin**: Super Admin dashboard, Merchant list/detail, Package/Entitlement management, Support/View-as-Owner mode + audit ทุกครั้ง, System Health page, Emergency Control

**Phase 10 — Hardening**: Security review เต็มรูปแบบ (checklist หัวข้อ 26), Tenant isolation automated tests, Permission automated tests (Owner/Manager/Staff), Race condition tests (concurrent redeem/points), Idempotency tests, Performance review, Backup restore drill, Monitoring/alert เชื่อมจริง

### Pilot Rollout ผูกกับ Phase

Phase 0 (internal test merchant) ทำคู่ขนานตั้งแต่ปลาย Phase 1 เพื่อ dogfood ทุก phase ถัดไปจริง ก่อนขยายเป็น 3 pilot merchants (หลัง Phase 3-4 พร้อม) → 10 paying (หลัง Phase 7-8) → ~50 (หลัง Phase 10)

### Final Development Rule (ทุกครั้งก่อนเริ่ม Phase ใหม่)

1. สรุปว่าจะทำอะไร
2. บอก Files/Collections ที่จะเพิ่มหรือแก้
3. บอก Security implications
4. บอก Test cases
5. รอ Approval
6. Implement
7. Run tests (typecheck, lint, unit tests, build)
8. สรุปผล
9. Commit งานเป็น logical checkpoint

**ห้ามข้าม Phase โดยไม่ได้รับอนุมัติ — ห้ามเพิ่ม Feature นอก Scope เอง**

---

## 34. Development Rules and Prohibitions

### กฎที่ล็อกและห้ามเปลี่ยนเองโดยไม่ได้รับอนุมัติใหม่

- **ห้ามเปลี่ยน Core Business Rules เองโดยไม่แจ้ง** — ถ้าพบ requirement ที่ขัดกัน, ไม่ปลอดภัย, ทำให้ Data Model มีปัญหา, หรือมีทางออกที่ดีกว่าอย่างมีนัยสำคัญ **ให้หยุดและเสนอทางเลือกพร้อม Trade-off ก่อน Implement**
- **ห้ามเพิ่ม Feature นอก Scope ของ Phase ที่ได้รับอนุมัติ**
- **ห้ามข้าม Phase โดยไม่ได้รับอนุมัติ**
- **ห้ามใส่ secrets จริงใน source code** — ใช้ environment variables / Secret Manager ตาม Architecture เท่านั้น
- **Business-sensitive writes ต้อง server-side เสมอ** — ไม่มีข้อยกเว้น
- **Tenant isolation ต้อง enforce ฝั่ง server เสมอ** — Security Rules เป็นแค่ defense-in-depth ชั้นที่สอง
- **ทุก security-sensitive assumption ต้องมี test** — ไม่ใช่แค่ design doc
- **ห้ามใส่ permission check กระจายตาม UI** — ต้องผ่าน centralized RBAC/authorization service เดียวเท่านั้น
- **ห้าม trust ค่าใดๆ จาก client โดยตรง** สำหรับ merchantId, role, LINE identity — derive จาก verified token/claims เสมอ (หัวข้อ 3, 21)
- **ห้าม hard-code**: Business-specific logic ต่อประเภทร้าน, Staff Limits, Package Limits, Segment threshold (inactive days ฯลฯ), Timezone เป็นไทยทั้งระบบ — ทั้งหมดต้อง config-driven
- **ห้าม auto-merge Customer Identity** จาก LINE userId, display name, หรือรูปโปรไฟล์ — merge ได้เฉพาะผ่าน verified phone/email เท่านั้น
- **ห้ามแสดง Sales Revenue/Analytics** ถ้าไม่มีข้อมูลจาก POS ที่เชื่อถือได้
- **ห้าม hard delete** ข้อมูล Points Transaction หรือ Financial/Loyalty event ใดๆ — ใช้ Reversal pattern เสมอ
- **ห้ามแก้ Audit Log** ไม่ว่าจากที่ใด แม้แต่ Super Admin ผ่าน Dashboard ปกติ
- **ก่อนเลือก library เพิ่มเติม ให้เสนอเหตุผลก่อนเสมอ** และหลีกเลี่ยง dependency ที่ไม่จำเป็น

### ข้อสำคัญของรอบนี้ (Implementation Restart)

- **ห้ามใช้ Code ที่เคยทดลองสร้างใน environment ทดลองก่อนหน้าเป็น Source of Truth** — GitHub repository จริงว่างอยู่ Implementation เริ่มใหม่ทั้งหมดใน GitHub Codespaces โดยยึดตามเอกสารนี้เท่านั้น
- ก่อนเริ่ม Phase ใดๆ ให้ตรวจสอบเอกสารนี้ทั้งหมดอีกครั้ง สรุป Implementation Plan, ระบุ files/folders, Firestore collections, Security Rules, automated tests ที่จะทำ, และตรวจว่าไม่มีสิ่งใดขัดกับเอกสารนี้ — **ก่อนแก้ไฟล์จริง**

### Self-Service Priority Rule (ย้ำ)

ก่อนสร้าง feature ใดๆ ถามเสมอ: Owner ร้านทั่วไปสามารถตั้งค่านี้เองได้หรือไม่ โดยไม่ต้องโทรหา Support? ถ้าไม่ได้ ให้ปรับ UX ก่อนเพิ่ม complexity

---

## 35. Remaining Open Decisions

รายการนี้เป็นสิ่งที่**ยังไม่ล็อก** — ไม่บล็อกการเริ่ม Phase 1 แต่ต้องตัดสินใจก่อนถึง Phase ที่เกี่ยวข้อง:

1. **Phone OTP Provider** สำหรับ verified phone identity (Firebase Phone Auth ตรงๆ vs SMS gateway ไทยแยก เพื่อ cost/deliverability) — สำคัญเพราะเป็น anchor ของ cross-merchant linking (หัวข้อ 6) — ตัดสินใจก่อน Phase ที่เปิดใช้ phone verification
2. **Staff Search Text Matching**: Firestore prefix-query (แนะนำเริ่มต้น, พอสำหรับ 500-10,000 members/ร้าน) vs external search index (Algolia/Typesense) — ตัดสินใจที่ Phase 3 ตามการใช้งานจริง
3. **Multi-merchant Staff**: แนะนำ **ไม่รองรับใน V1** (`staffUsers` ผูก 1 คนต่อ 1 merchant) — data model ไม่ปิดโอกาสอนาคต (เปลี่ยนเป็น `staffMerchantAssignments` join collection ได้โดยไม่กระทบ core schema) — ไม่ต้องตัดสินใจตอนนี้
4. **`subscriptionStatusCache`**: default คือ**ไม่สร้าง** field นี้ (อ่าน `subscriptions` ตรงทุกครั้ง) จนกว่าจะมีหลักฐานจาก performance review ว่าจำเป็นจริง (พิจารณาใหม่ที่ Phase 10)
5. **LIFF Auto-provisioning ผ่าน LIFF Server API**: design ตรวจสอบกับ official documentation แล้วว่าทำได้จริง — แนะนำ spike ทดสอบกับบัญชี LINE Developer ของ Platform จริงก่อนเริ่ม Phase 7 เต็มรูปแบบ เพื่อยืนยัน permission/scope ที่ต้องใช้
6. **Firestore-only vs BigQuery export** สำหรับ report หนักๆ ในอนาคต — เลื่อนได้ ไม่ต้องตัดสินใจตอนนี้ พิจารณาเมื่อ report query ช้าเกินไปจริง
7. **Hosting**: Firebase App Hosting (แนะนำ) vs Vercel — ยืนยัน region/latency สำหรับผู้ใช้ไทยระหว่าง implement Phase 1
8. **Custom Role** (เกินกว่า Owner/Manager/Staff) — data model รองรับ permission array ต่อ StaffUser ได้อยู่แล้วในหลักการ ไม่ต้องเปลี่ยน schema เมื่อเปิดใช้ในอนาคต — ไม่ใช่ V1 scope
9. **Audit Log Retention/Archive**: V1 เก็บใน Firestore ตรงๆ พอสำหรับ scale นี้ — ตัดสินใจ archive policy ในอนาคตถ้าจำเป็น

---

## 36. Document Changelog

| เวอร์ชัน | สรุปการเปลี่ยนแปลง | สถานะ |
|---|---|---|
| v1 | System Architecture ฉบับแรก — Modular Monolith, Domain Model, Firestore schema เบื้องต้น, Auth/RBAC/Tenant Isolation, Points Ledger (single delta), Reward/Coupon, Promotion+Automation แยกกัน, LINE ผูกกับ Messaging API Channel โดยตรง (ภายหลังพบว่าผิด), Report/Package/Security/Phase Plan | Superseded (แทนที่บางส่วนโดย v2-v4) |
| v2 | แก้ปัญหาหลัก 8 จุดจาก v1: Global Identity แยกจาก LINE userId + `customerIdentities` index, Merchant-scoped Profile, Points Rules หลายกติกา + Stacking Algorithm, Points Lot/FIFO/Expiration/Reversal, Visit/Activity Model ใหม่, รวม Promotion เข้า Automation, Event Consumer Idempotency, Subscription Single Source of Truth | Superseded บางส่วน (LINE Architecture ใน v2 §1-2 ถูกแทนที่โดย v3) |
| v3 | แก้เฉพาะ LINE Architecture หลังตรวจสอบ official LINE documentation จริง — Provider ต้องมีทั้ง Messaging API Channel + LINE Login Channel (LIFF ผูกกับ Login Channel เท่านั้น ไม่ใช่ Messaging Channel), onboarding flow ปรับให้ Owner ทำ 3 ขั้นตอนใน Console ที่ automate ไม่ได้จริง, แก้นิยาม `providerScope` เป็น `lineProviderId` | Current (แทนที่ v2 §1-2 ทั้งหมด) |
| v4 | เพิ่ม Final Security Notes 2 ข้อ: (1) บังคับ Backend verify LINE ID Token เสมอ ห้าม trust client-supplied userId, (2) แยก Customer Portal ออกจาก LIFF-specific implementation ผ่าน `LineClientProvider` abstraction | Current (เพิ่มเติมจาก v1-v3 ไม่ override) |
| Permission Matrix V1 | ล็อก Permission Matrix ฉบับเต็มของ Owner/Manager/Staff + Staff Limits ก่อนเริ่ม Phase 1 — override ข้อความ "Permission list ตามข้อ 24" ที่กว้างๆ ใน v1 เดิม | Current (Locked) |
| **FINAL-ARCHITECTURE.md (เอกสารนี้)** | รวมทุกเวอร์ชันข้างต้นเป็นฉบับเดียว self-contained ตามลำดับ override: Permission Matrix > v4 > v3 > v2 > v1 — เป็น Source of Truth ปัจจุบันของโปรเจกต์ ใช้แทนการอ้างอิงเอกสาร v1-v4 แยก | **Authoritative — ใช้ไฟล์นี้เป็นหลัก** |
| Phase 2 Staff API Auth Decision | เพิ่มหัวข้อ 8: "Staff/Owner API Authentication Transport" — เอกสารก่อนหน้านี้ไม่เคยระบุ transport mechanism ที่เป็นรูปธรรมสำหรับ Staff/Owner เรียก API Route; มติกำหนดให้ใช้ `Authorization: Bearer <Firebase ID Token>` + `verifyIdToken()` ฝั่ง server ต่อทุก protected API route, ห้ามเก็บ token เองใน localStorage, ยังไม่ใช้ custom session cookie ใน V1 — เป็นการเติมช่องว่าง ไม่ override ข้อความเดิมข้อใด | Current (เพิ่มเติมจากเอกสารเดิม ไม่ override) |
| Phase 5 Coupon Decisions | เพิ่มหัวข้อ 14: (1) "Coupon Usage Limit & Redemption Atomicity" — เอกสารก่อนหน้านี้ระบุ "Usage Limit" เป็นคำแยกจาก "Total Limit"/"Per Member Limit" ในรายการ Conditions โดยไม่นิยามความต่างไว้ และ `couponInstances.status` schema (§5) เป็น one-way `AVAILABLE→USED` อยู่แล้วโดยไม่มี counter field ใดๆ รองรับ multi-use; มติล็อกว่า V1 = 1 instance redeem ได้ 1 ครั้งเท่านั้น ("Usage Limit" = ขอบเขตนี้ ไม่ใช่แนวคิดแยก), redemption ต้อง atomic transaction + idempotent เสมอ, ห้าม implement multi-use เองโดยไม่ขออนุมัติใหม่ — เหตุผล: ตรงกับ schema/Redemption Flow ที่มีอยู่แล้ว, ลดพื้นผิว race-condition ที่ไม่มี spec รองรับ (2) "Coupon Expiration — Lazy Validation for V1" — ตาราง Scheduled ของหัวข้อ 32 ระบุ `couponExpiration` ไว้โดยไม่บอก phase ที่สร้างจริง; มติล็อกว่า Phase 5 ใช้ lazy validation ที่ redeem/use time เท่านั้น (เทียบ `expiresAt` กับ `serverNow` ใน transaction เดียวกับการเขียน, UI derive สถานะได้แต่ไม่ใช่ security boundary), เลื่อน scheduled sweep ไป phase ที่มี scheduled-infrastructure เป็นงานปกติอยู่แล้ว — เหตุผล: หลีกเลี่ยง premature infrastructure complexity ตามหัวข้อ 0, สอดคล้องกับ pattern เดียวกับ Reward's Voucher Expiration ใน Phase 4 — ทั้งสองมติเป็นการเติมช่องว่าง ไม่ override ข้อความเดิมข้อใด ไม่ลบ `couponExpiration` ออกจากตารางหัวข้อ 32 | Current (เพิ่มเติมจากเอกสารเดิม ไม่ override) |
| Phase 6 CHANGE_TIER Decision | เพิ่มหัวข้อ 16 "CHANGE_TIER — Deferred for Phase 6" + note บนหัวข้อ 5's `automations.actions[]`: เอกสารก่อนหน้านี้ระบุ `CHANGE_TIER` เป็น action type ใน `actions[]` enum (§5, §16) โดยไม่เคยนิยาม Membership Tier field/config/effect ใดๆ เลย (คำว่า "tier" ที่อื่นในเอกสารคือ Package Tier ของหัวข้อ 25 ซึ่งคนละแนวคิด); มติล็อกว่า Phase 6 defer `CHANGE_TIER` ทั้งหมด — คง type ไว้ใน enum เพื่อ forward compatibility เท่านั้น, ห้ามเพิ่ม `membership.tier`/tier config/tier rule/tier-changed event ใดๆ, ห้ามปรากฏใน Owner/Staff UI, ห้าม executable โดย automation executor, ความพยายามใช้ตรงผ่าน API ต้องถูกปฏิเสธด้วย deterministic server-side validation, ห้ามคิดค้น effect ต่อ Points/Rewards/Coupons/eligibility/Reporting เอง — Membership Tier ที่แท้จริงรอ architecture/product decision cycle แยกต่างหากในอนาคต — เหตุผล: หลีกเลี่ยงการเดา business rule ที่ไม่มี spec รองรับ ตาม CLAUDE.md, pattern เดียวกับ Coupon's `issuedVia` ค่าที่ยังไม่มี producer (หัวข้อ 14) — เอกสารเดียวกันนี้ยัง reaffirm ว่า `SEND_NOTIFICATION`/`NOTIFY_OWNER` delivery จริงยังคงเป็น Phase 7 scope ตามหัวข้อ 23/33 เดิม (ไม่ใช่มติใหม่ เพียงยืนยันซ้ำ) — เป็นการเติมช่องว่าง ไม่ override ข้อความเดิมข้อใด ไม่ลบ `CHANGE_TIER`/`SEND_NOTIFICATION`/`NOTIFY_OWNER` ออกจาก enum ใดๆ | Current (เพิ่มเติมจากเอกสารเดิม ไม่ override) |
| Phase 6 BIRTHDAY Decision | เพิ่มหัวข้อ 16 "BIRTHDAY — Deferred for Phase 6" + note บนหัวข้อ 5's `automations.trigger{}`: เอกสารก่อนหน้านี้ระบุ `BIRTHDAY` เป็น trigger type ใน `trigger{}` enum (§5, §16) และ "Promotion presets (welcome/birthday)" เป็น Phase 6 DoD (§33) โดยไม่เคยมี field วันเกิดใดๆ อยู่ใน `memberships.merchantProfile` (§5, §7) เลย และไม่มี membership profile-edit capability ใดๆ ที่ implement มาแล้วให้ populate fieldนี้ได้; มติล็อกว่า Phase 6 defer `BIRTHDAY` ทั้งหมด — คง type ไว้ใน enum เพื่อ forward compatibility เท่านั้น, ห้ามเพิ่ม field วันเกิด/profile-edit capability ใหม่, scheduled batch job ของ Phase 6 ห้าม evaluate trigger นี้, "Birthday" preset ห้ามปรากฏใน Owner UI (ส่งมอบเฉพาะ "Welcome" preset), ความพยายามใช้ตรงผ่าน API ต้องถูกปฏิเสธด้วย deterministic server-side validation — Birthday trigger/preset ที่แท้จริงรอ architecture/product decision cycle แยกต่างหากในอนาคตที่จะล็อกนิยาม field วันเกิด (รูปแบบ, PII/consent, ช่องทางกรอกค่า) — เหตุผล: หลีกเลี่ยงการเดา business rule ที่ไม่มี spec รองรับ ตาม CLAUDE.md, หลักการเดียวกับ Phase 6 CHANGE_TIER Decision ด้านบน — เป็นการเติมช่องว่าง ไม่ override ข้อความเดิมข้อใด ไม่ลบ `BIRTHDAY` ออกจาก enum ใดๆ ไม่ลบ "Promotion presets (welcome/birthday)" ออกจากหัวข้อ 33 | Current (เพิ่มเติมจากเอกสารเดิม ไม่ override) |

---

**สถานะ ณ เอกสารนี้**: Architecture ได้รับการอนุมัติแล้วทั้งหมด (v1+v2+v3+v4+Permission Matrix) — การ implementation ยังไม่เริ่มใน GitHub repository จริง (repo ว่างอยู่) เอกสารนี้จัดทำขึ้นเพื่อเป็นจุดเริ่มต้นของการ implementation ใหม่ใน GitHub Codespaces

**STOP** — เอกสารนี้เป็นการรวมเอกสาร Architecture เท่านั้น ไม่มีการเขียน Application Code เพิ่มเติม ไม่มีการเริ่ม Phase ใหม่ใดๆ ทั้งสิ้น
