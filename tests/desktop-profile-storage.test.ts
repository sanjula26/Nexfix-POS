import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasDesktopProfileRuntime,
  readDesktopProfileJson,
  readDesktopProfilePayload,
  writeDesktopProfileJson,
  writeDesktopProfilePayload,
} from '../src/lib/desktopProfileStorage.ts';

type MockWindow = Window & { nexfixDesktop?: Record<string, unknown> };
const originalWindow = (globalThis as { window?: Window }).window;

function setWindow(value: MockWindow | undefined) {
  if (value) Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value });
  else Reflect.deleteProperty(globalThis, 'window');
}

test.after(() => setWindow(originalWindow as MockWindow | undefined));

test('browser/dev runtime does not claim an encrypted desktop profile', async () => {
  setWindow(undefined);
  assert.equal(hasDesktopProfileRuntime(), false);
  await assert.rejects(() => readDesktopProfilePayload('app_state'), /desktop app/);
});

test('desktop bridge reads encrypted JSON and distinguishes a missing file', async () => {
  const values = new Map<string, string>([['app_state', JSON.stringify({ products: [{ id: 'p1' }] })]]);
  setWindow({ nexfixDesktop: {
    isDesktop: true,
    readPOSProfileData: async (purpose: string) => {
      const payload = values.get(purpose);
      return payload === undefined ? { ok: true, found: false } : { ok: true, found: true, payload };
    },
    writePOSProfileData: async () => ({ ok: true, revision: 1, bytes: 2 }),
  } });
  assert.equal(hasDesktopProfileRuntime(), true);
  assert.deepEqual(await readDesktopProfileJson('app_state'), { products: [{ id: 'p1' }] });
  assert.equal(await readDesktopProfilePayload('sync_queue'), null);
});

test('desktop bridge fails closed for locked profile and IPC errors', async () => {
  setWindow({ nexfixDesktop: {
    isDesktop: true,
    readPOSProfileData: async () => ({ ok: false, error: 'No POS profile is unlocked.' }),
    writePOSProfileData: async () => ({ ok: false, error: 'No POS profile is unlocked.' }),
  } });
  await assert.rejects(() => readDesktopProfilePayload('app_state'), /No POS profile is unlocked/);
  await assert.rejects(() => writeDesktopProfilePayload('app_state', '{}'), /No POS profile is unlocked/);
});

test('desktop bridge rejects malformed IPC responses and invalid JSON', async () => {
  setWindow({ nexfixDesktop: {
    isDesktop: true,
    readPOSProfileData: async () => ({ ok: true, found: true, payload: '{broken' }),
    writePOSProfileData: async () => ({ ok: true, revision: 0, bytes: -1 }),
  } });
  await assert.rejects(() => readDesktopProfileJson('app_state'), /invalid JSON/);
  await assert.rejects(() => writeDesktopProfilePayload('app_state', '{}'), /invalid write confirmation/);
});

test('desktop bridge serializes JSON and rejects values JSON cannot represent', async () => {
  let written = '';
  setWindow({ nexfixDesktop: {
    isDesktop: true,
    readPOSProfileData: async () => ({ ok: true, found: false }),
    writePOSProfileData: async (_purpose: string, payload: string) => {
      written = payload;
      return { ok: true, revision: 2, bytes: Buffer.byteLength(payload, 'utf8') };
    },
  } });
  const result = await writeDesktopProfileJson('meta', { backupCount: 3 });
  assert.deepEqual(result, { revision: 2, bytes: Buffer.byteLength(written, 'utf8') });
  assert.deepEqual(JSON.parse(written), { backupCount: 3 });
  await assert.rejects(() => writeDesktopProfileJson('meta', undefined), /valid JSON payload/);
});
