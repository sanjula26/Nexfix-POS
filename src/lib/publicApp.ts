const DEFAULT_PUBLIC_APP_URL = 'https://sanjula26.github.io/Nexfix-POS/';

type DesktopBridge = {
  copyText?: (text: string) => Promise<boolean>;
  openExternal?: (url: string) => Promise<boolean>;
};

function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { nexfixDesktop?: DesktopBridge }).nexfixDesktop;
}

export function getPublicAppUrl(): string {
  const configured = String(import.meta.env.VITE_PUBLIC_APP_URL || '').trim();
  if (configured.startsWith('https://') || configured.startsWith('http://')) return configured.replace(/\/+$/, '') + '/';

  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) {
    const path = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    return window.location.origin + path;
  }

  return DEFAULT_PUBLIC_APP_URL;
}

export function buildPhoneSalesLink(shopId: string, machineId: string, timeZone?: string): string {
  const params = new URLSearchParams();
  if (shopId) params.set('shop', shopId);
  if (machineId) params.set('machine', machineId);
  if (timeZone) params.set('tz', timeZone);
  return `${getPublicAppUrl()}#/today?${params.toString()}`;
}

export async function copyText(value: string): Promise<boolean> {
  const text = value.trim();
  if (!text || typeof window === 'undefined') return false;

  try {
    const desktop = desktopBridge();
    if (desktop?.copyText) {
      const copied = await desktop.copyText(text);
      if (copied) return true;
    }
  } catch {
    // Continue to the browser clipboard/fallback path.
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // file:// and restricted browser contexts may reject Clipboard API access.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    const desktop = desktopBridge();
    if (desktop?.openExternal) return await desktop.openExternal(parsed.toString());

    const opened = window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    return !!opened;
  } catch {
    return false;
  }
}
