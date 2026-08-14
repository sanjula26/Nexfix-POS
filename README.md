# Nexfix Solution · POS & Inventory

Electronics shop POS for **computers, laptops, mobiles, accessories**, plus **repairs / service jobs**.

Built with **React 19 + TypeScript + Vite + Tailwind CSS v4**.

Runs fully **online and offline** (IndexedDB + Service Worker). Data stays on the device; export/import JSON backups anytime.

---

## Features

| Area | What you get |
|------|----------------|
| **POS** | Multi-payment (cash/card/bank/mobile/credit), split pay, holds, loyalty points, WhatsApp receipt |
| **Inventory** | Stock, low-stock alerts, categories, cost/margin, barcode |
| **IMEI / Serial** | Per-unit registry, expiry tracking, sale/refund linkage |
| **Repairs** | Job cards, status pipeline, parts + labour, advance payment |
| **Customers / Suppliers** | Credit balance, loyalty, purchase orders |
| **Reports** | Sales, profit, expenses by period |
| **Security** | SHA-256 password hashes, admin PIN, roles, append-only audit log |
| **Offline** | IndexedDB primary store, SW cache, auto-backup schedule, online/offline badge |
| **UX** | Dark mode, Ctrl+K command palette, hardware barcode scanner, thermal print CSS |

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
npm run lint
```

Optional env file:

```bash
cp .env.example .env.local
```

---

## Deploy to Netlify (recommended)

### Option A — Git connected (best)

1. Push this repo to **GitHub**.
2. [Netlify](https://app.netlify.com) → **Add new site** → **Import from Git**.
3. Build settings (usually auto-detected from `netlify.toml`):
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
4. Deploy. Every push to `main` updates the site.

### Option B — CLI

```bash
npm run build
npx netlify deploy --prod --dir=dist
```

### Option C — Drag & drop

```bash
npm run build
```

Zip the `dist/` folder and drop it on [Netlify Drop](https://app.netlify.com/drop).

`netlify.toml` already sets SPA redirects and security headers.

> The app uses **HashRouter** (`#/pos`, etc.), so it works even without server rewrite rules.

---

## GitHub

```bash
git init
git add .
git commit -m "Nexfix POS v2 — production ready"
git branch -M main
git remote add origin https://github.com/YOUR_USER/nexfix-pos.git
git push -u origin main
```

CI workflow (`.github/workflows/ci.yml`) runs `npm ci` + `npm run build` on every push/PR.

Optional GitHub Pages deploy exists in `.github/workflows/deploy.yml` but is **disabled by default**. Prefer Netlify for SPA hosting.

---

## Data & backup

- **Primary store:** IndexedDB (`nexfix_pos_db`)
- **Cache:** `localStorage` key `nexfix_pos_v2`
- **Settings → Data & Backup**
  - Manual JSON export / import
  - Auto-backup interval (OFF / 1h / 3h / 6h / 12h / 24h)
  - Online / offline status + pending queue flush

Import validates structure before applying. Audit log is **append-only**.

---

## Project structure

```
src/
  components/     AppLayout, CommandPalette, ReceiptModal, UI kit
  lib/            store, db (IndexedDB), backup, offline, types, seed, utils
  pages/          POS, Inventory, Units, Repairs, Reports, …
public/
  sw.js           Service worker (offline shell)
  manifest.webmanifest
netlify.toml
```

---

## Tech notes

- Client-side only — no required backend
- Passwords stored as **SHA-256 + salt** (not plaintext)
- PWA-ready (installable)
- Chunk splitting: `react` + `charts` in production build

---

## License

Private / shop use — Nexfix Solution.
