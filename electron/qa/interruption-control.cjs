'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QA_INTERRUPTION_FORMAT = 1;
const QA_INTERRUPTION_PHASES = Object.freeze([
  'after_snapshot',
  'after_copy_app_state',
  'after_copy_sync_queue',
  'after_copy_meta',
  'after_copy_restore_checkpoint',
  'after_verification',
  'before_folder_primary',
  'after_folder_primary_before_adapter_activation',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateInstruction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.format !== QA_INTERRUPTION_FORMAT ||
      !UUID_PATTERN.test(value.runId || '') ||
      !UUID_PATTERN.test(value.profileId || '') ||
      !QA_INTERRUPTION_PHASES.includes(value.phase)) {
    throw new Error('The stored QA interruption instruction is invalid.');
  }
  return {
    format: QA_INTERRUPTION_FORMAT,
    runId: value.runId.toLowerCase(),
    profileId: value.profileId.toLowerCase(),
    phase: value.phase,
    armedAt: typeof value.armedAt === 'string' ? value.armedAt : '',
  };
}

function createQaInterruptionController(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const userDataDirectory = options.userDataDirectory;
  if (typeof userDataDirectory !== 'string' || !pathApi.isAbsolute(userDataDirectory)) {
    throw new Error('A dedicated absolute QA user-data directory is required.');
  }

  const armedPath = pathApi.join(userDataDirectory, 'storage-qa-interruption-armed.json');
  const lastPath = pathApi.join(userDataDirectory, 'storage-qa-interruption-last.json');
  fsApi.mkdirSync(userDataDirectory, { recursive: true });

  function writeExclusive(filePath, value) {
    const descriptor = fsApi.openSync(filePath, 'wx', 0o600);
    try {
      fsApi.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
      fsApi.fsyncSync(descriptor);
    } finally {
      fsApi.closeSync(descriptor);
    }
  }

  function readInstruction(filePath) {
    if (!fsApi.existsSync(filePath)) return null;
    let parsed;
    try {
      const stat = fsApi.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) {
        throw new Error('The QA interruption marker is not a safe regular file.');
      }
      parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'The QA interruption marker could not be read.');
    }
    return validateInstruction(parsed);
  }

  function arm(input = {}) {
    if (!UUID_PATTERN.test(input.runId || '')) throw new Error('A valid QA interruption run ID is required.');
    if (!UUID_PATTERN.test(input.profileId || '')) throw new Error('A valid disposable QA profile ID is required.');
    if (!QA_INTERRUPTION_PHASES.includes(input.phase)) throw new Error('The requested QA interruption phase is not supported.');
    if (fsApi.existsSync(armedPath)) throw new Error('A QA interruption is already armed. Inspect the previous run first.');

    const instruction = {
      format: QA_INTERRUPTION_FORMAT,
      runId: input.runId.toLowerCase(),
      profileId: input.profileId.toLowerCase(),
      phase: input.phase,
      armedAt: new Date().toISOString(),
    };
    writeExclusive(armedPath, instruction);
    return { armed: true, runId: instruction.runId, phase: instruction.phase };
  }

  function checkpoint(input = {}) {
    if (!QA_INTERRUPTION_PHASES.includes(input.phase)) {
      throw new Error('The QA migration checkpoint is not supported.');
    }
    const instruction = readInstruction(armedPath);
    if (!instruction) return { stop: false };
    if (!UUID_PATTERN.test(input.profileId || '') ||
        instruction.profileId !== input.profileId.toLowerCase()) {
      throw new Error('The QA interruption instruction belongs to a different disposable profile.');
    }
    if (instruction.phase !== input.phase) return { stop: false };
    if (fsApi.existsSync(lastPath)) fsApi.unlinkSync(lastPath);
    // Atomic rename consumes the one-shot instruction before the QA process exits.
    fsApi.renameSync(armedPath, lastPath);
    return { stop: true, runId: instruction.runId, phase: instruction.phase };
  }

  function getLast() {
    return readInstruction(lastPath);
  }

  function clearLast(input = {}) {
    const last = getLast();
    if (!last) return false;
    if (last.runId !== String(input.runId || '').toLowerCase() ||
        last.profileId !== String(input.profileId || '').toLowerCase()) {
      throw new Error('The previous QA interruption record belongs to a different run or profile.');
    }
    fsApi.unlinkSync(lastPath);
    return true;
  }

  return Object.freeze({ arm, checkpoint, getLast, clearLast });
}

module.exports = { QA_INTERRUPTION_PHASES, createQaInterruptionController };
