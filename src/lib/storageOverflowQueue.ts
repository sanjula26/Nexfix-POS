import type { QueueOp } from './db.ts';

/**
 * Preserve an offline state-sync marker in the folder snapshot when IndexedDB
 * quota exhaustion prevented the final queue write. Existing markers are kept
 * as-is because queueWrite may have committed its marker before a later
 * multi-record sale enqueue ran out of space.
 */
export function ensureOfflineStateWriteMarker(
  queue: readonly QueueOp[],
  queueMarkerSaved: boolean,
  marker?: { id: string; ts: string },
): QueueOp[] {
  const snapshot = [...queue];
  if (queueMarkerSaved || snapshot.some(operation => operation.type === 'state_write')) {
    return snapshot;
  }
  const nextMarker = marker ?? {
    id: `state-write-migration:${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
  };
  snapshot.push({
    type: 'state_write',
    id: nextMarker.id,
    ts: nextMarker.ts,
    note: 'state_write_offline',
  });
  return snapshot;
}
