const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-build.yml'), 'utf8');
const retentionWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'r2-retention.yml'), 'utf8');
const retentionScript = fs.readFileSync(path.join(root, 'scripts', 'retain-private-r2-installers.ps1'), 'utf8');
const qaWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-build-only.yml'), 'utf8');

test('production release passes the newly built installer path to shared retention guard', () => {
  assert.match(releaseWorkflow, /EXPECTED_ACTIVE_INSTALLER_PATH\s*=\s*"win32\/latest\/\$\(\$installer\.Name\)"/);
  assert.match(releaseWorkflow, /scripts\/retain-private-r2-installers\.ps1/);
  assert.match(releaseWorkflow, /confirm_private_retention_cleanup/);
});

test('standalone R2 retention uses the same active-release-safe helper', () => {
  assert.match(retentionWorkflow, /scripts\/retain-private-r2-installers\.ps1/);
  assert.match(retentionWorkflow, /RETENTION_REF\s*-ne\s*'refs\/heads\/main'/);
  assert.match(retentionWorkflow, /RETENTION_CONFIRMED\s*-ne\s*'true'/);
  assert.match(retentionWorkflow, /default:\s*false/);
});

test('shared retention helper protects the active database pointer before deletion', () => {
  assert.match(retentionScript, /desktop_releases\?platform=eq\.win32&channel=eq\.latest&is_active=eq\.true/);
  assert.match(retentionScript, /\$activeKey\s*=\s*\[string\]\$activeRows\[0\]\.installer_path/);
  assert.match(retentionScript, /\$activeEntry\s*=\s*@\(\$versionedInstallers\s*\|\s*Where-Object\s*\{\s*\$_.Key\s*-eq\s*\$activeKey\s*\}\)/);
  assert.match(retentionScript, /\$retained\s*=\s*@\(\$activeEntry\)\s*\+\s*@\(\$newestOtherInstallers\)/);
  assert.match(retentionScript, /EXPECTED_ACTIVE_INSTALLER_PATH/);
  assert.match(retentionScript, /head-object[\s\S]*?Active installer disappeared during R2 retention cleanup/);
});

test('Windows no-publish QA parses the shared PowerShell retention script', () => {
  assert.match(qaWorkflow, /Validate private R2 retention script syntax/);
  assert.match(qaWorkflow, /Language\]::Parser\]::ParseFile/);
});
