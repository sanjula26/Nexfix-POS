export type UserPasswordSaveResult =
  | { ok: true; password: string; hashRequired: boolean }
  | { ok: false; reason: 'password_too_short' };

/**
 * Resolve the password field for a managed-user save.
 * Hash creation remains caller-owned so this helper stays deterministic.
 */
export function resolveUserPasswordForSave(input: {
  existingPassword?: string;
  suppliedPassword: string;
  suppliedIsHashed: boolean;
  minimumLength?: number;
}): UserPasswordSaveResult {
  const existingPassword = input.existingPassword;
  const suppliedPassword = input.suppliedPassword;
  const passwordChanged = existingPassword === undefined || suppliedPassword !== existingPassword;

  if (passwordChanged && suppliedPassword.length < (input.minimumLength ?? 12)) {
    return { ok: false, reason: 'password_too_short' };
  }

  if (!passwordChanged) {
    return { ok: true, password: existingPassword, hashRequired: false };
  }

  return {
    ok: true,
    password: suppliedPassword,
    hashRequired: !input.suppliedIsHashed,
  };
}
