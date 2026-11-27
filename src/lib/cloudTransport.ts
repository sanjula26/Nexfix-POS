/** Distinguish transport loss from authorization, validation and business errors. */
export function isTransientCloudTransportError(value: unknown): boolean {
  const message = typeof value === 'string'
    ? value
    : value instanceof Error
      ? `${value.name}: ${value.message}`
      : value && typeof value === 'object' && 'message' in value
        ? String((value as { message?: unknown }).message || '')
        : String(value ?? '');
  return /(?:^|\\b)(?:offline|failed to fetch|fetch failed|networkerror|network request failed|load failed|aborterror|err_internet_disconnected|err_network_changed|err_connection_(?:reset|refused|timed_out)|err_name_not_resolved|econnreset|econnrefused|enotfound|etimedout|connection timed out|request timeout|timed out|(?:http\\s*)?(?:408|429|502|503|504)(?:\\s+(?:request timeout|too many requests|bad gateway|service unavailable|gateway timeout))?|bad gateway|service unavailable|gateway timeout)(?:\\b|$)/i.test(message);
}

/**
 * Local fallback is safe only when a cloud transport failed before the atomic
 * sale RPC was sent. Once the RPC may have reached PostgreSQL, reconcile its
 * stable Sale ID instead of creating a second local bill.
 */
export function canFallbackToLocalSaleBeforeRpc(rpcAttempted: boolean | undefined, error: unknown): boolean {
  return rpcAttempted === false && isTransientCloudTransportError(error);
}
