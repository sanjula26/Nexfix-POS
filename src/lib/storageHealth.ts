export type POSStorageStatus = 'checking' | 'healthy' | 'degraded' | 'unavailable';

/** Local POS mutations require a verified, writable IndexedDB state store. */
export function canMutatePOSState(status: POSStorageStatus): boolean {
  return status === 'healthy';
}
