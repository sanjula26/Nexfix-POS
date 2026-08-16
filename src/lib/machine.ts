const MACHINE_ID_KEY = 'nexfix_machine_id_v1';
const MACHINE_NAME_KEY = 'nexfix_machine_name_v1';

function createMachineId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(-8)
    : Math.random().toString(36).slice(2, 10);
  return `POS-${random.toUpperCase()}`;
}

/** Returns one stable terminal identity per browser/desktop installation. */
export function getMachineIdentity(): { id: string; name: string } {
  if (typeof window === 'undefined') return { id: 'server-terminal', name: 'POS Terminal' };
  let id = window.localStorage.getItem(MACHINE_ID_KEY);
  if (!id) {
    id = createMachineId();
    window.localStorage.setItem(MACHINE_ID_KEY, id);
  }
  let name = window.localStorage.getItem(MACHINE_NAME_KEY);
  if (!name) {
    name = id;
    window.localStorage.setItem(MACHINE_NAME_KEY, name);
  }
  return { id, name };
}

export function setMachineName(name: string): { id: string; name: string } {
  const current = getMachineIdentity();
  const next = name.trim().slice(0, 80) || current.id;
  window.localStorage.setItem(MACHINE_NAME_KEY, next);
  return { id: current.id, name: next };
}
