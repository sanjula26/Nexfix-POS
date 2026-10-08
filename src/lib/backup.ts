/**
 * Auto + Manual backup helpers for Nexfix POS.
 * Local JSON backup works offline; cloud backup is optional when configured.
 */

import type { POSState } from './types';
import { idbGetMeta, idbSetMeta } from './db';
import { downloadFile, dkey } from './utils';
import { backupStateToGoogle, getGoogleScriptUrl, isGoogleSyncEnabled } from './driveSync';
import { isValidInventoryTransaction } from './inventoryLedger';

export interface BackupEnvelope {
  _meta: { app: 'Nexfix POS'; version: 2; exportedAt: string; kind: 'manual' | 'auto' };
  state: POSState;
}

export function buildBackupFilename(prefix = 'nexfix-backup'): string {
  const d = new Date();
  const stamp = `${dkey(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${prefix}_${stamp}.json`;
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasPlainObjectShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasArray(value: unknown): value is unknown[] { return Array.isArray(value); }

function hasUniqueStringIds(value: unknown[]): boolean {
  const ids = new Set<string>();
  for (const item of value) {
    if (!hasPlainObjectShape(item) || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

function hasValidCounters(value: Record<string, unknown>): boolean {
  const keys = ['bill', 'po', 'ex', 'job', 'quote', 'claim'];
  if (value.grn !== undefined) keys.push('grn');
  if (value.dn !== undefined) keys.push('dn');
  return keys.every((key) => {
    const n = value[key];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0;
  });
}

/** Strictly validate the top-level POS collections before any restore can occur. */
function hasValidStateShape(value: unknown): value is POSState {
  if (!hasPlainObjectShape(value)) return false;
  const state = value as Record<string, unknown>;
  const requiredArrays = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs'];
  if (!requiredArrays.every((key) => hasArray(state[key]))) return false;
  if (!hasPlainObjectShape(state.settings) || !hasPlainObjectShape(state.permissions)) return false;
  if (!hasPlainObjectShape(state.counters) || !hasValidCounters(state.counters)) return false;
  if ('kitItems' in state && !hasArray(state.kitItems)) return false;
  if ('quotations' in state && !hasArray(state.quotations)) return false;
  if ('warrantyClaims' in state && !hasArray(state.warrantyClaims)) return false;
  if ('purchaseReturns' in state && !hasArray(state.purchaseReturns)) return false;
  if ('supplierPayments' in state && !hasArray(state.supplierPayments)) return false;
  if ('inventoryTransactions' in state && !hasArray(state.inventoryTransactions)) return false;
  if ('grns' in state && !hasArray(state.grns)) return false;
  if ('reverseRequests' in state && !hasArray(state.reverseRequests)) return false;
  const idCollections = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs', 'kitItems', 'quotations', 'warrantyClaims', 'purchaseReturns', 'supplierPayments', 'grns', 'reverseRequests'];
  for (const key of idCollections) {
    const collection = state[key];
    if (collection !== undefined && (!hasArray(collection) || !hasUniqueStringIds(collection))) return false;
  }
  if (state.inventoryTransactions !== undefined) {
    const ledger = state.inventoryTransactions;
    if (!hasArray(ledger) || !ledger.every(isValidInventoryTransaction) || !hasUniqueStringIds(ledger)) return false;
  }
  const users = state.users as unknown[];
  if (!users.every((u) => {
    if (!hasPlainObjectShape(u)) return false;
    return typeof u.id === 'string' && u.id.length > 0
      && typeof u.name === 'string'
      && typeof u.email === 'string'
      && typeof u.password === 'string'
      && (u.role === 'admin' || u.role === 'cashier' || u.role === 'manager' || u.role === 'technician')
      && typeof u.active === 'boolean'
      && typeof u.createdAt === 'string'
      && isValidIsoDate(u.createdAt);
  })) return false;
  return true;
}

function normalizeRestoredState(state: POSState): POSState {
  return {
    ...state,
    kitItems: state.kitItems ?? [],
    quotations: state.quotations ?? [],
    warrantyClaims: state.warrantyClaims ?? [],
    purchaseReturns: state.purchaseReturns ?? [],
    supplierPayments: state.supplierPayments ?? [],
    inventoryTransactions: state.inventoryTransactions ?? [],
    grns: state.grns ?? [],
    reverseRequests: state.reverseRequests ?? [],
  };
}

export function validateBackup(input: unknown): input is BackupEnvelope {
  if (!hasPlainObjectShape(input)) return false;
  const value = input as Partial<BackupEnvelope>;
  const meta = value._meta;
  if (!hasPlainObjectShape(meta)) return false;
  return meta.app === 'Nexfix POS' && meta.version === 2 &&
    isValidIsoDate(meta.exportedAt) &&
    (meta.kind === 'manual' || meta.kind === 'auto') &&
    hasValidStateShape(value.state);
}

export function parseBackup(raw: string): BackupEnvelope | null {
  try { const parsed: unknown = JSON.parse(raw); return validateBackup(parsed) ? parsed : null; } catch { return null; }
}

export function validateBackupForRestore(input: unknown): BackupEnvelope {
  if (!validateBackup(input)) throw new Error('Invalid or unsupported Nexfix POS backup. Restore was not performed.');
  return { ...input, state: normalizeRestoredState(input.state) };
}

export interface BackupOptions { download?: boolean; cloud?: boolean; }

export interface BackupResult { local: boolean; cloud: boolean; error?: string; }

export async function downloadBackup(state: POSState, kind: 'manual' | 'auto' = 'manual', options: BackupOptions = {}): Promise<BackupResult> {
  // Automatic/reconnect backups are cloud-only. A local JSON file is an explicit manual action.
  const wantDownload = kind === 'manual' && options.download !== false;
  const wantCloud = options.cloud !== false && isGoogleSyncEnabled();
  let local = false;
  let cloud = false;
  let errorMessage: string | undefined;
  const payload: BackupEnvelope = { _meta: { app: 'Nexfix POS', version: 2, exportedAt: new Date().toISOString(), kind }, state };
  if (wantDownload) {
    try {
      downloadFile(buildBackupFilename('nexfix-backup'), JSON.stringify(payload, null, 2), 'application/json');
      local = true;
    } catch { /* metadata must not claim local success */ }
  }
  if (wantCloud && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const result = await runCloudBackupSerialized(state, kind);
      cloud = result.ok;
      if (!result.ok) {
        const rawError = result.error || 'Google Drive backup failed';
        errorMessage = rawError.toLowerCase().includes('rate limit')
          ? 'Google backup is temporarily busy. Please retry shortly.'
          : rawError;
      }
      if (!result.ok) console.error('[Google Backup] cloud backup failed:', errorMessage);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Google Drive backup failed';
      console.error('[Google Backup] cloud backup failed:', errorMessage);
      cloud = false;
    }
  }
  const successful = local || cloud;
  if (kind === 'auto') {
    const meta = await idbGetMeta();
    if (cloud) {
      // Automatic success is cloud-authoritative: only a confirmed Drive write
      // advances the auto schedule and clears its durable retry state.
      const now = new Date().toISOString();
      await idbSetMeta({
        lastAutoBackupAt: now,
        lastCloudBackupAt: now,
        lastCloudBackupError: undefined,
        backupCount: (meta.backupCount || 0) + 1,
        pendingAutoBackupAt: undefined,
        nextAutoBackupRetryAt: undefined,
        autoBackupFailureCount: 0,
      });
    } else if (errorMessage) {
      // Never advance lastAutoBackupAt on a failed cloud upload. The scheduler
      // owns retry timing and will keep the pending marker alive.
      await idbSetMeta({ lastCloudBackupError: errorMessage });
    }
  } else if (successful || errorMessage) {
    const now = new Date().toISOString();
    const meta = await idbGetMeta();
    await idbSetMeta({
      lastManualBackupAt: now,
      backupCount: (meta.backupCount || 0) + 1,
      ...(cloud ? { lastCloudBackupAt: now, lastCloudBackupError: undefined } : (errorMessage ? { lastCloudBackupError: errorMessage } : {})),
    });
  }
  return { local, cloud, ...(errorMessage ? { error: errorMessage } : {}) };
}

type GoogleBackupReason = 'settings' | 'sale' | 'interval' | 'manual';

let cloudBackupQueue: Promise<void> = Promise.resolve();

async function runCloudBackupSerialized(
  state: POSState,
  kind: 'manual' | 'auto',
): Promise<{ ok: boolean; error?: string }> {
  const previous = cloudBackupQueue;
  let release!: () => void;
  cloudBackupQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await backupStateToGoogle(state, kind);
  } finally {
    release();
  }
}

// Automatic Google backups are interval-driven by startAutoBackup().


/**
 * Event-driven Google backup scheduler.
 * - Coalesces bursts for 30s.
 * - Never lets a continuous stream of state changes postpone a backup forever:
 *   maximum queue age is 90s.
 * - Failed uploads stay queued and retry after 15s.
 * - The latest full POS state is read only when the upload starts.
 */
export function scheduleGoogleBackup(
  _getState: () => POSState,
  _reason: GoogleBackupReason,
): void {
  // Automatic Google backups are interval-driven by startAutoBackup().
  // State changes may wake the app, but they must not bypass the operator's
  // selected 15m/30m/1h/... interval and create surprise cloud uploads.
  // Keep this function as a compatibility hook for existing callers.
}

export function startAutoBackup(getState: () => POSState, onBackup?: (at: string) => void | Promise<void>): () => void {
  let running = false;
  const RETRY_DELAY_MS = 60_000;
  const tick = async (force = false) => {
    if (running) return;
    try {
      const meta = await idbGetMeta();
      const now = Date.now();
      const online = typeof navigator === 'undefined' || navigator.onLine;
      const intervalHours = Number(meta.autoBackupHours) || 0;
      if (intervalHours <= 0) return;
      // A configured Google backup is the only successful destination for an automatic backup.
      // If no script URL is configured, leave the scheduler idle rather than creating a
      // permanent pending failure that cannot succeed until configuration changes.
      const cloudRequired = isGoogleSyncEnabled() && !!getGoogleScriptUrl();
      if (!cloudRequired) return;

      const last = meta.lastAutoBackupAt ? new Date(meta.lastAutoBackupAt).getTime() : 0;
      const due = now - last >= intervalHours * 60 * 60 * 1000;
      const pending = Boolean(meta.pendingAutoBackupAt);
      const retryAt = meta.nextAutoBackupRetryAt ? new Date(meta.nextAutoBackupRetryAt).getTime() : 0;
      if (!force && !due && !pending) return;
      if (!force && pending && retryAt > now) return;

      // Persist the pending marker before the network operation. This survives tab/browser
      // restarts and ensures a failed upload is retried instead of being silently lost.
      if (!pending) {
        await idbSetMeta({ pendingAutoBackupAt: new Date().toISOString(), autoBackupFailureCount: 0 });
      }
      if (!online) return;

      running = true;
      const result = await downloadBackup(getState(), 'auto', { download: false, cloud: true });
      if (result.cloud) {
        await onBackup?.(new Date().toISOString());
        return;
      }

      const latest = await idbGetMeta();
      const failures = (latest.autoBackupFailureCount || 0) + 1;
      await idbSetMeta({
        pendingAutoBackupAt: latest.pendingAutoBackupAt || new Date().toISOString(),
        nextAutoBackupRetryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        autoBackupFailureCount: failures,
      });
      await onBackup?.(new Date().toISOString());
    } catch {
      // Keep the durable pending marker; the next retry tick will attempt the upload again.
      try {
        const meta = await idbGetMeta();
        await idbSetMeta({
          pendingAutoBackupAt: meta.pendingAutoBackupAt || new Date().toISOString(),
          nextAutoBackupRetryAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
          autoBackupFailureCount: (meta.autoBackupFailureCount || 0) + 1,
        });
        await onBackup?.(new Date().toISOString());
      } catch { /* metadata is best-effort */ }
    } finally { running = false; }
  };
  // Re-check the normal due/pending rules after reconnect; do not force
  // an immediate upload when the configured interval has not elapsed.
  const onOnline = () => { void tick(false); };
  window.addEventListener('online', onOnline);
  const t0 = window.setTimeout(() => { void tick(false); }, 5_000);
  const interval = window.setInterval(() => { void tick(false); }, 15_000);
  return () => { window.removeEventListener('online', onOnline); clearTimeout(t0); clearInterval(interval); };
}