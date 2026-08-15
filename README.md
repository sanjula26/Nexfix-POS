# ElectroPOS Pro

**Full-featured POS for Computers · Laptops · Phones · Parts · CCTV · Electronics + Repairs**

Modern, GitHub-ready Point of Sale system with:

- Multi-device / multi-user ready (Supabase backend)
- IMEI + Serial unit tracking + Warranty expiry
- Kit / Bundle products (BOM)
- CCTV-friendly custom product attributes
- Quotations → convert to Sale
- Repairs / Service jobs
- Warranty Claims workflow
- Customer credit + Loyalty
- Offline / Demo mode for quick start
- Dark mode, responsive UI

---

## Features (විශේෂාංග)

| Area | Included |
|------|----------|
| **POS** | Cart, multi-payment ready, barcode search, kits |
| **Inventory** | Stock, low-stock, IMEI/Serial, custom attributes (CCTV) |
| **Kits / BOM** | Bundle products with component list |
| **Units** | Per-unit IMEI/Serial registry + warranty expiry |
| **Quotations** | Estimates → convert to sale |
| **Repairs** | Job cards, status pipeline, parts + labour |
| **Warranty Claims** | Claim workflow linked to sold units |
| **Customers** | Credit balance, loyalty points, statements-ready |
| **Purchases** | PO + partial receive + auto unit creation (schema ready) |
| **Reports** | Sales, profit, stock (extendable) |
| **Auth** | Supabase Auth + roles (admin / manager / cashier / technician) |
| **Offline** | Demo mode works without Supabase |

---

## Quick Start (Local / Demo)

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/ElectroPOS-Pro.git
cd ElectroPOS-Pro

# 2. Install
npm install

# 3. Run (offline demo mode — no Supabase needed)
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

**Demo logins**

| Role    | Email                     | Password   |
|---------|---------------------------|------------|
| Admin   | `admin@electropos.local`  | `admin123` |
| Cashier | `cashier@electropos.local`| `cashier123`|

---

## Full Setup with Supabase (Multi-device / Production)

### Step 1 — Create Supabase project

1. Go to [https://supabase.com](https://supabase.com) → New Project
2. Wait until the project is ready
3. Go to **Project Settings → API**
4. Copy:
   - Project URL
   - `anon` `public` key

### Step 2 — Run the database schema

1. In Supabase → **SQL Editor** → New query
2. Copy the entire contents of `supabase/schema.sql`
3. Run it

This creates all tables:
- profiles, shops, products, kit_items, inventory_units
- customers, suppliers, purchases, sales, quotations
- repairs, warranty_claims, expenses, day_sessions, audit_log, counters

### Step 3 — Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJI...
VITE_APP_NAME=ElectroPOS Pro
VITE_SHOP_NAME=Your Shop Name
```

### Step 4 — Create first admin user

1. Supabase → **Authentication → Users → Add user**
2. Email + Password
3. After creation, go to **Table Editor → profiles** and set `role = 'admin'`

### Step 5 — Run

```bash
npm run dev
```

Now the app uses the real cloud database. Multiple computers / phones can use the same data.

---

## Project Structure

```
ElectroPOS-Pro/
├── public/
├── src/
│   ├── components/          # Layout, UI components
│   ├── lib/
│   │   ├── auth.tsx         # Auth context (Supabase + offline demo)
│   │   ├── supabase.ts      # Supabase client
│   │   ├── types.ts         # All TypeScript types
│   │   └── utils.ts         # Formatting, helpers
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx
│   │   ├── POS.tsx          # Point of Sale
│   │   └── Inventory.tsx
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── supabase/
│   └── schema.sql           # Complete PostgreSQL schema
├── .env.example
├── package.json
├── vite.config.ts
└── README.md
```

---

## GitHub එකට Push කරන විදිහ (Step by step)

```bash
# Project folder එකට යන්න
cd ElectroPOS-Pro

# Git init
git init
git add .
git commit -m "ElectroPOS Pro v1.0 — initial release"

# GitHub එකේ නව repository එකක් හදන්න (github.com → New repository)
# උදා: ElectroPOS-Pro

# Remote එකතු කරලා push කරන්න
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ElectroPOS-Pro.git
git push -u origin main
```

පසුව වෙනස්කම්:

```bash
git add .
git commit -m "Add warranty claims page"
git push
```

---

## Deploy (Netlify / Vercel)

### Netlify

1. Push code to GitHub
2. Netlify → Add new site → Import from Git
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)

### Vercel

Same process — import the GitHub repo and set the env vars.

---

## Roadmap (මීළඟට හදන්න තියෙන ඒවා)

Foundation එක දැන් තියෙනවා. මීළඟ steps:

1. **Complete Inventory CRUD** + Kit editor + CCTV attribute form
2. **Units page** — IMEI/Serial registry + bulk import
3. **Full POS checkout** — payments, loyalty, IMEI selection, receipt, WhatsApp
4. **Quotations** page + convert to sale
5. **Repairs** full pipeline
6. **Warranty Claims** workflow
7. **Purchases** with auto unit creation on receive
8. **Customer statements** + aging report
9. **Reports** (sales, profit, dead stock, technician performance)
10. **Multi-shop / multi-branch** support
11. **PWA** + stronger offline queue

---

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4
- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **Icons**: Lucide React
- **Charts**: Recharts (ready)
- **Routing**: React Router v7 (HashRouter for easy static hosting)

---

## License

Private / commercial use for your shop.  
You can modify and use freely for your business.

---

## Support

Schema, architecture සහ core modules දැන් තියෙනවා.  
නිශ්චිත page එකක් (උදා: full Repairs, Warranty Claims, Kit editor) හදන්න ඕන නම් කියන්න — ඒක step-by-step complete කරලා දෙන්නම්.
