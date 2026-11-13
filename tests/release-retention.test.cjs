const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-build.yml'), 'utf8');
const retentionWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'r2-retention.yml'), 'utf8');

test('production release retention protects the active Supabase installer', () => {
  assert.match(releaseWorkflow, /desktop_releases\?platform=eq\.win32&channel=eq\.latest&is_active=eq\.true/);
  assert.match(releaseWorkflow, /\$activeKey\s*=\s*\[string\]\$activeRows\[0\]\.installer_path/);
  assert.match(releaseWorkflow, /\$activeEntry\s*=\s*@\(\$versionedInstallers\s*\|\s*Where-Object\s*\{\s*\$_.Key\s*-eq\s*\$activeKey\s*\}\)/);
  assert.match(releaseWorkflow, /\$retained\s*=\s*@\(\$activeEntry\)\s*\+\s*@\(\$newestOtherInstallers\)/);
  assert.match(releaseWorkflow, /head-object[\s\S]*?Active installer disappeared during R2 retention cleanup/);
});

test('standalone R2 retention protects active release plus two newest installers', () => {
  assert.match(retentionWorkflow, /desktop_releases\?platform=eq\.win32&channel=eq\.latest&is_active=eq\.true/);
  assert.match(retentionWorkflow, /\$activeKey\s*=\s*\[string\]\$activeRows\[0\]\.installer_path/);
  assert.match(retentionWorkflow, /\$activeEntry\s*=\s*@\(\$versioned\s*\|\s*Where-Object\s*\{\s*\$_.Key\s*-eq\s*\$activeKey\s*\}\)/);
  assert.match(retentionWorkflow, /\$retained\s*=\s*@\(\$activeEntry\)\s*\+\s*@\(\$newestOther\)/);
  assert.match(retentionWorkflow, /head-object[\s\S]*?Active installer disappeared during retention cleanup/);
});

test('standalone R2 retention remains manual, main-only and explicitly confirmed', () => {
  assert.match(retentionWorkflow, /workflow_dispatch:[\s\S]*?confirm_retention_cleanup:[\s\S]*?default:\s*false/);
  assert.match(retentionWorkflow, /RETENTION_REF\s*-ne\s*'refs\/heads\/main'/);
  assert.match(retentionWorkflow, /RETENTION_CONFIRMED\s*-ne\s*'true'/);
});
