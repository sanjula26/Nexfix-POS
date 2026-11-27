'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { QA_INTERRUPTION_PHASES, createQaInterruptionController } = require('../electron/qa/interruption-control.cjs');

function withQaUserData(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-storage-qa-'));
  try { callback(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const profileId = '12345678-1234-4234-8234-123456789abc';
const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('one-shot QA interruption is durable outside the profile and is consumed exactly once', () => {
  withQaUserData(directory => {
    const controller = createQaInterruptionController({ userDataDirectory: directory });
    const armed = controller.arm({ runId, profileId, phase: 'after_copy_meta' });
    assert.deepEqual(armed, { armed: true, runId, phase: 'after_copy_meta' });
    assert.equal(controller.getLast(), null);
    assert.deepEqual(controller.checkpoint({ profileId, phase: 'after_copy_app_state' }), { stop: false });

    assert.deepEqual(controller.checkpoint({ profileId, phase: 'after_copy_meta' }), {
      stop: true,
      runId,
      phase: 'after_copy_meta',
    });
    const last = controller.getLast();
    assert.equal(last.runId, runId);
    assert.equal(last.profileId, profileId);
    assert.equal(last.phase, 'after_copy_meta');
    assert.equal(typeof last.armedAt, 'string');
    assert.equal(fs.existsSync(path.join(directory, 'storage-qa-interruption-armed.json')), false);
    assert.equal(controller.checkpoint({ profileId, phase: 'after_copy_meta' }).stop, false);
    assert.equal(controller.clearLast({ runId, profileId }), true);
    assert.equal(controller.getLast(), null);
    assert.equal(controller.clearLast({ runId, profileId }), false);
  });
});

test('QA interruption controller rejects repeated arms and profile mismatch without consuming the instruction', () => {
  withQaUserData(directory => {
    const controller = createQaInterruptionController({ userDataDirectory: directory });
    controller.arm({ runId, profileId, phase: 'before_folder_primary' });
    assert.throws(
      () => controller.arm({ runId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', profileId, phase: 'after_snapshot' }),
      /already armed/,
    );
    assert.throws(
      () => controller.checkpoint({ profileId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', phase: 'before_folder_primary' }),
      /different disposable profile/,
    );
    assert.equal(fs.existsSync(path.join(directory, 'storage-qa-interruption-armed.json')), true);
  });
});

test('QA interruption controller rejects unsupported phases and invalid identities', () => {
  withQaUserData(directory => {
    const controller = createQaInterruptionController({ userDataDirectory: directory });
    assert.throws(() => controller.arm({ runId, profileId, phase: 'unknown' }), /not supported/);
    assert.throws(() => controller.arm({ runId: 'bad', profileId, phase: 'after_snapshot' }), /run ID/);
    assert.throws(() => controller.arm({ runId, profileId: 'bad', phase: 'after_snapshot' }), /profile ID/);
    assert.deepEqual(QA_INTERRUPTION_PHASES, [
      'after_snapshot',
      'after_copy_app_state',
      'after_copy_sync_queue',
      'after_copy_meta',
      'after_copy_restore_checkpoint',
      'after_verification',
      'before_folder_primary',
      'after_folder_primary_before_adapter_activation',
    ]);
  });
});
