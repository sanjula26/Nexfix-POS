'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { assertOutsideProtectedPaths } = require('./folder-guard.cjs');

async function assertNoSymlinkComponents(candidate, fsApi, pathApi) {
  const absolute = pathApi.resolve(candidate);
  const parsed = pathApi.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    current = pathApi.join(current, segment);
    const details = await fsApi.lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error('The selected QA folder path contains a symbolic link or reparse point.');
    }
  }
}

async function canonicalDirectory(candidate, label, fsApi, pathApi, inspectComponents = false) {
  if (typeof candidate !== 'string' || !candidate.trim() || !pathApi.isAbsolute(candidate)) {
    throw new Error(label + ' must be an absolute existing directory.');
  }
  const details = await fsApi.lstat(candidate);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(label + ' must be a real directory, not a link.');
  }
  if (inspectComponents) await assertNoSymlinkComponents(candidate, fsApi, pathApi);
  return fsApi.realpath(candidate);
}

async function prepareQaFolder(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const selectedPath = options.selectedPath;
  const protectedRoots = options.protectedRoots;
  if (!Array.isArray(protectedRoots) || protectedRoots.length === 0) {
    throw new Error('Protected POS storage locations are required.');
  }

  const canonicalSelected = await canonicalDirectory(
    selectedPath,
    'Selected QA folder',
    fsApi,
    pathApi,
    true,
  );
  const canonicalProtected = [];
  for (const root of protectedRoots) {
    canonicalProtected.push(await canonicalDirectory(
      root,
      'Protected POS location',
      fsApi,
      pathApi,
    ));
  }

  assertOutsideProtectedPaths(canonicalSelected, canonicalProtected, pathApi);

  // Create a new child directory atomically; never reuse or clear existing data.
  const qaFolder = await fsApi.mkdtemp(pathApi.join(canonicalSelected, 'Nexfix-Storage-QA-'));
  const canonicalQaFolder = await fsApi.realpath(qaFolder);
  assertOutsideProtectedPaths(canonicalQaFolder, canonicalProtected, pathApi);

  const sentinelPath = pathApi.join(canonicalQaFolder, '.nexfix-storage-qa-sentinel');
  const handle = await fsApi.open(sentinelPath, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({
      application: 'Nexfix POS Storage QA',
      format: 1,
      purpose: 'disposable-offline-test-data',
    }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  return Object.freeze({ folderPath: canonicalQaFolder, sentinelPath });
}

module.exports = { prepareQaFolder };
