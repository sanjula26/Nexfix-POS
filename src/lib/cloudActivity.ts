export interface CloudActivityState {
  active: number;
  operations: string[];
  startedAt: number | null;
}

const INITIAL: CloudActivityState = { active: 0, operations: [], startedAt: null };
let state: CloudActivityState = INITIAL;
let nextId = 0;
const activeOperations = new Map<number, string>();
const listeners = new Set<(next: CloudActivityState) => void>();

function publish(): void {
  state = {
    active: activeOperations.size,
    operations: [...activeOperations.values()],
    startedAt: activeOperations.size ? state.startedAt ?? Date.now() : null,
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
export async function withCloudActivity<T>(operation: string, action: () => Promise<T>): Promise<T> {
  const end = beginCloudActivity(operation);
  try {
    return await action();
  } finally {
    end();
  }
}
