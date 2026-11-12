import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBackup,
  validateBackup,
  validateBackupForRestore,
} from '../src/lib/backupValidation.ts';

function validState(): Record<string, unknown> {
  return {
    products: [] as unknown[],
    customers: [] as unknown[],
    suppliers: [] as unknown[],
    sales: [] as unknown[],
    purchases: [] as unknown[],
    expenses: [] as unknown[],
    exchanges: [] as unknown[],
    users: [] as unknown[],
    audit: [] as unknown[],
    held: [] as unknown[],
    sessions: [] as unknown[],
    units: [] as unknown[],
    repairs: [] as unknown[],
    settings: {},
    permissions: {},
    counters: { bill: 0, po: 0, ex: 0, job: 0, quote: 0, claim: 0 },
  };
}

function validEnvelope(state: Record<string, unknown> = validState()) {
  return {
    _meta: {
      app: 'Nexfix POS',
      version: 2,
      exportedAt: '2026-11-12T10:00:00.000Z',
      kind: 'manual',
    },
    state,
  };
}

test('backup validation accepts a valid v2 POS backup', () => {
  assert.equal(validateBackup(validEnvelope()), true);
  const automatic = validEnvelope();
  (automatic._meta as unknown as Record<string, unknown>).kind = 'auto';
  assert.equal(validateBackup(automatic), true);
});

test('backup parsing accepts valid JSON and safely rejects malformed JSON', () => {
  const envelope = validEnvelope();
  assert.deepEqual(parseBackup(JSON.stringify(envelope)), envelope);
  assert.equal(parseBackup('{not-json'), null);
});

test('backup validation rejects unsupported metadata and malformed required collections', () => {
  const wrongVersion = validEnvelope();
  (wrongVersion._meta as unknown as Record<string, unknown>).version = 3;
  assert.equal(validateBackup(wrongVersion), false);

  const missingSales = validEnvelope();
  delete missingSales.state.sales;
  assert.equal(validateBackup(missingSales), false);
});

test('backup validation rejects duplicate record IDs and invalid counters', () => {
  const duplicateIds = validState();
  duplicateIds.products = [{ id: 'product-1' }, { id: 'product-1' }];
  assert.equal(validateBackup(validEnvelope(duplicateIds)), false);

  const invalidCounter = validState();
  (invalidCounter.counters as Record<string, number>).bill = -1;
  assert.equal(validateBackup(validEnvelope(invalidCounter)), false);
});

test('backup validation checks local user credentials, role and timestamp shape', () => {
  const validUser = validState();
  validUser.users = [{
    id: 'user-1',
    name: 'Admin',
    email: 'admin@example.test',
    password: 'pbkdf2-hash-placeholder',
    role: 'admin',
    active: true,
    createdAt: '2026-11-12T10:00:00.000Z',
  }];
  assert.equal(validateBackup(validEnvelope(validUser)), true);

  const invalidUser = validState();
  invalidUser.users = [{
    id: 'user-1',
    name: 'Admin',
    email: 'admin@example.test',
    role: 'owner',
    active: true,
    createdAt: 'not-a-date',
  }];
  assert.equal(validateBackup(validEnvelope(invalidUser)), false);
});

test('backup validation rejects malformed credit-payment and inventory-ledger entries', () => {
  const invalidCredit = validState();
  invalidCredit.customerCreditPayments = [{ id: 'credit-1' }];
  assert.equal(validateBackup(validEnvelope(invalidCredit)), false);

  const invalidLedger = validState();
  invalidLedger.inventoryTransactions = [{ id: 'tx-1' }];
  assert.equal(validateBackup(validEnvelope(invalidLedger)), false);
});

test('restore validation fills optional legacy collections without mutating the input', () => {
  const input = validEnvelope();
  const restored = validateBackupForRestore(input);

  for (const key of [
    'kitItems',
    'quotations',
    'warrantyClaims',
    'purchaseReturns',
    'supplierPayments',
    'customerCreditPayments',
    'inventoryTransactions',
    'grns',
    'reverseRequests',
  ]) {
    assert.deepEqual(restored.state[key], [], `expected ${key} to default to an empty array`);
  }
  assert.equal('kitItems' in input.state, false);
});

test('restore validation refuses invalid backups before restore can start', () => {
  assert.throws(
    () => validateBackupForRestore({ _meta: {}, state: {} }),
    /Invalid or unsupported Nexfix POS backup/,
  );
});
