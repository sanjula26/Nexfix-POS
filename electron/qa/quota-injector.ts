export type QaQuotaDomain = 'app_state' | 'restore_checkpoint' | 'sync_queue' | 'meta';
export const QA_PROFILE_DATABASE_NAME = 'nexfix_pos_db';

const DOMAIN_STORE: Readonly<Record<QaQuotaDomain, string>> = Object.freeze({
  app_state: 'app_state',
  restore_checkpoint: 'app_state',
  sync_queue: 'sync_queue',
  meta: 'meta',
});

type TransactionPrototype = Pick<IDBDatabase, 'transaction'>;

export type QaQuotaInjection = {
  readonly didInject: boolean;
  dispose: () => void;
};

/** One-shot transaction-boundary QuotaExceededError, available only to the isolated QA renderer. */
export function installOneShotQaQuotaInjection(
  domain: QaQuotaDomain,
  runId: string,
  onInjected?: (error: DOMException) => void,
  prototype: TransactionPrototype = IDBDatabase.prototype,
): QaQuotaInjection {
  if (!Object.prototype.hasOwnProperty.call(DOMAIN_STORE, domain)) {
    throw new Error('Unsupported QA quota-injection domain.');
  }
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error('A valid QA run ID is required for quota injection.');
  }

  const original = prototype.transaction;
  let injected = false;
  let disposed = false;
  const wrapped = function (
    this: IDBDatabase,
    storeNames: string | string[],
    mode: IDBTransactionMode = 'readonly',
    options?: IDBTransactionOptions,
  ): IDBTransaction {
    const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
    if (!injected && this.name === QA_PROFILE_DATABASE_NAME &&
        mode === 'readwrite' && names.length === 1 && names[0] === DOMAIN_STORE[domain]) {
      injected = true;
      const error = new DOMException(
        'Controlled one-shot storage QA quota failure (' + domain + ', ' + runId + '). No disk space is consumed.',
        'QuotaExceededError',
      );
      try { onInjected?.(error); } catch { /* Keep the injected failure deterministic. */ }
      throw error;
    }
    return Reflect.apply(original, this, [storeNames, mode, options]) as IDBTransaction;
  };
  prototype.transaction = wrapped as IDBDatabase['transaction'];

  return {
    get didInject() { return injected; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (prototype.transaction === wrapped) prototype.transaction = original;
    },
  };
}
