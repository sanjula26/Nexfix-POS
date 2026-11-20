'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const {
  buildWindowsAclCommands,
  normalizeProfileDirectory,
  applyWindowsProfileAcl,
  verifyWindowsProfileAcl,
  isValidWindowsSid,
} = require('../electron/profile-acl.cjs');

const USER_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const PROFILE_PATH = 'D:\\NexfixData\\profile-001';

function fakeFs() {
  return {
    realpathSync: value => value,
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    readdirSync: () => [],
  };
}

test('Windows ACL command plan grants the current user and SYSTEM before removing inherited access', () => {
  const commands = buildWindowsAclCommands(PROFILE_PATH, USER_SID);
  assert.equal(commands[0].name, 'grant-current-user-and-system');
  assert.ok(commands[0].args.includes('*' + USER_SID + ':(OI)(CI)F'));
  assert.ok(commands[0].args.includes('*S-1-5-18:(OI)(CI)F'));
  assert.ok(commands[1].args.includes('/inheritance:r'));
  assert.ok(commands[2].args.includes('*S-1-1-0'));
  assert.ok(commands[2].args.includes('*S-1-5-32-545'));
  assert.ok(commands[3].args.includes('/remove:d'));
  assert.equal(commands[4].name, 'remove-unapproved-access-entries');
  assert.equal(commands[4].executable, 'powershell.exe');
  assert.match(commands[4].args.at(-1), /Remove-TypeData -TypeName System.Security.AccessControl.ObjectSecurity/);
  assert.match(commands[4].args.at(-1), /Import-Module Microsoft.PowerShell.Security -Force/);
  assert.match(commands[4].args.at(-1), /RemoveAccessRuleSpecific/);
  assert.match(commands[4].args.at(-1), /Set-Acl/);
  assert.equal(commands.at(-1).name, 'verify-canonical-acls');
  for (const command of commands) {
    if (command.name === 'remove-unapproved-access-entries') assert.equal(command.executable, 'powershell.exe');
    else assert.equal(command.executable, 'icacls.exe');
  }
});

test('Windows profile path must be local, absolute and not a drive root', () => {
  assert.equal(normalizeProfileDirectory(PROFILE_PATH), PROFILE_PATH);
  assert.throws(() => normalizeProfileDirectory('NexfixData\\\\profile'), /absolute local path/);
  assert.throws(() => normalizeProfileDirectory('D:\\\\'), /drive root/);
  assert.throws(() => normalizeProfileDirectory('\\\\\\\\server\\\\share\\\\profile'), /Network and device paths/);
});

test('Windows SID validation rejects malformed or injected values', () => {
  assert.equal(isValidWindowsSid(USER_SID), true);
  assert.equal(isValidWindowsSid('S-1-5-21-1;whoami'), false);
  assert.throws(() => buildWindowsAclCommands(PROFILE_PATH, 'S-1-5-21-1;whoami'), /SID is invalid/);
});

test('ACL hardening is Windows-only and does not run commands on another platform', async () => {
  let calls = 0;
  await assert.rejects(
    () => applyWindowsProfileAcl(PROFILE_PATH, USER_SID, {
      platform: 'linux',
      runCommand: async () => { calls += 1; return { stdout: '' }; },
    }),
    /supported only on Windows NTFS/,
  );
  assert.equal(calls, 0);
});

test('ACL hardening rejects a profile folder that contains a junction or symbolic link', async () => {
  const fsApi = {
    ...fakeFs(),
    readdirSync: directory => directory === PROFILE_PATH ? [{ name: 'linked', isDirectory: () => true }] : [],
    lstatSync: value => ({
      isSymbolicLink: () => value.endsWith('linked'),
      isDirectory: () => true,
    }),
  };
  await assert.rejects(
    () => applyWindowsProfileAcl(PROFILE_PATH, USER_SID, {
      platform: 'win32',
      fsApi,
      runCommand: async () => ({ stdout: '' }),
    }),
    /symbolic link or junction/,
  );
});

test('ACL hardening runs commands without a shell and verifies every profile entry', async () => {
  const calls = [];
  const result = await applyWindowsProfileAcl(PROFILE_PATH, USER_SID, {
    platform: 'win32',
    fsApi: fakeFs(),
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: '' };
    },
    verifyAcl: async (directory, sid, options) => {
      assert.equal(directory, PROFILE_PATH);
      assert.equal(sid, USER_SID);
      assert.equal(options.runCommand instanceof Function, true);
      return { checkedEntries: 4 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 4);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.options.shell === false));
  assert.equal(calls[4].options.env.NEXFIX_PROFILE_ACL_PATH, PROFILE_PATH);
  assert.equal(calls[4].options.env.NEXFIX_PROFILE_ACL_USER_SID, USER_SID);
});

test('ACL hardening fails closed if any Windows ACL command fails', async () => {
  let calls = 0;
  await assert.rejects(
    () => applyWindowsProfileAcl(PROFILE_PATH, USER_SID, {
      platform: 'win32',
      fsApi: fakeFs(),
      runCommand: async () => {
        calls += 1;
        if (calls === 2) throw new Error('icacls failed');
        return { stdout: '' };
      },
      verifyAcl: async () => ({ checkedEntries: 1 }),
    }),
    /icacls failed/,
  );
  assert.equal(calls, 2);
});

test('ACL verification rejects unapproved explicit SIDs and all deny entries', () => {
  const { POWERSHELL_ACL_VERIFY } = require('../electron/profile-acl.cjs');
  assert.match(POWERSHELL_ACL_VERIFY, /Remove-TypeData -TypeName System.Security.AccessControl.ObjectSecurity/);
  assert.match(POWERSHELL_ACL_VERIFY, /Import-Module Microsoft.PowerShell.Security -Force/);
  assert.match(POWERSHELL_ACL_VERIFY, /unapproved access ACE remains/);
  assert.match(POWERSHELL_ACL_VERIFY, /access-deny ACE remains/);
  assert.match(POWERSHELL_ACL_VERIFY, /required/);
});

test('ACL verification checks that the selected Windows user remains the owner', () => {
  const { POWERSHELL_ACL_VERIFY } = require('../electron/profile-acl.cjs');
  assert.match(POWERSHELL_ACL_VERIFY, /profile owner is not the selected Windows user/);
  assert.match(POWERSHELL_ACL_VERIFY, /\$ownerSid -ne \$userSid/);
});

test('real Windows NTFS ACL hardening removes an explicit other-user grant on a disposable folder', {
  skip: process.platform !== 'win32',
}, async () => {
  const whoami = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  const sidMatches = whoami.match(/S-1-(?:\d+-){1,14}\d+/g) || [];
  assert.equal(sidMatches.length, 1, 'whoami must return exactly one current-user SID');
  const currentSid = sidMatches[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-profile-acl-'));
  try {
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    const file = path.join(nested, 'sample.dat');
    fs.writeFileSync(file, 'disposable ACL test only');
    execFileSync('icacls.exe', [file, '/grant', '*S-1-5-32-545:R'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });

    const result = await applyWindowsProfileAcl(root, currentSid);
    assert.equal(result.ok, true);
    assert.ok(result.checkedEntries >= 3);
    const verification = await verifyWindowsProfileAcl(root, currentSid);
    assert.ok(verification.checkedEntries >= 3);
    const aclDump = execFileSync('icacls.exe', [root, '/T'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    assert.doesNotMatch(aclDump, /BUILTIN\\Users|S-1-5-32-545/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
