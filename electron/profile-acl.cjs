'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SYSTEM_SID = 'S-1-5-18';
const BROAD_ACCESS_SIDS = Object.freeze([
  'S-1-1-0',       // Everyone
  'S-1-5-32-545',  // BUILTIN\Users
  'S-1-5-11',      // Authenticated Users
  'S-1-5-32-544',  // BUILTIN\Administrators (administrators can still take ownership)
]);
const MAX_PROFILE_ENTRIES = 100000;
const MAX_PROFILE_DEPTH = 64;

function isValidWindowsSid(value) {
  return typeof value === 'string' && /^S-1-(?:\d+-){1,14}\d+$/.test(value);
}

function normalizeProfileDirectory(value, pathApi = path.win32) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A POS profile folder is required.');
  }
  const input = value.trim();
  if (/^(?:\\\\\?\\|\\\\\.\\|\\\\)/.test(input)) {
    throw new Error('Network and device paths are not supported for POS profile storage.');
  }
  if (!pathApi.isAbsolute(input)) throw new Error('The POS profile folder must be an absolute local path.');
  const normalized = pathApi.normalize(input);
  const root = pathApi.parse(normalized).root;
  if (normalized.replace(/[\\/]+$/, '').toLowerCase() === root.replace(/[\\/]+$/, '').toLowerCase()) {
    throw new Error('The drive root itself cannot be used as a POS profile folder.');
  }
  return normalized;
}

function assertNoReparsePoints(profileDirectory, fsApi = fs, pathApi = path.win32) {
  const rootStat = fsApi.lstatSync(profileDirectory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('The POS profile location must be a real directory, not a link or file.');
  }

  const pending = [{ directory: profileDirectory, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > MAX_PROFILE_DEPTH) {
      throw new Error('The POS profile contains too many nested folders to secure safely.');
    }
    const entries = fsApi.readdirSync(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_PROFILE_ENTRIES) {
        throw new Error('The POS profile contains too many files to secure in one operation.');
      }
      const fullPath = pathApi.join(current.directory, entry.name);
      const stat = fsApi.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error('The POS profile contains a symbolic link or junction; folder locking was stopped.');
      }
      if (stat.isDirectory()) pending.push({ directory: fullPath, depth: current.depth + 1 });
    }
  }
  return visited + 1;
}

function buildWindowsAclCommands(profileDirectory, userSid) {
  if (!isValidWindowsSid(userSid)) throw new Error('The current Windows user SID is invalid.');
  const target = normalizeProfileDirectory(profileDirectory);
  const broad = BROAD_ACCESS_SIDS.map((sid) => '*' + sid);
  return [
    {
      name: 'grant-current-user-and-system',
      executable: 'icacls.exe',
      args: [target, '/grant:r', '*' + userSid + ':(OI)(CI)F', '*' + SYSTEM_SID + ':(OI)(CI)F', '/T'],
    },
    {
      name: 'remove-inherited-permissions',
      executable: 'icacls.exe',
      args: [target, '/inheritance:r', '/T'],
    },
    {
      name: 'remove-broad-grants',
      executable: 'icacls.exe',
      args: [target, '/remove:g', ...broad, '/T'],
    },
    {
      name: 'remove-broad-denials',
      executable: 'icacls.exe',
      args: [target, '/remove:d', ...broad, '/T'],
    },
    {
      name: 'remove-unapproved-access-entries',
      executable: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_RESTRICT_ACL],
    },
    {
      name: 'set-profile-owner',
      executable: 'icacls.exe',
      args: [target, '/setowner', '*' + userSid, '/T'],
    },
    {
      name: 'verify-canonical-acls',
      executable: 'icacls.exe',
      args: [target, '/verify', '/T'],
    },
  ];
}

