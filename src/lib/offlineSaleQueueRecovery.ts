export interface PendingSaleQueueRecoveryOptions<T extends { id: string }> {
  pendingSaleIds: readonly string[];
  sales: readonly T[];
  queuedSaleIds: ReadonlySet<string>;
  enqueueSale: (sale: T) => Promise<void>;
  confirmQueueEntry: (queueId: string) => Promise<boolean>;
  clearRecoveryMarkers: (saleIds: string[]) => Promise<boolean>;
}

/**
 * Rebuild the normalized sale outbox only from a durable local sale record.
 * Recovery markers are removed only after the exact queue key is read back.
 */
export async function recoverPendingSaleQueueIds<T extends { id: string }>(
  options: PendingSaleQueueRecoveryOptions<T>,
): Promise<number> {
  const saleById = new Map(options.sales.map(sale => [sale.id, sale]));
  const confirmedSaleIds: string[] = [];
  let restored = 0;

  for (const saleId of [...new Set(options.pendingSaleIds)]) {
    const sale = saleById.get(saleId);
    // Leave a marker untouched if its sale isn't present in the committed
    // state snapshot. It may be a concurrent state-write window.
    if (!sale) continue;

    const queueId = `sale:${saleId}`;
    if (!options.queuedSaleIds.has(saleId)) {
      await options.enqueueSale(sale);
      restored += 1;
    }
    if (!(await options.confirmQueueEntry(queueId))) {
      throw new Error(`Offline sale ${saleId} is saved locally but its cloud queue entry could not be confirmed.`);
    }
    confirmedSaleIds.push(saleId);
  }

  if (confirmedSaleIds.length && !(await options.clearRecoveryMarkers(confirmedSaleIds))) {
    throw new Error('Offline sale queue was written, but its recovery marker could not be cleared safely.');
  }
  return restored;
}
