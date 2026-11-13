/** Detect updater authorization failures that can be recovered by issuing one fresh device token. */
export function isUpdaterAuthorizationError(message: string): boolean {
  return /\b401\b|not authorized for private updates|invalid updater device credential|POS device is registered to a different cloud account/i.test(message);
}