const POWERSHELL_RESTRICT_ACL = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$target = $env:NEXFIX_PROFILE_ACL_PATH
$userSid = $env:NEXFIX_PROFILE_ACL_USER_SID
$allowed = @($userSid, 'S-1-5-18')
$items = @((Get-Item -LiteralPath $target -Force)) + @(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop)
foreach ($item in $items) {
  $acl = Get-Acl -LiteralPath $item.FullName
  foreach ($rule in @($acl.Access)) {
    $sid = $rule.IdentityReference.Value
    try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
    if (($allowed -notcontains $sid) -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      [void]$acl.RemoveAccessRuleSpecific($rule)
    }
  }
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
}
[pscustomobject]@{ ok = $true; changed = $items.Count } | ConvertTo-Json -Compress
`;

const POWERSHELL_ACL_VERIFY = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$target = $env:NEXFIX_PROFILE_ACL_PATH
$userSid = $env:NEXFIX_PROFILE_ACL_USER_SID
$required = @($userSid, 'S-1-5-18')
$items = @((Get-Item -LiteralPath $target -Force)) + @(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop)
$issues = New-Object System.Collections.Generic.List[string]
$fullControl = [int][System.Security.AccessControl.FileSystemRights]::FullControl
foreach ($item in $items) {
  $acl = Get-Acl -LiteralPath $item.FullName
  $ownerSid = $acl.Owner
  try { $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  if ($ownerSid -ne $userSid) { $issues.Add($item.FullName + ': profile owner is not the selected Windows user') }
  $entries = @($acl.Access | ForEach-Object {
    $sid = $_.IdentityReference.Value
    try { $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
    [pscustomobject]@{ Sid = $sid; Type = $_.AccessControlType.ToString(); Rights = [int]$_.FileSystemRights }
  })
  foreach ($sid in $required) {
    $found = @($entries | Where-Object { $_.Sid -eq $sid -and $_.Type -eq 'Allow' -and (($_.Rights -band $fullControl) -eq $fullControl) }).Count -gt 0
    if (-not $found) { $issues.Add($item.FullName + ': missing full-control allow for ' + $sid) }
  }
  foreach ($entry in $entries) {
    if ($required -notcontains $entry.Sid) {
      $issues.Add($item.FullName + ': unapproved access ACE remains for ' + $entry.Sid)
    }
    if ($entry.Type -ne 'Allow') {
      $issues.Add($item.FullName + ': access-deny ACE remains for ' + $entry.Sid)
    }
  }
}
[pscustomobject]@{ ok = ($issues.Count -eq 0); checked = $items.Count; issues = @($issues | Select-Object -First 50) } | ConvertTo-Json -Compress
`;

async function runWindowsCommand(executable, args, options = {}) {
  return execFileAsync(executable, args, {
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    ...options,
  });
}

async function verifyWindowsProfileAcl(profileDirectory, userSid, options = {}) {
  const runCommand = options.runCommand || runWindowsCommand;
  const result = await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    POWERSHELL_ACL_VERIFY,
  ], {
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    env: {
      ...process.env,
      NEXFIX_PROFILE_ACL_PATH: profileDirectory,
      NEXFIX_PROFILE_ACL_USER_SID: userSid,
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim());
  } catch {
    throw new Error('Windows profile ACL verification returned invalid output.');
  }
  if (!parsed || parsed.ok !== true || !Number.isSafeInteger(parsed.checked) || parsed.checked < 1) {
    const details = Array.isArray(parsed?.issues) ? parsed.issues.slice(0, 5).join('; ') : '';
    throw new Error('Windows profile folder permissions could not be verified.' + (details ? ' ' + details : ''));
  }
  return { checkedEntries: parsed.checked };
}

async function applyWindowsProfileAcl(profileDirectory, userSid, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    throw new Error('POS profile folder ACL hardening is supported only on Windows NTFS.');
  }
  if (!isValidWindowsSid(userSid)) throw new Error('The current Windows user SID is invalid.');

  const pathApi = options.pathApi || path.win32;
  const fsApi = options.fsApi || fs;
  const target = normalizeProfileDirectory(profileDirectory, pathApi);
  const realPath = fsApi.realpathSync(target);
  const canonical = normalizeProfileDirectory(realPath, pathApi);
  assertNoReparsePoints(canonical, fsApi, pathApi);

  const commands = buildWindowsAclCommands(canonical, userSid);
  const runCommand = options.runCommand || runWindowsCommand;
  for (const command of commands) {
    await runCommand(command.executable, command.args, {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      env: {
        ...process.env,
        NEXFIX_PROFILE_ACL_PATH: canonical,
        NEXFIX_PROFILE_ACL_USER_SID: userSid,
      },
    });
  }

  assertNoReparsePoints(canonical, fsApi, pathApi);
  const verification = await (options.verifyAcl || verifyWindowsProfileAcl)(canonical, userSid, { runCommand });
  return {
    ok: true,
    directory: canonical,
    userSid,
    systemSid: SYSTEM_SID,
    commandsApplied: commands.map((command) => command.name),
    checkedEntries: verification.checkedEntries,
  };
}

module.exports = {
  SYSTEM_SID,
  BROAD_ACCESS_SIDS,
  isValidWindowsSid,
  normalizeProfileDirectory,
  assertNoReparsePoints,
  buildWindowsAclCommands,
  POWERSHELL_RESTRICT_ACL,
  POWERSHELL_ACL_VERIFY,
  verifyWindowsProfileAcl,
  applyWindowsProfileAcl,
};
