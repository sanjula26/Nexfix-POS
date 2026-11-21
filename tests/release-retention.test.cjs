const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-build.yml'), 'utf8');
const retentionWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'r2-retention.yml'), 'utf8');
const retentionScript = fs.readFileSync(path.join(root, 'scripts', 'retain-private-r2-installers.ps1'), 'utf8');
const qaWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'windows-no-publish-qa.yml'), 'utf8');

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

test('Supabase secret API key requests use a server User-Agent and only legacy JWTs as bearer tokens', () => {
  assert.match(retentionScript, /apikey\s*=\s*\$supabaseApiKey/);
  assert.match(retentionScript, /'User-Agent'\s*=\s*'Nexfix-GitHub-Action\/1\.0'/);
  assert.match(retentionScript, /if\s*\(\$supabaseApiKey\.StartsWith\('eyJ'/);
  assert.match(retentionScript, /\$headers\.Authorization\s*=\s*"Bearer \$supabaseApiKey"/);
  assert.doesNotMatch(retentionScript, /Authorization\s*=\s*"Bearer \$\(\$env:SUPABASE_SERVICE_ROLE_KEY\)"/);
});


test('Supabase chunk cleanup uses server-safe API-key headers for opaque and legacy keys', () => {
  const cleanupStep = releaseWorkflow.match(/- name: Remove superseded private release chunks[\s\S]*?(?=\n      - name: Retain active private installer)/)?.[0] ?? '';
  assert.ok(cleanupStep, 'production workflow must contain the separately gated private chunk cleanup step');
  assert.match(cleanupStep, /apikey\s*=\s*\$supabaseApiKey/);
  assert.match(cleanupStep, /'User-Agent'\s*=\s*'Nexfix-GitHub-Action\/1\.0'/);
  assert.match(cleanupStep, /if\s*\(\$supabaseApiKey\.StartsWith\('eyJ'/);
  assert.match(cleanupStep, /\$headers\.Authorization\s*=\s*"Bearer \$supabaseApiKey"/);
  assert.doesNotMatch(cleanupStep, /Authorization\s*=\s*"Bearer \$env:SUPABASE_SERVICE_ROLE_KEY"/);
});

test('Windows no-publish QA parses the shared PowerShell retention script', () => {
  assert.match(qaWorkflow, /Validate private R2 retention script syntax/);
  assert.match(qaWorkflow, /System\.Management\.Automation\.Language\.Parser\]::ParseFile/);
});

test('production publishing and standalone R2 cleanup share one concurrency lock', () => {
  const releaseGroup = releaseWorkflow.match(/concurrency:\s*\n\s+group:\s*(.+)/)?.[1];
  const retentionGroup = retentionWorkflow.match(/concurrency:\s*\n\s+group:\s*(.+)/)?.[1];
  assert.ok(releaseGroup, 'production workflow must define a storage concurrency group');
  assert.equal(retentionGroup, releaseGroup, 'standalone cleanup must serialize with production releases');
  assert.match(releaseWorkflow, /cancel-in-progress:\s*false/);
  assert.match(retentionWorkflow, /cancel-in-progress:\s*false/);
});

test('retention validates active object and size before the first delete', () => {
  const activeSizeCheck = retentionScript.indexOf('Active R2 installer size does not match');
  const firstDelete = retentionScript.indexOf('aws s3api delete-object');
  assert.ok(activeSizeCheck >= 0, 'active R2 object size must be compared with the database row');
  assert.ok(firstDelete > activeSizeCheck, 'no R2 deletion may occur before active object validation');
});


test('owner phone link registry sync uses apikey-only auth for opaque Supabase keys', () => {
  const ownerSyncWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'sync-owner-phone-links.yml'), 'utf8');
  const authLine = ownerSyncWorkflow.match(/^\s*auth=\(.*\)$/m)?.[0] ?? '';
  assert.ok(authLine, 'owner registry sync must define the Supabase auth header array');
  assert.match(authLine, /apikey: \$\{SUPABASE_SERVICE_ROLE_KEY\}/);
  assert.doesNotMatch(authLine, /Authorization:/);
  assert.match(ownerSyncWorkflow, /if \[\[ "\$\{SUPABASE_SERVICE_ROLE_KEY\}" == eyJ\* \]\]; then/);
  assert.match(ownerSyncWorkflow, /Authorization: Bearer \$\{SUPABASE_SERVICE_ROLE_KEY\}/);
});
test('Supabase legacy chunk upload verification uses server-safe API-key headers', () => {
  const uploadStep = releaseWorkflow.match(/- name: Publish legacy compatibility chunks to private Supabase Storage[\s\S]*?(?=\n      - name: Verify private Windows release)/)?.[0] ?? '';
  assert.ok(uploadStep, 'production workflow must contain the legacy chunk upload and verification step');
  assert.match(uploadStep, /apikey = \$supabaseApiKey/);
  assert.match(uploadStep, /'User-Agent' = 'Nexfix-GitHub-Action\/1\.0'/);
  assert.match(uploadStep, /if \(\$supabaseApiKey\.StartsWith\('eyJ'/);
  assert.match(uploadStep, /\$storageHeaders\.Authorization = "Bearer \$supabaseApiKey"/);
  assert.doesNotMatch(uploadStep, /Authorization = "Bearer \$env:SUPABASE_SERVICE_ROLE_KEY"/);
});

test('production publishing is manual-only, main-only, and explicitly confirmed', () => {
  const triggerBlock = releaseWorkflow.match(/^on:\r?\n([\s\S]*?)\r?\n\r?\nconcurrency:/m)?.[1] ?? '';
  assert.match(triggerBlock, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(triggerBlock, /^\s+(?:push|create):/m);
  assert.match(releaseWorkflow, /RELEASE_REF:\s*\$\{\{\s*github\.ref\s*\}\}/);
  assert.match(releaseWorkflow, /RELEASE_CONFIRMED:\s*\$\{\{\s*inputs\.confirm_production_release\s*\}\}/);
  assert.match(releaseWorkflow, /\$isMain = \$env:RELEASE_REF -eq 'refs\/heads\/main'/);
  assert.match(releaseWorkflow, /if \(-not \$isMain\)/);
  assert.match(releaseWorkflow, /if \(-not \$isMain\)[\s\S]*?throw "Production Windows releases may only run from main/);
  assert.match(releaseWorkflow, /if \(\$env:RELEASE_CONFIRMED -ne 'True' -and \$env:RELEASE_CONFIRMED -ne 'true'\)/);
  assert.doesNotMatch(releaseWorkflow, /nexfix-production-recovery-2026-11-13|nexfix-production-release-2026-11-13/);
});


test('public repository Windows QA never uploads downloadable EXE artifacts', () => {
  assert.match(qaWorkflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(qaWorkflow, /github\.event\.repository\.private\s*!=\s*true/);
  assert.match(qaWorkflow, /github\.event\.repository\.private\s*==\s*true/);
  assert.match(qaWorkflow, /actions\/upload-artifact@/);
  assert.doesNotMatch(qaWorkflow, /secrets\.|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(qaWorkflow, /aws s3api (?:put-object|delete-object)|storage\/v1\/object\/upload/);
});


test('Windows packaging step receives no private storage credentials or unused backup transport key', () => {
  const packagingStart = releaseWorkflow.indexOf('- name: Build Windows installer and portable app');
  const packagingEnd = releaseWorkflow.indexOf('      - name: Verify Windows artifacts', packagingStart);
  assert.ok(packagingStart >= 0, 'production workflow must contain the Windows packaging step');
  assert.ok(packagingEnd > packagingStart, 'packaging step must end before artifact verification');
  const packagingStep = releaseWorkflow.slice(packagingStart, packagingEnd);
  assert.match(packagingStep, /EP_GH_IGNORE_TIME/);
  assert.doesNotMatch(packagingStep, /SUPABASE_SERVICE_ROLE_KEY|VITE_GOOGLE_BACKUP_API_KEY/);
});


test('private upload tools are prepared before R2 and Supabase credentials are exposed', () => {
  const prepareStart = releaseWorkflow.indexOf('- name: Prepare private release upload tools');
  const r2Start = releaseWorkflow.indexOf('- name: Publish Windows release to private Cloudflare R2');
  const supabaseStart = releaseWorkflow.indexOf('- name: Publish legacy compatibility chunks to private Supabase Storage');
  const verifyStart = releaseWorkflow.indexOf('- name: Verify private Windows release', supabaseStart);
  assert.ok(prepareStart >= 0 && prepareStart < r2Start, 'upload tools must be installed before R2 credentials are exposed');
  assert.ok(r2Start >= 0 && supabaseStart > r2Start, 'R2 upload must precede Supabase compatibility upload');
  assert.ok(verifyStart > supabaseStart, 'Supabase upload step must have a bounded end');
  const r2Step = releaseWorkflow.slice(r2Start, supabaseStart);
  const supabaseStep = releaseWorkflow.slice(supabaseStart, verifyStart);
  for (const step of [r2Step, supabaseStep]) {
    assert.doesNotMatch(step, /choco install|npm install|npm ci|npm exec|npx /i);
  }
  const prepareStep = releaseWorkflow.slice(prepareStart, r2Start);
  assert.match(prepareStep, /choco install awscli/);
  assert.match(prepareStep, /npm install --no-save --no-package-lock --ignore-scripts tus-js-client@4/);
  assert.match(releaseWorkflow.slice(prepareStart, r2Start), /choco install awscli/);
});


test('owner local Windows test build stays local and never publishes or uploads', () => {
  const localBuild = fs.readFileSync(path.join(root, 'scripts', 'build-windows-test.ps1'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(localBuild, /Node\.js 22/);
  assert.match(localBuild, /VITE_SEED_DEMO = 'false'/);
  assert.match(localBuild, /LIVE-CLOUD-TEST/);
  assert.match(localBuild, /npm.*desktop:build/);
  assert.match(packageJson.scripts['desktop:build'], /electron-builder --win --publish never/);
  assert.match(localBuild, /VITE_GOOGLE_BACKUP_API_KEY/);
  assert.doesNotMatch(localBuild, /aws s3api|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|SUPABASE_SERVICE_ROLE_KEY|upload-artifact|storage\/v1\/object\/upload/);
});
