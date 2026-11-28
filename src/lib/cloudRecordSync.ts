import { useEffect, useState } from 'react';
import { idbAcknowledgeCloudRecordQueue, idbGetCloudRecordSyncStatuses, idbListQueue, idbMarkCloudRecordSynced, type CloudRecordSyncEntry, type CloudRecordType } from './db';
import { getCloudActivityScope, subscribeCloudActivity, type CloudActivityScope } from './cloudActivity';

export interface CloudRecordSyncSnapshot {
  ready: boolean;
  confirmed: Record<string, CloudRecordSyncEntry>;
  pending: Set<string>;
}

const EMPTY_SNAPSHOT: CloudRecordSyncSnapshot = { ready: false, confirmed: {}, pending: new Set() };
const CHANGE_EVENT = 'nexfix:cloud-record-sync-changed';

export function cloudRecordSyncKey(type: CloudRecordType, recordId: string): string {
  return `${type}:${encodeURIComponent(recordId)}`;
}

export function notifyCloudRecordSyncChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function markCloudRecordSynced(
  type: CloudRecordType,
  recordId: string,
  operation: string,
  scope: CloudActivityScope | null = getCloudActivityScope(),
): Promise<boolean> {
  if (!scope) return false;
  const saved = await idbMarkCloudRecordSynced(scope.shopId, scope.userId, type, recordId, operation);
  if (saved) notifyCloudRecordSyncChanged();
  return saved;
}

/** Save a positive server acknowledgement and remove its queue item in one IndexedDB transaction. */
export async function acknowledgeCloudRecordQueue(
  scope: CloudActivityScope | null,
  type: CloudRecordType,
  recordId: string,
  queueId: string,
  operation: string,
): Promise<boolean> {
  if (!scope) return false;
  const saved = await idbAcknowledgeCloudRecordQueue(
    scope.shopId, scope.userId, type, recordId, queueId, operation,
  );
  if (saved) notifyCloudRecordSyncChanged();
  return saved;
}

export function getCloudRecordSyncStatus(
  snapshot: CloudRecordSyncSnapshot,
  type: CloudRecordType,
  recordId: string,
): 'checking' | 'synced' | 'pending' | 'unknown' {
  if (!snapshot.ready) return 'checking';
  const key = cloudRecordSyncKey(type, recordId);
  if (snapshot.pending.has(key)) return 'pending';
  if (snapshot.confirmed[key]) return 'synced';
  return 'unknown';
}

/** Read per-record Cloud confirmations and pending queue IDs for the active Cloud shop/user only. */
export function useCloudRecordSyncSnapshot(): CloudRecordSyncSnapshot {
  const [snapshot, setSnapshot] = useState<CloudRecordSyncSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    let active = true;
    let revision = 0;

    const refresh = async () => {
      const requestRevision = ++revision;
      const scope = getCloudActivityScope();
      if (!scope) {
        if (active && requestRevision === revision) setSnapshot({ ready: true, confirmed: {}, pending: new Set() });
        return;
      }

      try {
        const [confirmed, queue] = await Promise.all([
          idbGetCloudRecordSyncStatuses(scope.shopId, scope.userId),
          idbListQueue(),
        ]);
        const pending = new Set<string>();
        for (const item of queue) {
          if (item.type !== 'sale_create' && item.type !== 'purchase_receive') continue;
          try {
            const payload = JSON.parse(item.payload) as {
              cloudScope?: { shopId?: string; userId?: string };
            };
            // A queued transaction is shown as pending only for the Cloud identity
            // that owned it when it was queued. Legacy/unscoped rows remain unverified.
            if (payload.cloudScope?.shopId !== scope.shopId || payload.cloudScope?.userId !== scope.userId) continue;
          } catch {
            continue;
          }
          if (item.type === 'sale_create' && item.id.startsWith('sale:')) {
            pending.add(cloudRecordSyncKey('sale', item.id.slice('sale:'.length)));
          } else if (item.type === 'purchase_receive' && item.id.startsWith('purchase-receive:')) {
            pending.add(cloudRecordSyncKey('purchase', item.id.slice('purchase-receive:'.length)));
          }
        }
        if (active && requestRevision === revision) setSnapshot({ ready: true, confirmed, pending });
      } catch {
        if (active && requestRevision === revision) setSnapshot({ ready: true, confirmed: {}, pending: new Set() });
      }
    };

    const unsubscribe = subscribeCloudActivity(() => { void refresh(); });
    const onRecordSyncChanged = () => { void refresh(); };
    if (typeof window !== 'undefined') window.addEventListener(CHANGE_EVENT, onRecordSyncChanged);
    void refresh();

    return () => {
      active = false;
      revision += 1;
      unsubscribe();
      if (typeof window !== 'undefined') window.removeEventListener(CHANGE_EVENT, onRecordSyncChanged);
    };
  }, []);

  return snapshot;
}
