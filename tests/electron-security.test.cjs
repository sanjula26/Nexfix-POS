const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createNavigationGuard } = require('../electron/navigation-security.cjs');
const { writeBufferFully } = require('../electron/write-buffer.cjs');

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'main.cjs'),
  'utf8',
);

test('packaged navigation trusts only the exact renderer entrypoint', () => {
  const rendererPath = path.resolve('/nexfix-test/app/dist/index.html');
  const isAllowedNavigation = createNavigationGuard({
    isDev: false,
    devUrl: 'http://localhost:5173/',
    rendererPath,
  });

  assert.equal(isAllowedNavigation(pathToFileURL(rendererPath).href), true);
  assert.equal(
    isAllowedNavigation(pathToFileURL(path.resolve('/nexfix-test/app/other.html')).href),
    false,
  );
  assert.equal(isAllowedNavigation('file:///etc/passwd'), false);
  assert.equal(isAllowedNavigation('https://example.com/'), false);
});

test('development navigation is limited to the configured origin', () => {
  const isAllowedNavigation = createNavigationGuard({
    isDev: true,
    devUrl: 'http://localhost:5173/',
    rendererPath: '/unused-in-development/index.html',
  });

  assert.equal(isAllowedNavigation('http://localhost:5173/settings'), true);
  assert.equal(isAllowedNavigation('http://localhost:5174/'), false);
  assert.equal(isAllowedNavigation('https://localhost:5173/'), false);
  assert.equal(isAllowedNavigation('http://user@localhost:5173/'), false);
});

test('Electron keeps the renderer sandboxed and isolated', () => {
  assert.match(
    mainSource,
    /webPreferences:\{[^}]*contextIsolation:true[^}]*nodeIntegration:false[^}]*sandbox:true[^}]*webSecurity:true\}/,
  );
});

test('privileged clipboard, external-open and exit IPC handlers reject untrusted frames', () => {
  for (const channel of ['app:copy-text', 'app:open-external', 'app:exit', 'app:exit-ready']) {
    const marker = `ipcMain.handle('${channel}'`;
    const start = mainSource.indexOf(marker);
    assert.notEqual(start, -1, `Missing IPC handler: ${channel}`);
    assert.match(
      mainSource.slice(start, start + 500),
      /isTrustedRenderer\(event\)/,
      `${channel} must verify the trusted main-frame URL`,
    );
  }
});


test('private updater writes every streamed installer byte despite partial file writes', async () => {
  const source = Buffer.from('nexfix-installer-bytes');
  const output = Buffer.alloc(source.length);
  let calls = 0;
  const handle = {
    async write(buffer, offset, length, position) {
      const bytesWritten = Math.min(3, length);
      buffer.copy(output, position, offset, offset + bytesWritten);
      calls += 1;
      return { bytesWritten };
    },
  };

  assert.equal(await writeBufferFully(handle, source, 0), source.length);
  assert.equal(output.toString(), source.toString());
  assert.ok(calls > 1, 'test handle should simulate partial writes');
  assert.match(mainSource, /writeBufferFully\(handle, buffer, total\)/);
});

test('private updater aborts when the installer file handle makes no write progress', async () => {
  const handle = { async write() { return { bytesWritten: 0 }; } };
  await assert.rejects(
    writeBufferFully(handle, Buffer.from('installer'), 0),
    /did not make forward progress/,
  );
});
