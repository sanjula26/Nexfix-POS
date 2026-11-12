/**
 * Auto + Manual backup helpers for Nexfix POS.
 * Local JSON backup works offline; cloud backup is optional when configured.
 */

import type { POSState } from './types';
import { idbGetMeta, idbSetMeta } from './db';
import { downloadFile, dkey } from './utils';
import { backupStateToGoogle, getGoogleScriptUrl, isGoogleSyncEnabled } from './driveSync';
import type { BackupEnvelope } from './backupValidation';
export { parseBackup, validateBackup, validateBackupForRestore, type BackupEnvelope } from './backupValidation';

export function buildBackupFilename(prefix = 'nexfix-backup'): string {
  const d = new Date();
  const stamp = `${dkey(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${prefix}_${stamp}.json`;
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