'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { assertOutsideProtectedPaths } = require('../electron/qa/folder-guard.cjs');

const win = path.win32;
const protectedRoots = [
  'C:\\Users\\Sanjula\\AppData\\Roaming\\Nexfix POS',
  'C:\\Program Files\\Nexfix POS',
  'C:\\Windows',
];

test('allows a separate disposable folder outside protected locations', () => {
  assert.equal(
    assertOutsideProtectedPaths('D:\\Nexfix-QA\\fixture-01', protectedRoots, win),
    'D:\\Nexfix-QA\\fixture-01',
  );
});

test('rejects the production user-data directory and its descendants', () => {
  assert.throws(
    () => assertOutsideProtectedPaths('C:\\Users\\Sanjula\\AppData\\Roaming\\Nexfix POS\\User Data', protectedRoots, win),
    /overlaps a protected POS/,
  );
});

test('rejects a parent directory that contains a protected location', () => {
  assert.throws(
    () => assertOutsideProtectedPaths('C:\\Users\\Sanjula', protectedRoots, win),
    /overlaps a protected POS/,
  );
});

test('rejects Windows and application install locations', () => {
  assert.throws(() => assertOutsideProtectedPaths('C:\\Windows\\Temp\\Nexfix-QA', protectedRoots, win), /overlaps a protected POS/);
  assert.throws(() => assertOutsideProtectedPaths('C:\\Program Files\\Nexfix POS\\QA', protectedRoots, win), /overlaps a protected POS/);
});

test('rejects a drive root and relative paths', () => {
  assert.throws(() => assertOutsideProtectedPaths('C:\\', protectedRoots, win), /drive root/);
  assert.throws(() => assertOutsideProtectedPaths('relative\\qa', protectedRoots, win), /absolute disposable/);
});

test('fails closed when protected paths are missing or malformed', () => {
  assert.throws(() => assertOutsideProtectedPaths('D:\\\\QA', [], win), /Protected POS storage locations are required/);
  assert.throws(() => assertOutsideProtectedPaths('D:\\QA', ['not-absolute'], win), /could not be validated/);
});
