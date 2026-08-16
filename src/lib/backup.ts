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

export function validateBackup(input: unknown): input is BackupEnvelope {
  if (!input || typeof input !== 'object') return false;
  const value = input as Partial<BackupEnvelope>;
  const meta = value._meta;
  return !!meta && meta.app === 'Nexfix POS' && meta.version === 2 &&
    typeof meta.exportedAt === 'string' && (meta.kind === 'manual' || meta.kind === 'auto') &&
    !!value.state && typeof value.state === 'object';
}

export function parseBackup(raw: string): BackupEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return validateBackup(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface BackupOptions {
  download?: boolean;
  cloud?: boolean;
}

/** Manual or auto backup of full state. A cloud failure never marks the backup as cloud-successful. */
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

  const now = new Date().toISOString();
  const meta = await idbGetMeta();
  await idbSetMeta(kind === 'auto'
    ? { lastAutoBackupAt: now, backupCount: (meta.backupCount || 0) + 1, ...(cloud ? { lastCloudBackupAt: now } : {}) }
    : { lastManualBackupAt: now, backupCount: (meta.backupCount || 0) + 1, ...(cloud ? { lastCloudBackupAt: now } : {}) });

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
      await downloadBackup(getState(), 'auto', { download: true, cloud: true });
      onBackup?.(new Date().toISOString());
    } catch { /* retry on next tick */ } finally { running = false; }
  };
  const t0 = window.setTimeout(tick, 5_000);
  const interval = window.setInterval(tick, 15_000);
  return () => { clearTimeout(t0); clearInterval(interval); };
}
