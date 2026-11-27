export class LocalSaleDurabilityError extends Error {
  readonly code = 'LOCAL_SALE_STORAGE_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'LocalSaleDurabilityError';
  }
}

export interface LocalSaleDurabilityDependencies<TSale, TState> {
  saleId: string;
  reserveRecoveryMarker: () => Promise<boolean>;
  createLocalSale: () => TSale | null;
  waitForCommittedState: () => Promise<TState>;
  stateContainsSale: (state: TState, saleId: string) => boolean;
  persistState: (state: TState) => Promise<boolean>;
  readBackState: () => Promise<TState | null>;
  enqueueSale: (sale: TSale) => Promise<void>;
  confirmQueueEntry: (saleId: string) => Promise<boolean>;
  clearRecoveryMarker: () => Promise<boolean>;
  saleNotCreatedMessage: string;
  storageNotConfirmedMessage: string;
}

export interface LocalSaleDurabilityResult<TSale> {
  sale: TSale;
  syncPending: boolean;
}

/**
 * Durability boundary for offline/local POS receipts:
 * 1) write a recovery marker,
 * 2) commit the sale into React state,
 * 3) persist and read back the exact sale from primary local storage,
 * 4) write/read back the normalized cloud outbox entry,
 * 5) only then clear the recovery marker.
 *
 * A failed queue write does not lose a durable local bill: the recovery marker
 * remains, so the next sync pass can rebuild the same stable-ID queue job.
 */
export async function commitLocalSaleDurably<TSale, TState>(
  dependencies: LocalSaleDurabilityDependencies<TSale, TState>,
): Promise<LocalSaleDurabilityResult<TSale>> {
  let markerReserved = false;
  try {
    markerReserved = await dependencies.reserveRecoveryMarker();
  } catch {
    markerReserved = false;
  }
  if (!markerReserved) {
    throw new LocalSaleDurabilityError(dependencies.storageNotConfirmedMessage);
  }

  const sale = dependencies.createLocalSale();
  if (!sale) {
    try { await dependencies.clearRecoveryMarker(); } catch { /* keep a stale marker rather than risk losing a sale */ }
    throw new Error(dependencies.saleNotCreatedMessage);
  }

  let committedState: TState;
  try {
    committedState = await dependencies.waitForCommittedState();
  } catch {
    throw new LocalSaleDurabilityError(dependencies.storageNotConfirmedMessage);
  }
  if (!dependencies.stateContainsSale(committedState, dependencies.saleId)) {
    throw new LocalSaleDurabilityError(dependencies.storageNotConfirmedMessage);
  }

  // A transaction may report an error after commit. Always inspect the primary
  // store before deciding that a sale is not durable.
  try { await dependencies.persistState(committedState); } catch { /* confirm with read-back below */ }

  let durableState: TState | null;
  try {
    durableState = await dependencies.readBackState();
  } catch {
    throw new LocalSaleDurabilityError(dependencies.storageNotConfirmedMessage);
  }
  if (!durableState || !dependencies.stateContainsSale(durableState, dependencies.saleId)) {
    throw new LocalSaleDurabilityError(dependencies.storageNotConfirmedMessage);
  }

  let syncPending = false;
  try {
    await dependencies.enqueueSale(sale);
    if (!(await dependencies.confirmQueueEntry(dependencies.saleId))) {
      throw new Error('The normalized sale queue entry was not confirmed.');
    }
    if (!(await dependencies.clearRecoveryMarker())) syncPending = true;
  } catch {
    // The local bill is already durable; keep the recovery marker for replay.
    syncPending = true;
  }

  return { sale, syncPending };
}
