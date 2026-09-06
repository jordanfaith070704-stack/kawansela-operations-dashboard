# Kawansela Partner OS — Phase I v10

V10 UI/UX source preserved, with a Next.js + TypeScript production foundation for `dashboard.kawansela.com`.

## What changed from the V10 prototype

- The V10 `index.html` remains untouched as the visual/functional reference.
- The deployable application is now Next.js App Router + TypeScript.
- `/login` uses real Supabase email/password authentication (no demo credentials).
- A membership determines whether a user is a location operator/manager or a Kawansela Master.
- The Supabase migration establishes location-scoped RLS, master-only recipe/catalog management, audit logs, immutable recipe versions, batches, movements, sales, stock counts, reconciliation, payment profiles, and provider event ledgers.
- `create_production_batch` and `record_sale` are atomic server-side database operations that enforce ingredient deduction, 900 ml batches, 150 ml FIFO allocation, packaging usage, COGS, and idempotent POS receipt handling.
- QRIS static mode is supported through `payment_profiles`; provider and Loyverse webhooks have separate server-only boundaries under `app/api/integrations`.

## Product structure

### Location / operator login
- Hari Ini
- Penjualan
  - Live Sales
  - 7-day summary
- Operasi
  - Produksi 900 ml
  - Stok / Stock Opname / Reorder
  - Resep aktif
- Tutup Hari
- Laporan
- Support actions: supply, waste, incident, playbook

### Kawansela Master login
- Overview
- Locations
- Master Recipe
- Inventory & Supplier
- Reports & Audit

## F&B logic included in the prototype
- 900 ml batch production
- 150 ml serving / 6 cups theoretical yield
- raw material deduction at production time
- FIFO ready-batch consumption at sale time
- Loyverse-style sale simulation
- cup + lid deduction per sale
- COGS and operating profit
- waste
- stock opname system vs physical
- stock accuracy / variance
- smart reorder with lead time, safety stock, par level, minimum order, and incoming PO
- receiving and cost update
- opening cash
- cash + QRIS reconciliation at close
- master recipe versioning and publish history
- one login = one Kawansela location

## Demo login
- Jakarta: `jakarta@kawansela.demo` / `lokasi123`
- Singkawang: `singkawang@kawansela.demo` / `lokasi123`
- Master: `central@kawansela.demo` / `master123`

## Deployment to Vercel
Create/import a **new** Vercel project using this folder as the project root. Framework preset: Next.js. Do not link this project to the public Kawansela site project.

Then configure the custom domain `dashboard.kawansela.com` in this new Vercel project and add only the DNS record Vercel provides for the `dashboard` subdomain. This does not require changing the apex `kawansela.com` nor `www` records.

## First production setup

1. Create a separate Supabase project for the dashboard and apply `supabase/migrations/20260906170000_kawansela_phase1.sql`.
2. Add the values in `.env.example` to Vercel Environment Variables. Keep `SUPABASE_SERVICE_ROLE_KEY`, Loyverse, and QRIS values server-side only.
3. Create the first Master account in Supabase Auth, then add its `memberships` row with role `master`. Create each operator as a Supabase Auth user and give them exactly one location membership.
4. Add `https://dashboard.kawansela.com/**` to Supabase Auth redirect URLs.
5. Deploy to Vercel, then attach `dashboard.kawansela.com` to this project only.
6. Run cross-location tests: operator A cannot read/write location B via UI or direct Supabase API; Master can read both; production and POS receipt retries are idempotent.

## Production integrations still required
This prototype intentionally uses browser localStorage and demo Loyverse sales. Before real launch, replace the prototype persistence/login/integration layer with:

1. Server database + production authentication.
2. Location-scoped authorization / tenant isolation.
3. Loyverse API + webhook sync and idempotency ledger.
4. QRIS payment/settlement reconciliation.
5. Server-side audit log and retry/exception queue.
6. Production secrets kept server-side.

Do not expose Loyverse or QRIS secret tokens in frontend JavaScript.
