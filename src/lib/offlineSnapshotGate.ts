const LEGACY_SNAPSHOT_QUEUE_TYPES = new Set(['state_write', 'backup', 'custom']);

/**
 * The legacy full-state snapshot can run only after every normalized atomic
 * transaction has been committed and acknowledged.
 */
export function canUploadLegacySnapshot(pendingQueueTypes: readonly string[]): boolean {
  return pendingQueueTypes.every(type => LEGACY_SNAPSHOT_QUEUE_TYPES.has(type));
}
