const MACHINE_ID_KEY = 'nexfix_machine_id_v1';
const MACHINE_NAME_KEY = 'nexfix_machine_name_v1';

function createMachineId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(-8)
    : Math.random().toString(36).slice(2, 10);
  return `POS-${random.toUpperCase()}`;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Returns one stable terminal identity per browser/desktop installation. */
export function getMachineIdentity(): { id: string; name: string } {
  if (typeof window === 'undefined') return { id: 'server-terminal', name: 'POS Terminal' };

  let id = readStorage(MACHINE_ID_KEY);
  if (!id) {
    id = createMachineId();
    writeStorage(MACHINE_ID_KEY, id);
  }

  let name = readStorage(MACHINE_NAME_KEY);
  if (!name) {
    name = id;
    writeStorage(MACHINE_NAME_KEY, name);
  }

  return { id, name };
}

export function setMachineName(name: string): { id: string; name: string } {
  const current = getMachineIdentity();
  const next = name.trim().slice(0, 80) || current.id;
  writeStorage(MACHINE_NAME_KEY, next);
  return { id: current.id, name: next };
}
