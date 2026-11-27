'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareQaFolder } = require('../electron/qa/prepare-qa-folder.cjs');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexfix-qa-guard-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('creates a new child folder and exclusive QA sentinel without reusing parent contents', async (t) => {
  const root = await temporaryDirectory(t);
  const selected = path.join(root, 'selected');
  const protectedPath = path.join(root, 'protected');
  await fs.mkdir(selected);
  await fs.mkdir(protectedPath);
  await fs.writeFile(path.join(selected, 'keep.txt'), 'keep');

  const result = await prepareQaFolder({ selectedPath: selected, protectedRoots: [protectedPath] });
  assert.equal(path.dirname(result.folderPath), await fs.realpath(selected));
  assert.equal(await fs.readFile(path.join(selected, 'keep.txt'), 'utf8'), 'keep');
  const sentinel = JSON.parse(await fs.readFile(result.sentinelPath, 'utf8'));
  assert.equal(sentinel.application, 'Nexfix POS Storage QA');
  assert.equal(sentinel.format, 1);
  assert.equal(sentinel.purpose, 'disposable-offline-test-data');
});

test('rejects a selected symbolic-link directory even when its target is outside protected roots', async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  const protectedPath = path.join(root, 'protected');
  await fs.mkdir(target);
  await fs.mkdir(protectedPath);
  try {
    await fs.symlink(target, link, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('The current Windows runner does not permit creating a directory symlink.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    prepareQaFolder({ selectedPath: link, protectedRoots: [protectedPath] }),
    /real directory|symbolic link/,
  );
});

test('rejects a selected folder that overlaps a protected location after canonicalization', async (t) => {
  const root = await temporaryDirectory(t);
  const protectedPath = path.join(root, 'protected');
  const selected = path.join(protectedPath, 'child');
  await fs.mkdir(selected, { recursive: true });

  await assert.rejects(
    prepareQaFolder({ selectedPath: selected, protectedRoots: [protectedPath] }),
    /overlaps a protected POS/,
  );
});

test('fails closed when a protected root is missing', async (t) => {
  const root = await temporaryDirectory(t);
  const selected = path.join(root, 'selected');
  await fs.mkdir(selected);

  await assert.rejects(
    prepareQaFolder({ selectedPath: selected, protectedRoots: [path.join(root, 'missing')] }),
    /ENOENT/,
  );
});
