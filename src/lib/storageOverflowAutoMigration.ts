export type AutomaticOverflowFolder = {
  ok: boolean;
  available: boolean;
  storageMode: 'indexeddb' | 'folder_primary' | 'unknown';
  folderPath: string | null;
};

export type AutomaticOverflowProfile = {
  directory: string;
  profileId: string;
};

export type AutomaticOverflowProfileStatus = {
  unlocked: boolean;
  profile?: { profileId: string };
};

export type AutomaticOverflowDependencies = {
  getFolder: () => Promise<AutomaticOverflowFolder>;
  discoverProfiles: (folderPath: string) => Promise<{
    available: AutomaticOverflowProfile[];
    duplicates: unknown[];
    invalid: unknown[];
  }>;
  getProfileStatus: () => Promise<AutomaticOverflowProfileStatus>;
  unlockWithOS: (directory: string) => Promise<void>;
  migrate: () => Promise<void | boolean>;
};

export type AutomaticOverflowResult =
  | { status: 'migrated'; profileId: string }
  | { status: 'unlock_required'; profileDirectory: string }
  | { status: 'failed' };

/**
 * Validate the pre-provisioned encrypted folder profile and migrate without
 * prompting when the current Windows account can unlock it. If OS unlock is
 * unavailable, return a manual-unlock state; never fall back to stale IDB data.
 */
export async function runAutomaticPOSOverflowMigration(
  dependencies: AutomaticOverflowDependencies,
): Promise<AutomaticOverflowResult> {
  const folder = await dependencies.getFolder();
  if (!folder.ok || !folder.available || folder.storageMode !== 'indexeddb' || !folder.folderPath) {
    throw new Error('The selected POS overflow folder is unavailable. Reconnect it before migration.');
  }

  const discovery = await dependencies.discoverProfiles(folder.folderPath);
  if (discovery.duplicates.length > 0 || discovery.invalid.length > 0 || discovery.available.length !== 1) {
    throw new Error('The selected folder must contain exactly one valid encrypted POS profile. No data was changed.');
  }

  const profile = discovery.available[0];
  const active = await dependencies.getProfileStatus();
  if (active.unlocked && active.profile?.profileId !== profile.profileId) {
    throw new Error('A different encrypted POS profile is already open. Close and reopen Nexfix before migrating.');
  }

  if (!active.unlocked) {
    try {
      await dependencies.unlockWithOS(profile.directory);
    } catch {
      return { status: 'unlock_required', profileDirectory: profile.directory };
    }
  }

  const migrationResult = await dependencies.migrate();
  if (migrationResult === false) return { status: 'failed' };
  return { status: 'migrated', profileId: profile.profileId };
}
