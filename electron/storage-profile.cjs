'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROFILE_MANIFEST_FILE = 'nexfix-profile.json';
const PROFILE_FORMAT = 'nexfix-pos-profile';
const PROFILE_MANIFEST_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024;
const LEGACY_IMPORT_DIRECTORIES = Object.freeze(['IndexedDB', 'blob_storage']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;

function isIsoUtc(value) {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validateProfileManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'Manifest must be a JSON object.' };
  }

  const allowedKeys = new Set([
    'format',
    'manifestVersion',
    'profileId',
    'label',
    'dataSchemaVersion',
    'createdAt',
    'updatedAt',
    'shopIdentityFingerprint',
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    return { valid: false, reason: 'Unsupported manifest field(s): ' + unknownKeys.join(', ') + '.' };
  }
  if (value.format !== PROFILE_FORMAT) {
    return { valid: false, reason: 'This folder is not a Nexfix POS profile.' };
  }
  if (value.manifestVersion !== PROFILE_MANIFEST_VERSION) {
    return { valid: false, reason: 'This profile manifest version is not supported.' };
  }
  if (typeof value.profileId !== 'string' || !UUID_PATTERN.test(value.profileId)) {
    return { valid: false, reason: 'Profile ID is missing or invalid.' };
  }
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value.label)) {
    return { valid: false, reason: 'Profile label must contain 1–80 safe characters.' };
  }
  if (!Number.isSafeInteger(value.dataSchemaVersion) || value.dataSchemaVersion < 1) {
    return { valid: false, reason: 'Data schema version is invalid.' };
  }
  if (!isIsoUtc(value.createdAt) || !isIsoUtc(value.updatedAt) || value.updatedAt < value.createdAt) {
    return { valid: false, reason: 'Profile timestamps are invalid.' };
  }
  if (value.shopIdentityFingerprint !== undefined &&
      (typeof value.shopIdentityFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.shopIdentityFingerprint))) {
    return { valid: false, reason: 'Shop identity fingerprint is invalid.' };
  }

  return {
    valid: true,
    manifest: {
      format: PROFILE_FORMAT,
      manifestVersion: PROFILE_MANIFEST_VERSION,
      profileId: value.profileId.toLowerCase(),
      label: value.label.trim(),
      dataSchemaVersion: value.dataSchemaVersion,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(value.shopIdentityFingerprint
        ? { shopIdentityFingerprint: value.shopIdentityFingerprint.toLowerCase() }
        : {}),
    },
  };
}

function createProfileManifest(input) {
  const now = input?.now || new Date().toISOString();
  const candidate = {
    format: PROFILE_FORMAT,
    manifestVersion: PROFILE_MANIFEST_VERSION,
    profileId: input?.profileId,
    label: input?.label,
    dataSchemaVersion: input?.dataSchemaVersion ?? 1,
    createdAt: input?.createdAt || now,
    updatedAt: input?.updatedAt || now,
    ...(input?.shopIdentityFingerprint
      ? { shopIdentityFingerprint: input.shopIdentityFingerprint }
      : {}),
  };
  const result = validateProfileManifest(candidate);
  if (!result.valid) {
    const error = new Error(result.reason);
    error.code = 'ERR_NEXFIX_PROFILE_MANIFEST';
    throw error;
  }
  return result.manifest;
}

function readProfileManifest(profileDirectory) {
  const manifestPath = path.join(profileDirectory, PROFILE_MANIFEST_FILE);
  const linkStat = fs.lstatSync(manifestPath);
  if (linkStat.isSymbolicLink()) throw new Error('Profile manifest cannot be a symbolic link.');
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Profile manifest is not a regular file or exceeds the size limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('Profile manifest is unreadable or contains invalid JSON.');
  }
  const result = validateProfileManifest(parsed);
  if (!result.valid) throw new Error(result.reason);
  return result.manifest;
}

function classifyProfileCandidates(candidates) {
  const valid = [];
  const invalid = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const result = validateProfileManifest(candidate?.manifest);
    if (!result.valid || typeof candidate?.path !== 'string' || !candidate.path.trim()) {
      invalid.push({
        path: typeof candidate?.path === 'string' ? candidate.path : '',
        status: 'invalid',
        reason: result.valid ? 'Profile path is missing.' : result.reason,
      });
      continue;
    }
    valid.push({ path: candidate.path, manifest: result.manifest });
  }

  const byProfileId = new Map();
  for (const candidate of valid) {
    const key = candidate.manifest.profileId;
    const group = byProfileId.get(key) || [];
    group.push(candidate);
    byProfileId.set(key, group);
  }

  const available = [];
  const duplicates = [];
  for (const [profileId, copies] of byProfileId) {
    if (copies.length > 1) {
      duplicates.push({ profileId, status: 'duplicate-copy', copies });
    } else {
      available.push({ ...copies[0], status: 'available' });
    }
  }
  return { available, duplicates, invalid };
}

