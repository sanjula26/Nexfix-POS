import { idbGetCloudSyncMeta, idbSetCloudSyncMeta } from './db.ts';

export interface CloudActivityScope {
  shopId: string;
  userId: string;
}

export interface CloudActivityState {
  active: number;
  operations: string[];
  startedAt: number | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastSuccessOperation: string | null;
}

const INITIAL: CloudActivityState = { active: 0, operations: [], startedAt: null, lastError: null, lastSuccessAt: null, lastSuccessOperation: null };
let state: CloudActivityState = INITIAL;
let nextId = 0;
let lastError: string | null = null;
let lastSuccessAt: number | null = null;
let lastSuccessOperation: string | null = null;
let activeScope: CloudActivityScope | null = null;
let activeScopeKey: string | null = null;
let scopeGeneration = 0;
let scopeSuccessRevision = 0;
interface ActiveCloudOperation {
  operation: string;
  scopeKey: string | null;
}
const activeOperations = new Map<number, ActiveCloudOperation>();
const listeners = new Set<(next: CloudActivityState) => void>();

function scopeKey(scope: CloudActivityScope | null): string | null {
  if (!scope) return null;
  const shopId = scope.shopId.trim();
  const userId = scope.userId.trim();
  return shopId && userId ? `${encodeURIComponent(shopId)}:${encodeURIComponent(userId)}` : null;
}

function publish(): void {
  const visibleOperations = [...activeOperations.values()].filter(item => item.scopeKey === activeScopeKey);
  state = {
    active: visibleOperations.length,
    operations: visibleOperations.map(item => item.operation),
    startedAt: visibleOperations.length ? state.startedAt ?? Date.now() : null,
    lastError,
    lastSuccessAt,
    lastSuccessOperation,
  };
  listeners.forEach(listener => listener(state));
}

/** Select the current cloud identity. Local POS cashier/admin IDs are deliberately not used. */
export async function setCloudActivityScope(scope: CloudActivityScope | null): Promise<void> {
  const nextScope = scope && scope.shopId.trim() && scope.userId.trim()
    ? { shopId: scope.shopId.trim(), userId: scope.userId.trim() }
    : null;
  const nextKey = scopeKey(nextScope);
  if (nextKey === activeScopeKey) return;

  activeScope = nextScope;
  activeScopeKey = nextKey;
  const generation = ++scopeGeneration;
  scopeSuccessRevision = 0;
  lastError = null;
  lastSuccessAt = null;
  lastSuccessOperation = null;
  publish();

  if (!nextScope) return;
  const loadRevision = scopeSuccessRevision;
  const saved = await idbGetCloudSyncMeta(nextScope.shopId, nextScope.userId);
  if (generation !== scopeGeneration || activeScopeKey !== nextKey || scopeSuccessRevision !== loadRevision || !saved) return;
  lastSuccessAt = Date.parse(saved.lastSuccessAt);
  lastSuccessOperation = saved.lastSuccessOperation;
  publish();
}

export function getCloudActivityState(): CloudActivityState {
  return state;
}

export function subscribeCloudActivity(listener: (next: CloudActivityState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** Mark a real cloud request as active and return an idempotent completion callback. */
export function beginCloudActivity(operation: string, requestScopeKey: string | null = activeScopeKey): () => void {
  const id = ++nextId;
  lastError = null;
  activeOperations.set(id, { operation, scopeKey: requestScopeKey });
  publish();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeOperations.delete(id);
    publish();
  };
}

/** Track an async cloud operation without changing its result or error behavior. */
function reportCloudActivityFailure(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error || 'Cloud sync failed');
  publish();
}

export async function withCloudActivity<T>(
  operation: string,
  action: () => Promise<T>,
  didTransfer: (result: T) => boolean = () => true,
): Promise<T> {
  const requestScope = activeScope;
  const requestScopeKey = activeScopeKey;
  const end = beginCloudActivity(operation, requestScopeKey);
  try {
    const result = await action();
    if (didTransfer(result)) {
      const completedAt = new Date().toISOString();
      if (requestScope) {
        // Best effort only: never await IndexedDB metadata while a bill/GRN action is completing.
        void idbSetCloudSyncMeta(requestScope.shopId, requestScope.userId, {
          lastSuccessAt: completedAt,
          lastSuccessOperation: operation.slice(0, 80),
        }).catch(() => false);
      }
      if (requestScopeKey === activeScopeKey) {
        if (requestScopeKey) scopeSuccessRevision += 1;
        lastSuccessAt = Date.parse(completedAt);
        lastSuccessOperation = operation;
        lastError = null;
        publish();
      }
    } else if (requestScopeKey === activeScopeKey && result && typeof result === 'object') {
      const resultError = 'error' in result && typeof result.error === 'string' ? result.error : '';
      const notConfirmed = 'ok' in result && result.ok === false;
      if (resultError || notConfirmed) {
        lastError = resultError || `${operation} was not confirmed`;
        publish();
      }
    }
    return result;
  } catch (error) {
    // An in-flight request from a previous account/shop must not overwrite the
    // current identity's issue panel after the operator switches cloud scope.
    if (requestScopeKey === activeScopeKey) reportCloudActivityFailure(error);
    throw error;
  } finally {
    end();
  }
}
