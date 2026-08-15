/**
 * Auto + Manual backup helpers for Nexfix POS.
 * - Local JSON download (always works offline)
 * - Optional cloud push to Google Sheets/Apps Script when online
 */

import type { POSState } from './types';
import { idbGetMeta, idbSetMeta } from './db';
import { downloadFile, dkey } from './utils';
import { backupStateToGoogle, isGoogleSyncEnabled } from './driveSync';

export function buildBackupFilename(prefix = 'nexfix-backup'): string {
  const d = new Date();
  const stamp = `${dkey(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${prefix}_${stamp}.json`;
}

export interface BackupOptions {
  /** also download JSON file (default true for manual) */
  download?: boolean;
  /** also push full state to Google when online (default true if sync enabled) */
  cloud?: boolean;
}

/** Manual or auto backup of full state */
export async function downloadBackup(
  state: POSState,
  kind: 'manual' | 'auto' = 'manual',
  options: BackupOptions = {},
): Promise<{ local: boolean; cloud: boolean }> {
  const wantDownload = options.download !== false;
  const wantCloud = options.cloud !== false && isGoogleSyncEnabled();

  let local = false;
  let cloud = false;

  const payload = {
    _meta: {
      app: 'Nexfix POS',
      version: 2,
      exportedAt: new Date().toISOString(),
      kind,
    },
    ...state,
  };

  if (wantDownload) {
    try {
      const json = JSON.stringify(payload, null, 2);
      downloadFile(
        buildBackupFilename(kind === 'auto' ? 'nexfix-auto' : 'nexfix-backup'),
        json,
        'application/json',
      );
      local = true;
    } catch { /* quota / blocked */ }
  }

  if (wantCloud && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      cloud = await backupStateToGoogle(payload, kind);
    } catch { /* ignore */ }
  }

  const meta = await idbGetMeta();
  const patch =
    kind === 'auto'
      ? {
          lastAutoBackupAt: new Date().toISOString(),
          backupCount: (meta.backupCount || 0) + 1,
          ...(cloud ? { lastCloudBackupAt: new Date().toISOString() } : {}),
        }
      : {
          lastManualBackupAt: new Date().toISOString(),
          backupCount: (meta.backupCount || 0) + 1,
          ...(cloud ? { lastCloudBackupAt: new Date().toISOString() } : {}),
        };
  await idbSetMeta(patch as Parameters<typeof idbSetMeta>[0]);

  return { local, cloud };
}

/**
 * Start auto-backup timer.
 * When due: download JSON + push to Google (if online & enabled).
 */
export function startAutoBackup(
  getState: () => POSState,
  onBackup?: (at: string) => void,
): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    try {
      const meta = await idbGetMeta();
      if (!meta.autoBackupHours || meta.autoBackupHours <= 0) return;
      const last = meta.lastAutoBackupAt ? new Date(meta.lastAutoBackupAt).getTime() : 0;
      const due = Date.now() - last >= meta.autoBackupHours * 60 * 60 * 1000;
      if (!due) return;
      running = true;
      // Auto: prefer cloud when online; still download JSON as local safety net
      await downloadBackup(getState(), 'auto', { download: true, cloud: true });
      onBackup?.(new Date().toISOString());
    } catch { /* ignore */ } finally {
      running = false;
    }
  };

  const t0 = window.setTimeout(tick, 8_000);
  const interval = window.setInterval(tick, 60_000);
  return () => {
    clearTimeout(t0);
    clearInterval(interval);
  };
}
