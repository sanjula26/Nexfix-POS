import { Keyboard } from 'lucide-react';

const shortcuts = [
  { key: 'F2', label: 'Customer' },
  { key: 'F3', label: 'Search' },
  { key: 'F4', label: 'Discount' },
  { key: 'F5', label: 'Hold' },
  { key: 'F6', label: 'Complete' },
  { key: 'F8', label: 'Clear' },
] as const;

function Kbd({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-[2px] rounded-[5px] bg-raised border border-line border-b-2 text-[9px] font-extrabold text-sub font-mono">
      {children}
    </span>
  );
}

export default function POSKeyboardShortcutHints() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-5 sm:px-6 py-3 border-t border-line text-[10px] text-faint font-medium">
      <Keyboard size={11} className="text-faint" />
      {shortcuts.map(shortcut => (
        <span key={shortcut.key}><Kbd>{shortcut.key}</Kbd> {shortcut.label}</span>
      ))}
    </div>
  );
}
