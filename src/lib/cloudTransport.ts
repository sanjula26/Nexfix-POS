/** Distinguish transport loss from authorization, validation and business errors. */
export function isTransientCloudTransportError(value: unknown): boolean {
  const message = typeof value === 'string'
    ? value
    : value instanceof Error
      ? `${value.name}: ${value.message}`
      : value && typeof value === 'object' && 'message' in value
        ? String((value as { message?: unknown }).message || '')
        : String(value ?? '');
  return /(?:^|\b)(?:offline|failed to fetch|fetch failed|networkerror|network request failed|load failed|aborterror|err_internet_disconnected|err_network_changed|err_connection_(?:reset|refused|timed_out)|err_name_not_resolved|econnreset|econnrefused|enotfound|etimedout|connection timed out|request timeout|timed out|(?:http\s*)?(?:408|429|502|503|504)(?:\s+(?:request timeout|too many requests|bad gateway|service unavailable|gateway timeout))?|bad gateway|service unavailable|gateway timeout)(?:\b|$)/i.test(message);
}

/**
 * Local fallback is safe only when a cloud transport failed before the atomic
 * sale RPC was sent. Once the RPC may have reached PostgreSQL, reconcile its
 * stable Sale ID instead of creating a second local bill.
 */
export function canFallbackToLocalSaleBeforeRpc(rpcAttempted: boolean | undefined, error: unknown): boolean {
  return rpcAttempted === false && isTransientCloudTransportError(error);
}

export type LocalSaleFallbackIdResult =
  | { ok: true; saleId?: string }
  | { ok: false; error: string };

/**
 * An ambiguous previous cloud RPC leaves a durable local retry marker. A new
 * local bill must not be created while that marker refers to a different or
 * unknown Sale ID, because the server may already have committed that bill.
 *
 * The matching-ID case is allowed only for a known pre-RPC failure: the caller
 * has already proved rpcAttempted === false and can safely reuse the same ID.
 */
export function resolveLocalSaleFallbackId(input: {
  cloudConfigured: boolean;
  requestedSaleId?: string;
  pendingMarkerRaw: string | null;
  markerReadable?: boolean;
  cloudShopId?: string;
  allowMatchingPendingId?: boolean;
}): LocalSaleFallbackIdResult {
  const requestedSaleId = input.requestedSaleId?.trim() || '';
  if (!input.cloudConfigured) {
    return { ok: true, ...(requestedSaleId ? { saleId: requestedSaleId } : {}) };
  }
  if (input.markerReadable === false) {
    return {
      ok: false,
      error: 'The previous cloud sale retry state cannot be read. No local bill was started; restore local storage and reconcile the last bill before retrying.',
    };
  }

  const raw = input.pendingMarkerRaw?.trim() || '';
  if (!raw) return { ok: true, ...(requestedSaleId ? { saleId: requestedSaleId } : {}) };

  let marker: { saleId?: unknown; shopId?: unknown };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid marker');
    marker = parsed as { saleId?: unknown; shopId?: unknown };
  } catch {
    return {
      ok: false,
      error: 'The previous cloud sale retry state is damaged. No local bill was started; check Sales History and recover the pending sale before retrying.',
    };
  }

  const pendingSaleId = typeof marker.saleId === 'string' ? marker.saleId.trim() : '';
  if (!input.allowMatchingPendingId || !pendingSaleId || !requestedSaleId || pendingSaleId !== requestedSaleId) {
    return {
      ok: false,
      error: 'A previous cloud sale is still awaiting reconciliation. Connect to the original shop and retry/check that bill before starting another local bill; this prevents a duplicate invoice.',
    };
  }

  const pendingShopId = typeof marker.shopId === 'string' ? marker.shopId.trim() : '';
  const currentShopId = input.cloudShopId?.trim() || '';
  if (pendingShopId && pendingShopId !== currentShopId) {
    return {
      ok: false,
      error: 'A previous cloud sale belongs to a different or unresolved shop. Reconcile it with the original shop before starting a local bill.',
    };
  }

  return { ok: true, saleId: pendingSaleId };
}

