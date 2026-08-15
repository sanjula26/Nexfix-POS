/**
 * Auto + Manual backup helpers for Nexfix POS.
 * Downloads JSON snapshots; tracks last backup times in IndexedDB meta.
 */

import type { POSState } from './types';
import { idbGetMeta, idbSetMeta } from './db';
import { downloadFile, dkey } from './utils';

export function buildBackupFilename(prefix = 'nexfix-backup'): string {
  const d = new Date();
  const stamp = `${dkey(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${prefix}_${stamp}.json`;
}

/** Manual or auto download of full state JSON */
export async function downloadBackup(state: POSState, kind: 'manual' | 'auto' = 'manual'): Promise<void> {
  const json = JSON.stringify(
    {
      _meta: {
        app: 'Nexfix POS',
        version: 2,
        exportedAt: new Date().toISOString(),
        kind,
      },
      ...state,
    },
    null,
    2,
  );
  downloadFile(buildBackupFilename(kind === 'auto' ? 'nexfix-auto' : 'nexfix-backup'), json, 'application/json');
  const patch =
    kind === 'auto'
      ? { lastAutoBackupAt: new Date().toISOString(), backupCount: (await idbGetMeta()).backupCount + 1 }
      : { lastManualBackupAt: new Date().toISOString(), backupCount: (await idbGetMeta()).backupCount + 1 };
  await idbSetMeta(patch);
}

/**
 * Start auto-backup timer.
 * Returns a cleanup function to clear the interval.
 * Checks every minute whether enough hours have passed.
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
      await downloadBackup(getState(), 'auto');
      onBackup?.(new Date().toISOString());
    } catch { /* ignore */ } finally {
      running = false;
    }
  };

  // check shortly after start, then every 60s
  const t0 = window.setTimeout(tick, 8_000);
  const interval = window.setInterval(tick, 60_000);
  return () => {
    clearTimeout(t0);
    clearInterval(interval);
  };
}
