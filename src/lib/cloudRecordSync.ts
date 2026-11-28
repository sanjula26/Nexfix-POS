import { useEffect, useRef, useState } from 'react';
import { idbAcknowledgeCloudRecordQueue, idbGetCloudRecordSyncStatuses, idbListQueue, idbMarkCloudRecordSynced, idbMarkCloudRecordSyncRetry, type CloudRecordSyncEntry, type CloudRecordType, type QueueOp } from './db.ts';
import { getCloudActivityScope, subscribeCloudActivity, type CloudActivityScope } from './cloudActivity.ts';

export interface CloudRecordSyncSnapshot {
  ready: boolean;
  confirmed: Record<string, CloudRecordSyncEntry>;
  pending: Set<string>;
}

const EMPTY_SNAPSHOT: CloudRecordSyncSnapshot = { ready: false, confirmed: {}, pending: new Set() };
const CHANGE_EVENT = 'nexfix:cloud-record-sync-changed';

/** Stable identity for the Cloud tenant/user whose receipt metadata is being displayed. */
export function cloudRecordScopeKey(scope: CloudActivityScope | null): string | null {
  const shopId = scope?.shopId.trim();
  const userId = scope?.userId.trim();
  return shopId && userId
    ? `${encodeURIComponent(shopId)}:${encodeURIComponent(userId)}`
    : null;
}

/**
 * Drop the previous account's receipt snapshot immediately after a scope switch.
 * A new scope remains in CHECKING state until its own IndexedDB records are loaded.
 */
export function resetCloudRecordSyncSnapshotForScope(
  previousScopeKey: string | null | undefined,
  nextScopeKey: string | null,
): CloudRecordSyncSnapshot | null {
  if (previousScopeKey === nextScopeKey) return null;
  return nextScopeKey === null
    ? { ready: true, confirmed: {}, pending: new Set() }
    : { ready: false, confirmed: {}, pending: new Set() };
}

export function cloudRecordSyncKey(type: CloudRecordType, recordId: string): string {
  return `${type}:${encodeURIComponent(recordId)}`;
}
 
/** A queued transaction may only be replayed into the exact authenticated shop/user that created it. */
export function isCloudRecordReplayScopeValid(
  queuedScope: Partial<CloudActivityScope> | null | undefined,
  verifiedScope: CloudActivityScope | null | undefined,
  activeScope: CloudActivityScope | null | undefined,
): boolean {
  const shopId = queuedScope?.shopId?.trim();
  const userId = queuedScope?.userId?.trim();
  return Boolean(
    shopId && userId &&
    verifiedScope?.shopId?.trim() === shopId &&
    verifiedScope?.userId?.trim() === userId &&
    activeScope?.shopId?.trim() === shopId &&
    activeScope?.userId?.trim() === userId
  );
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

/** Record a retryable attempt failure under the queued record's original shop/user scope. */
export async function markCloudRecordSyncRetry(
  type: CloudRecordType,
  recordId: string,
  operation: string,
  error: unknown,
  scope: CloudActivityScope | null = getCloudActivityScope(),
): Promise<boolean> {
  if (!scope) return false;
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const safeError = raw
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted credential]')
    .replace(/https?:\/\/[^\s]+/gi, '[Cloud request]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220) || 'Cloud did not confirm this record.';
  const saved = await idbMarkCloudRecordSyncRetry(
    scope.shopId, scope.userId, type, recordId, operation, safeError,
  );
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
): 'checking' | 'synced' | 'pending' | 'retry' | 'unknown' {
  if (!snapshot.ready) return 'checking';
  const key = cloudRecordSyncKey(type, recordId);
  if (snapshot.confirmed[key]?.status === 'retry') return 'retry';
  if (snapshot.pending.has(key)) return 'pending';
  if (snapshot.confirmed[key]) return 'synced';
  return 'unknown';
}

export function getCloudRecordSyncIssue(
  snapshot: CloudRecordSyncSnapshot,
  type: CloudRecordType,
  recordId: string,
): string | null {
  const entry = snapshot.confirmed[cloudRecordSyncKey(type, recordId)];
  return entry?.status === 'retry' ? entry.error || 'Cloud did not confirm this record.' : null;
}

export function getPendingCloudRecordKeys(
  queue: QueueOp[],
  scope: CloudActivityScope,
): Set<string> {
  const pending = new Set<string>();
  for (const item of queue) {
    if (item.type !== 'sale_create' && item.type !== 'purchase_receive') continue;
    try {
      const payload = JSON.parse(item.payload) as {
        cloudScope?: { shopId?: string; userId?: string };
      };
      // A queued transaction is pending only for the Cloud identity that owned it when it was queued.
      // Legacy/unscoped rows stay unverified rather than being attributed to the wrong account.
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
  return pending;
}

/** Read per-record Cloud confirmations and pending queue IDs for the active Cloud shop/user only. */
export function useCloudRecordSyncSnapshot(): CloudRecordSyncSnapshot {
  const [snapshot, setSnapshot] = useState<CloudRecordSyncSnapshot>(EMPTY_SNAPSHOT);
  const scopeKeyRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let revision = 0;

    const refresh = async () => {
      const requestRevision = ++revision;
      const scope = getCloudActivityScope();
      const nextScopeKey = cloudRecordScopeKey(scope);
      const resetSnapshot = resetCloudRecordSyncSnapshotForScope(scopeKeyRef.current, nextScopeKey);
      scopeKeyRef.current = nextScopeKey;
      if (resetSnapshot) setSnapshot(resetSnapshot);
      if (!scope) return;

      try {
        const [confirmed, queue] = await Promise.all([
          idbGetCloudRecordSyncStatuses(scope.shopId, scope.userId),
          idbListQueue(),
        ]);
        const pending = getPendingCloudRecordKeys(queue, scope);
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