function isWindowsNetworkPath(value) {
  return /^(?:\\\\\?\\UNC\\|\\\\[^\\]+\\[^\\]+)/i.test(value);
}

function resolveExistingProfileDirectory(rootDirectory, candidateDirectory) {
  if (typeof rootDirectory !== 'string' || typeof candidateDirectory !== 'string' ||
      !rootDirectory.trim() || !candidateDirectory.trim()) {
    throw new Error('A storage root and profile folder are required.');
  }
  if (isWindowsNetworkPath(rootDirectory) || isWindowsNetworkPath(candidateDirectory)) {
    throw new Error('Network locations are not supported for the initial local POS profile.');
  }

  const rootRealPath = fs.realpathSync(rootDirectory);
  const candidateRealPath = fs.realpathSync(candidateDirectory);
  if (!fs.statSync(rootRealPath).isDirectory() || !fs.statSync(candidateRealPath).isDirectory()) {
    throw new Error('The storage root and profile location must be folders.');
  }
  if (fs.lstatSync(candidateDirectory).isSymbolicLink()) {
    throw new Error('A profile folder cannot be a symbolic link.');
  }

  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('The selected profile folder is outside the approved storage root.');
  }
  return candidateRealPath;
}

function getLegacyImportAllowlist(sessionDataDirectory) {
  const rootRealPath = fs.realpathSync(sessionDataDirectory);
  if (!fs.statSync(rootRealPath).isDirectory() || fs.lstatSync(sessionDataDirectory).isSymbolicLink()) {
    throw new Error('Legacy session data must be a real folder.');
  }

  const allowed = [];
  for (const name of LEGACY_IMPORT_DIRECTORIES) {
    const candidate = path.join(rootRealPath, name);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error('Legacy ' + name + ' storage cannot be a symbolic link.');
    }
    if (stat.isDirectory()) allowed.push({ name, path: candidate });
  }
  return allowed;
}


function createManagedProfileDirectory(storageRoot, directoryName, manifestInput) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw new Error('A local POS storage root is required.');
  }
  if (typeof directoryName !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(directoryName) ||
      directoryName === '.' || directoryName === '..') {
    throw new Error('The POS profile folder name contains unsupported characters.');
  }

  const rootStat = fs.lstatSync(storageRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('The selected POS storage root must be a real local folder.');
  }
  const rootRealPath = fs.realpathSync(storageRoot);
  const profileDirectory = path.join(rootRealPath, directoryName);
  const manifest = createProfileManifest(manifestInput);

  // mkdir is an exclusive reservation: if another profile already exists at
  // this name, creation stops without replacing or modifying any existing data.
  fs.mkdirSync(profileDirectory, { recursive: false, mode: 0o700 });
  let fileDescriptor = null;
  let manifestCreated = false;
  try {
    const manifestPath = path.join(profileDirectory, PROFILE_MANIFEST_FILE);
    fileDescriptor = fs.openSync(manifestPath, 'wx', 0o600);
    manifestCreated = true;
    fs.writeFileSync(fileDescriptor, JSON.stringify(manifest, null, 2) + '\\n', 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;

    const verified = readProfileManifest(profileDirectory);
    if (verified.profileId !== manifest.profileId ||
        verified.manifestVersion !== manifest.manifestVersion) {
      throw new Error('The newly created POS profile manifest failed read-back verification.');
    }
    return { directory: fs.realpathSync(profileDirectory), manifest: verified };
  } catch (error) {
    if (fileDescriptor !== null) {
      try { fs.closeSync(fileDescriptor); } catch { /* best effort */ }
    }
    // Roll back only the folder created by this call. If cleanup fails, leave
    // the invalid folder visible for explicit recovery; never auto-adopt it.
    try {
      if (manifestCreated) fs.rmSync(path.join(profileDirectory, PROFILE_MANIFEST_FILE), { force: true });
      fs.rmdirSync(profileDirectory);
    } catch { /* fail closed; caller receives the original creation error */ }
    throw error;
  }
}

module.exports = {
  PROFILE_MANIFEST_FILE,
  PROFILE_FORMAT,
  PROFILE_MANIFEST_VERSION,
  LEGACY_IMPORT_DIRECTORIES,
  createProfileManifest,
  createManagedProfileDirectory,
  validateProfileManifest,
  readProfileManifest,
  classifyProfileCandidates,
  resolveExistingProfileDirectory,
  getLegacyImportAllowlist,
};
