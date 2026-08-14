import { useEffect, useRef } from 'react';

/**
 * Hardware barcode scanners act as keyboards and emit a burst of keydowns
 * followed by Enter. This hook detects that pattern and fires `onScan`.
 *
 * Ignores events when focus is inside INPUT / TEXTAREA / contentEditable
 * unless `force` is true (useful on the POS page where search is intentional).
 */
export function useBarcodeScanner(
  onScan: (code: string) => void,
  opts?: { enabled?: boolean; force?: boolean; minLength?: number; maxGapMs?: number },
) {
  const enabled = opts?.enabled !== false;
  const force = opts?.force === true;
  const minLength = opts?.minLength ?? 4;
  const maxGapMs = opts?.maxGapMs ?? 45;
  const buf = useRef('');
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable;
      if (typing && !force) return;

      const now = Date.now();
      if (now - last.current > maxGapMs) buf.current = '';
      last.current = now;

      if (e.key === 'Enter') {
        const code = buf.current.trim();
        buf.current = '';
        if (code.length >= minLength) {
          e.preventDefault();
          e.stopPropagation();
          cb.current(code);
        }
        return;
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buf.current += e.key;
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, force, minLength, maxGapMs]);
}
