import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installOneShotQaQuotaInjection,
  QA_PROFILE_DATABASE_NAME,
  type QaQuotaDomain,
} from '../electron/qa/quota-injector.ts';

function createFakeDatabase(name: string, prototype: Pick<IDBDatabase, 'transaction'>): IDBDatabase {
  const database = Object.create(prototype) as IDBDatabase;
  Object.defineProperty(database, 'name', { configurable: true, value: name });
  return database;
}

const targetStores: Record<QaQuotaDomain, string> = {
  app_state: 'app_state',
  restore_checkpoint: 'app_state',
  sync_queue: 'sync_queue',
  meta: 'meta',
};

for (const domain of Object.keys(targetStores) as QaQuotaDomain[]) {
  test('QA quota injector throws once for the exact ' + domain + ' write transaction only', () => {
    let normalCalls = 0;
    const original = function (
      _storeNames: string | string[],
      _mode?: IDBTransactionMode,
      _options?: IDBTransactionOptions,
    ): IDBTransaction {
      normalCalls += 1;
      return {} as IDBTransaction;
    };
    const prototype = { transaction: original } as unknown as Pick<IDBDatabase, 'transaction'>;
    const database = createFakeDatabase(QA_PROFILE_DATABASE_NAME, prototype);
    const unrelatedDatabase = createFakeDatabase('production-userdata-db', prototype);
    const messages: string[] = [];
    const injector = installOneShotQaQuotaInjection(
      domain,
      '12345678-1234-4234-8234-123456789abc',
      error => messages.push(error.message),
      prototype,
    );

    try {
      unrelatedDatabase.transaction(targetStores[domain], 'readwrite');
      database.transaction(targetStores[domain], 'readonly');
      database.transaction('unrelated_store', 'readwrite');
      assert.equal(normalCalls, 3);
      assert.equal(injector.didInject, false);

      assert.throws(
        () => database.transaction(targetStores[domain], 'readwrite'),
        (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError',
      );
      assert.equal(injector.didInject, true);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /QuotaExceededError/);

      database.transaction(targetStores[domain], 'readwrite');
      assert.equal(normalCalls, 4);
    } finally {
      injector.dispose();
    }

    assert.equal(prototype.transaction, original);
  });
}

test('QA quota injector rejects malformed run IDs and unsupported domains', () => {
  const prototype = { transaction: () => ({}) as IDBTransaction } as unknown as Pick<IDBDatabase, 'transaction'>;
  assert.throws(
    () => installOneShotQaQuotaInjection('app_state', 'not-a-run-id', undefined, prototype),
    /valid QA run ID/,
  );
  assert.throws(
    () => installOneShotQaQuotaInjection('other' as QaQuotaDomain, '12345678-1234-4234-8234-123456789abc', undefined, prototype),
    /Unsupported QA quota-injection domain/,
  );
});
