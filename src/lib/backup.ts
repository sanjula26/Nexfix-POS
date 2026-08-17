/**
 * Auto + Manual backup helpers for Nexfix POS.
 * Local JSON backup works offline; cloud backup is optional when configured.
 */

import type { POSState } from './types';
import { idbGetMeta, idbSetMeta } from './db';
import { downloadFile, dkey } from './utils';
import { backupStateToGoogle, isGoogleSyncEnabled } from './driveSync';

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

function hasArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Strictly validate the top-level POS collections before any restore can occur. */
function hasValidStateShape(value: unknown): value is POSState {
  if (!hasPlainObjectShape(value)) return false;
  const state = value as Record<string, unknown>;
  const requiredArrays = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs'];
  if (!requiredArrays.every((key) => hasArray(state[key]))) return false;
  if (!hasPlainObjectShape(state.settings) || !hasPlainObjectShape(state.permissions)) return false;
  if (!hasPlainObjectShape(state.counters)) return false;
  if ('kitItems' in state && !hasArray(state.kitItems)) return false;
  if ('quotations' in state && !hasArray(state.quotations)) return false;
  if ('warrantyClaims' in state && !hasArray(state.warrantyClaims)) return false;
  return true;
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
  try {
    const parsed: unknown = JSON.parse(raw);
    return validateBackup(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate a backup before any restore operation. This intentionally performs
 * no writes: callers can validate first and only then replace application state.
 */
export function validateBackupForRestore(input: unknown): BackupEnvelope {
  if (!validateBackup(input)) {
    throw new Error('Invalid or unsupported Nexfix POS backup. Restore was not performed.');
  }
  return input;
}

export interface BackupOptions {
  download?: boolean;
  cloud?: boolean;
}

/**
 * Manual or auto backup of full state.
 * A cloud failure never advances the successful-backup timestamp when cloud
 * sync is enabled, so the auto-backup scheduler will retry instead of silently
 * treating an unsent cloud backup as complete.
 */
export async function downloadBackup(
  state: POSState,
  kind: 'manual' | 'auto' = 'manual',
  options: BackupOptions = {},
): Promise<{ local: boolean; cloud: boolean }> {
  const wantDownload = options.download !== false;
  const wantCloud = options.cloud !== false && isGoogleSyncEnabled();
  let local = false;
  let cloud = false;
  const payload: BackupEnvelope = {
    _meta: { app: 'Nexfix POS', version: 2, exportedAt: new Date().toISOString(), kind },
    state,
  };

  if (wantDownload) {
    try {
      downloadFile(
        buildBackupFilename(kind === 'auto' ? 'nexfix-auto' : 'nexfix-backup'),
        JSON.stringify(payload, null, 2),
        'application/json',
      );
      local = true;
    } catch { /* local export failed; metadata must not claim success */ }
  }

  if (wantCloud && typeof navigator !== 'undefined' && navigator.onLine) {
    try { cloud = await backupStateToGoogle(payload, kind); } catch { cloud = false; }
  }

  // A configured cloud backup is only successful when the cloud dispatch
  // succeeds. If cloud sync is disabled, a successful local export is enough.
  const successful = wantCloud ? cloud : local;
  if (successful) {
    const now = new Date().toISOString();
    const meta = await idbGetMeta();
    await idbSetMeta(kind === 'auto'
      ? { lastAutoBackupAt: now, backupCount: (meta.backupCount || 0) + 1, ...(cloud ? { lastCloudBackupAt: now } : {}) }
      : { lastManualBackupAt: now, backupCount: (meta.backupCount || 0) + 1, ...(cloud ? { lastCloudBackupAt: now } : {}) });
  }

  return { local, cloud };
}

export function startAutoBackup(getState: () => POSState, onBackup?: (at: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    try {
      const meta = await idbGetMeta();
      if (!meta.autoBackupHours || meta.autoBackupHours <= 0) return;
      const last = meta.lastAutoBackupAt ? new Date(meta.lastAutoBackupAt).getTime() : 0;
      if (Date.now() - last < meta.autoBackupHours * 60 * 60 * 1000) return;
      running = true;
      const result = await downloadBackup(getState(), 'auto', { download: true, cloud: true });
      const cloudRequired = isGoogleSyncEnabled();
      const successful = cloudRequired ? result.cloud : result.local;
      if (successful) onBackup?.(new Date().toISOString());
    } catch { /* retry on next tick */ } finally { running = false; }
  };
  const t0 = window.setTimeout(tick, 5_000);
  const interval = window.setInterval(tick, 15_000);
  return () => { clearTimeout(t0); clearInterval(interval); };
}
