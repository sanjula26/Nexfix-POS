import type { Permissions, Role } from './types';
import { isHashed } from './utils';

export type UserPasswordSaveDecision =
  | { ok: false; reason: 'password_too_short' }
  | { ok: true; mode: 'preserve'; password: string }
  | { ok: true; mode: 'hash'; plain: string };

/**
 * Decide how a supplied user password should be persisted without generating
 * salts or changing hashes. The caller remains responsible for hashing plain
 * passwords and for admin authorization/sensitive-action confirmation.
 */
export function prepareUserPasswordForSave(
  suppliedPassword: string,
  existingPassword?: string,
): UserPasswordSaveDecision {
  const passwordChanged = existingPassword === undefined || suppliedPassword !== existingPassword;
  if (passwordChanged && suppliedPassword.length < 12) {
    return { ok: false, reason: 'password_too_short' };
  }
  if (isHashed(suppliedPassword)) {
    return { ok: true, mode: 'preserve', password: suppliedPassword };
  }
  if (existingPassword !== undefined && suppliedPassword === existingPassword) {
    return { ok: true, mode: 'preserve', password: existingPassword };
  }
  return { ok: true, mode: 'hash', plain: suppliedPassword };
}

/** Build the immutable permission-map update after the caller has authorized it. */
export function applyRolePermissionValue(
  permissions: Permissions,
  role: Exclude<Role, 'admin'>,
  key: string,
  value: boolean,
): Permissions {
  return {
    ...permissions,
    [role]: { ...(permissions[role] || {}), [key]: value },
  };
}
