import type { ReactNode } from 'react';

interface POSKeyboardHintProps {
  children: ReactNode;
}

export default function POSKeyboardHint({ children }: POSKeyboardHintProps) {
  return (
    <span className="inline-flex items-center px-1.5 py-[2px] rounded-[5px] bg-raised border border-line border-b-2 text-[9px] font-extrabold text-sub font-mono">
      {children}
    </span>
  );
}
