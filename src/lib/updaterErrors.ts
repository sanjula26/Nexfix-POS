/** Detect updater authorization failures that can be recovered by issuing one fresh device token. */
export function isUpdaterAuthorizationError(message: string): boolean {
  return /\b401\b|not authorized for private updates|invalid updater device credential|POS device is registered to a different cloud account/i.test(message);
}

/** Clear both native updater credentials before retrying a rejected device token. */
export async function clearUpdaterCredentialsForRecovery(
  clearUpdateCredentials: (() => Promise<unknown> | undefined) | undefined,
  clearDeviceToken: (() => Promise<{ ok?: boolean; error?: string }>) | undefined,
): Promise<{ ok: boolean; error?: string }> {
  if (!clearUpdateCredentials || !clearDeviceToken) {
    return { ok: false, error: 'Secure updater credential reset is unavailable in this Windows POS build.' };
  }
  try {
    const updateResult = await clearUpdateCredentials();
    if (!updateResult || typeof updateResult !== 'object' || (updateResult as { ok?: boolean }).ok !== true) {
      return { ok: false, error: 'Could not clear the active updater credential. The old authorization was kept from being retried.' };
    }
    const deviceResult = await clearDeviceToken();
    if (!deviceResult?.ok) {
      return { ok: false, error: deviceResult?.error || 'Could not clear the saved Windows updater device token.' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not clear stale updater credentials.' };
  }
}
