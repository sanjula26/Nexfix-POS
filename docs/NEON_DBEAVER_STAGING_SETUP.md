# Neon PostgreSQL + DBeaver Setup for NexFix POS

This guide prepares a separate Neon test database and a local DBeaver connection. It does NOT migrate production data or change the running POS.

## 1. Create a Neon test project

1. Sign in to the Neon Console using the owner's account.
2. Create a new project named `nexfix-pos-staging` (do not use the production project name for a test database).
3. Select a region close to the shop's users, subject to Neon Auth/Data API feature availability and latency testing.
4. Keep the default PostgreSQL database and create a dedicated least-privilege role for the application later. Do not use the owner role in the desktop app.
5. Keep the project private; do not enable public database access beyond the provider's normal authenticated connection path.
6. Do not import production data yet. Use a sanitized copy for the first compatibility test.

## 2. Install DBeaver Community

1. Download DBeaver Community only from https://dbeaver.io/download/.
2. Install the Windows x64 installer.
3. Open DBeaver and choose Database > New Database Connection.
4. Select PostgreSQL. Allow DBeaver to download its official PostgreSQL JDBC driver if prompted.

## 3. Connect DBeaver to Neon

1. In Neon Console, open the staging project and click Connect.
2. Select the staging branch, database, and role.
3. Copy the connection details. For DBeaver and schema migration work, select the DIRECT/unpooled connection (hostname does not contain `-pooler`).
4. In DBeaver, fill Host, Port (normally 5432), Database, Username, and Password from the Neon connection modal.
5. Open the SSL tab and set SSL mode to `require` (or stricter certificate verification if configured).
6. Click Test Connection, then Finish.
7. Never paste the full connection string or password into GitHub, screenshots, chat, Vite `.env` variables, or renderer code. Store it in a password manager or protected server-side secret store.

Official references:
- Neon connection details: https://neon.com/docs/get-started/connect-neon
- DBeaver PostgreSQL driver: https://dbeaver.com/docs/dbeaver/Database-driver-PostgreSQL/
- DBeaver SSL configuration: https://dbeaver.com/docs/dbeaver/SSL-Configuration/

## 4. Connection string rules

- DBeaver, pg_dump, and pg_restore: use a direct/unpooled Neon connection.
- Backend services that create many short-lived connections: use the pooled connection string (hostname contains `-pooler`) where supported.
- Do not connect to Neon directly from React renderer/browser code or expose a database password in the Electron app.
- Neon requires SSL; keep `sslmode=require` or stricter.
- Use separate roles for migration/admin work and runtime application access. Grant only the required privileges.

## 5. First connection smoke test

Run these read-only statements in DBeaver's SQL Editor:

```sql
SELECT version();
SELECT current_database(), current_user;
SELECT now();
SELECT ssl_is_used();
```

If `ssl_is_used()` is unavailable in the server version, verify SSL in the DBeaver connection properties instead.

Then inspect the empty staging database. Do not run any production migration or data import until the schema compatibility review is complete.

## 6. NexFix migration safety

- Supabase is currently the source of truth for any data that remains accessible. Keep it intact.
- Obtain a verified database export and restore it locally before importing anything into Neon.
- Supabase Auth users/password hashes and Supabase-specific auth helpers are not automatically portable to Neon Auth.
- Convert and test RLS policies, `auth.uid()` references, RPC functions, triggers, grants, extensions, and storage dependencies before switching application code.
- Do not dual-write sales or credit transactions to Supabase and Neon.
- Keep local IndexedDB login/operations and Google Drive encrypted backup independent from cloud authentication.
- First Windows device authorization must issue a device token stored with Electron safeStorage/Windows DPAPI. Subsequent launches reuse it; network/DNS failures must not erase it. Only explicit revocation or confirmed invalidation should require authorization again.
- R2 stores files and installers, not PostgreSQL relational data. Use a private Cloudflare Worker to authorize update downloads and issue short-lived R2 access.

## 7. Completion gates

A staging setup is ready for application integration only after:
1. DBeaver Test Connection succeeds over SSL.
2. A dedicated runtime role is created and tested with least privilege.
3. A sanitized schema/data import succeeds.
4. Critical SQL functions and RLS deny/allow tests pass.
5. NexFix integration tests cover local login, cloud auth persistence, one-time PC authorization, sales, credit, stock, branch isolation, GRN, IMEI/serial, repairs, backup/restore, and private updater.
6. A rollback rehearsal proves that the old data and local outbox remain recoverable.

No production cutover is authorized by this guide.
