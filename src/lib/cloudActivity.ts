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
const activeOperations = new Map<number, string>();
const listeners = new Set<(next: CloudActivityState) => void>();

function publish(): void {
  state = {
    active: activeOperations.size,
    operations: [...activeOperations.values()],
    startedAt: activeOperations.size ? state.startedAt ?? Date.now() : null,
    lastError,
    lastSuccessAt,
    lastSuccessOperation,
  };
  listeners.forEach(listener => listener(state));
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
export function beginCloudActivity(operation: string): () => void {
  const id = ++nextId;
  lastError = null;
  activeOperations.set(id, operation);
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
export function reportCloudActivityFailure(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error || 'Cloud sync failed');
  publish();
}

export async function withCloudActivity<T>(
  operation: string,
  action: () => Promise<T>,
  didTransfer: (result: T) => boolean = () => true,
): Promise<T> {
  const end = beginCloudActivity(operation);
  try {
    const result = await action();
    if (didTransfer(result)) {
      lastSuccessAt = Date.now();
      lastSuccessOperation = operation;
      publish();
    } else if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' && result.error) {
      lastError = result.error;
      publish();
    }
    return result;
  } catch (error) {
    reportCloudActivityFailure(error);
    throw error;
  } finally {
    end();
  }
}
