import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

export type SearchableSelectOption = {
  id: string;
  label: string;
  searchText?: string;
};

type Props<T> = {
  value: string;
  options: T[];
  onChange: (value: string) => void;
  getLabel: (option: T) => string;
  getSearchText?: (option: T) => string;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  maxResults?: number;
  ariaLabel?: string;
  className?: string;
  emptyText?: string;
  renderOption?: (option: T, selected: boolean) => React.ReactNode;
};

export default function SearchableSelect<T extends { id: string }>({
  value,
  options,
  onChange,
  getLabel,
  getSearchText,
  placeholder = 'Search or select…',
  disabled = false,
  clearable = false,
  maxResults = 40,
  ariaLabel,
  className = '',
  emptyText = 'No matching options',
  renderOption,
}: Props<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const selected = options.find(option => option.id === value);
  const selectedLabel = selected ? getLabel(selected) : '';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options.slice(0, maxResults);

    const scored = options.map((option, index) => {
      const label = getLabel(option).toLowerCase();
      const text = (getSearchText ? getSearchText(option) : getLabel(option)).toLowerCase();
      let score = 0;
      if (label === needle) score += 1000;
      if (text.split(/\\s+/).some(part => part === needle)) score += 600;
      if (label.startsWith(needle)) score += 300;
      if (text.includes(needle)) score += 100;
      return { option, score, index };
    }).filter(item => item.score > 0);

    return scored
      .sort((a, b) => b.score - a.score || getLabel(a.option).localeCompare(getLabel(b.option)) || a.index - b.index)
      .slice(0, maxResults)
      .map(item => item.option);
  }, [options, query, maxResults, getLabel, getSearchText]);

  const choose = (option: T) => {
    onChange(option.id);
    setQuery('');
    setOpen(false);
  };

  const clear = () => {
    onChange('');
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input
          ref={inputRef}
          className={`input w-full pl-9 pr-16 ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
          value={open ? query : selectedLabel}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          onFocus={() => { if (!disabled) { setOpen(true); setQuery(''); setActive(0); } }}
          onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={event => {
            if (disabled) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(a => Math.min(a + 1, Math.max(0, matches.length - 1))); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
            else if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) choose(matches[active]); }
            else if (event.key === 'Escape') { event.preventDefault(); setQuery(''); setOpen(false); }
          }}
        />
        {clearable && value && !disabled && (
          <button type="button" className="absolute right-8 top-1/2 -translate-y-1/2 text-faint hover:text-ink" onClick={clear} aria-label="Clear selection">
            <X size={14} />
          </button>
        )}
        <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint" />
      </div>

      {open && !disabled && (
        <div className="absolute z-[70] mt-1 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="max-h-72 overflow-y-auto py-1" role="listbox" aria-label={ariaLabel || 'Options'}>
            {matches.length === 0 ? (
              <div className="px-3 py-3 text-sm text-sub">{emptyText}</div>
            ) : matches.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === value}
                className={`w-full border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-raised ${index === active ? 'bg-raised' : ''} ${option.id === value ? 'font-semibold' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                {renderOption ? renderOption(option, option.id === value) : (
                  <span className="block truncate text-sm text-ink">{getLabel(option)}</span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-line bg-raised/50 px-3 py-1.5 text-[10px] text-faint">
            <span>↑↓ navigate · Enter select · Esc close</span>
            {clearable && value ? <button type="button" className="font-semibold hover:text-ink" onClick={clear}>Clear</button> : null}
          </div>
        </div>
      )}
    </div>
  );
}
