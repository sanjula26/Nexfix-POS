# Nexfix POS · ElectroPOS Pro

**Electronics shop POS** for computers, laptops, phones, parts, **CCTV**, accessories + **repairs / service jobs**.

Built with **React 19 + TypeScript + Vite + Tailwind CSS v4**.

Runs fully **online and offline** (IndexedDB + Service Worker). Data stays on the device; export/import JSON backups anytime.

---

## What's included

| Area | Features |
|------|----------|
| **POS** | Multi-payment (cash/card/bank/mobile/credit), split pay, holds, loyalty, WhatsApp receipt |
| **Inventory** | Stock, low-stock, categories, cost/margin, barcode |
| **IMEI / Serial** | Per-unit registry, expiry tracking, sale/refund linkage, warranty expiry field |
| **Kits / BOM** | Product `isKit` flag + kit component types (ready for kit editor) |
| **CCTV** | Categories (Cameras, NVR/DVR, Cables, Power) + brands (Hikvision, Dahua, CP Plus, Imou) + product attributes |
| **Quotations** | Create estimates → track status (draft/sent/accepted/converted) |
| **Warranty Claims** | Claim workflow linked to sold units (open → approved/replaced/repaired → closed) |
| **Repairs** | Job cards, status pipeline, parts + labour, advance payment |
| **Customers / Suppliers** | Credit balance, loyalty, purchase orders |
| **Reports** | Sales, profit, expenses by period |
| **Security** | SHA-256 password hashes, admin PIN, roles, append-only audit log |
| **Offline** | IndexedDB primary store, SW cache, auto-backup, online/offline badge |
| **UX** | Dark mode, Ctrl+K command palette, hardware barcode scanner, thermal print CSS |
| **Cloud-ready** | Full Supabase/PostgreSQL schema in `supabase/schema.sql` for multi-device future |

---

## Demo logins

| Role | Email | Password |
|------|--------|----------|
| Admin | `admin@nexfixsolution.com` | `admin123` |
| Cashier | `cashier@nexfixsolution.com` | `cashier123` |

Change these immediately after first login (Users + Settings → admin switch PIN).

---

## Local development

```bash
# Node 20+ recommended
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

```bash
npm run build    # production build → dist/
npm run preview  # serve dist locally
```

---

## Supabase multi-device (optional)

1. Create a project at [supabase.com](https://supabase.com)
2. Run `supabase/schema.sql` in the SQL Editor
3. Copy URL + anon key to `.env` (see `.env.example`)

The client app currently runs fully offline. The schema is ready when you migrate to cloud sync.

---

## Project structure

```
src/
  components/     AppLayout, CommandPalette, ReceiptModal, UI kit
  lib/            store, db (IndexedDB), backup, offline, types, seed, utils
  pages/          POS, Inventory, Units, Repairs, Quotations, WarrantyClaims, Reports, …
public/
  sw.js           Service worker (offline shell)
supabase/
  schema.sql      PostgreSQL schema (products, kits, units, quotes, claims, repairs, …)
```

---

## Deploy (Netlify)

```bash
npm run build
# publish dist/ — or connect GitHub repo to Netlify
```

`netlify.toml` sets SPA redirects and security headers. HashRouter works without server rewrites.

---

## License

Private / shop use — Nexfix Solution.
