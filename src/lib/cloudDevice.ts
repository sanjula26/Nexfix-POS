const DEVICE_KEY = 'nexfix_device_id';
const MAX_DEVICE_ID_LENGTH = 200;

export function getCloudDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)?.trim();
    if (existing && existing.length <= MAX_DEVICE_ID_LENGTH) return existing;
    const id = crypto.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
