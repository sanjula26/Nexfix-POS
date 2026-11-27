export type StorageQuotaWarning = {
  reason: 'near_quota' | 'quota_exceeded';
  usage?: number;
  quota?: number;
  ratio?: number;
};

export const STORAGE_QUOTA_WARNING_EVENT = 'nexfix:storage-quota-warning';

/** Dispatch the shared quota-warning contract used by persistence and the UI. */
export function dispatchStorageQuotaWarning(target: EventTarget, detail: StorageQuotaWarning): void {
  target.dispatchEvent(new CustomEvent<StorageQuotaWarning>(STORAGE_QUOTA_WARNING_EVENT, { detail }));
}

/** Subscribe to validated quota warnings and return a cleanup function. */
export function subscribeToStorageQuotaWarnings(
  target: EventTarget,
  listener: (detail: StorageQuotaWarning) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<StorageQuotaWarning>).detail;
    if (!detail || (detail.reason !== 'near_quota' && detail.reason !== 'quota_exceeded')) return;
    listener(detail);
  };
  target.addEventListener(STORAGE_QUOTA_WARNING_EVENT, handler);
  return () => target.removeEventListener(STORAGE_QUOTA_WARNING_EVENT, handler);
}


export const STORAGE_PRIMARY_COMMITTED_EVENT = 'nexfix:storage-primary-committed';

/** Notify mounted POS pages after the encrypted profile adapter is active. */
export function dispatchStoragePrimaryCommitted(target: EventTarget): void {
  target.dispatchEvent(new Event(STORAGE_PRIMARY_COMMITTED_EVENT));
}

/** Subscribe to completed encrypted-folder cutovers. */
export function subscribeToStoragePrimaryCommitted(
  target: EventTarget,
  listener: () => void,
): () => void {
  target.addEventListener(STORAGE_PRIMARY_COMMITTED_EVENT, listener);
  return () => target.removeEventListener(STORAGE_PRIMARY_COMMITTED_EVENT, listener);
}
