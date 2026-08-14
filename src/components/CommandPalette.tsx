import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, LayoutGrid, ShoppingCart, Package, Cpu, Wrench, Users, Truck,
  ClipboardList, ReceiptText, ArrowLeftRight, Wallet, BarChart3, Tags,
  Settings, ScrollText, UserCog, X,
} from 'lucide-react';
import { usePOS } from '../lib/store';

type Item = {
  id: string;
  label: string;
  hint?: string;
  path?: string;
  icon: React.ElementType;
  perm?: string;
  adminOnly?: boolean;
  keywords?: string;
};

const NAV_ITEMS: Item[] = [
  { id: 'dash', label: 'Dashboard', path: '/', icon: LayoutGrid, perm: 'page:dashboard', keywords: 'home overview' },
  { id: 'pos', label: 'POS / Sales', path: '/pos', icon: ShoppingCart, perm: 'page:pos', keywords: 'bill checkout sell' },
  { id: 'inv', label: 'Inventory', path: '/inventory', icon: Package, perm: 'page:inventory', keywords: 'products stock sku' },
  { id: 'units', label: 'IMEI / Serial Units', path: '/units', icon: Cpu, perm: 'page:units', keywords: 'imei serial traceability' },
  { id: 'rep', label: 'Repairs', path: '/repairs', icon: Wrench, perm: 'page:repairs', keywords: 'service job fix' },
  { id: 'cust', label: 'Customers', path: '/customers', icon: Users, perm: 'page:customers' },
  { id: 'sup', label: 'Suppliers', path: '/suppliers', icon: Truck, perm: 'page:suppliers' },
  { id: 'po', label: 'Purchases', path: '/purchases', icon: ClipboardList, perm: 'page:purchases' },
  { id: 'sales', label: 'Sales History', path: '/sales', icon: ReceiptText, perm: 'page:sales' },
  { id: 'ex', label: 'Exchanges', path: '/exchanges', icon: ArrowLeftRight, perm: 'page:exchanges' },
  { id: 'exp', label: 'Expenses', path: '/expenses', icon: Wallet, perm: 'page:expenses' },
  { id: 'rep2', label: 'Reports', path: '/reports', icon: BarChart3, perm: 'page:reports' },
  { id: 'tags', label: 'Price Tags', path: '/price-tags', icon: Tags, perm: 'page:pricetags' },
  { id: 'users', label: 'Users', path: '/users', icon: UserCog, adminOnly: true },
  { id: 'audit', label: 'Audit Log', path: '/audit-log', icon: ScrollText, adminOnly: true },
  { id: 'set', label: 'Settings', path: '/settings', icon: Settings, adminOnly: true },
];

export default function CommandPalette() {
  const { can, user, state, findUnitByCode } = usePOS();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);

  const visibleNav = useMemo(() => {
    return NAV_ITEMS.filter(n => {
      if (n.adminOnly && user?.role !== 'admin') return false;
      if (n.perm && !can(n.perm)) return false;
      return true;
    });
  }, [can, user]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const items: Item[] = [];

    // Nav
    visibleNav.forEach(n => {
      if (!query || n.label.toLowerCase().includes(query) || (n.keywords || '').includes(query)) {
        items.push(n);
      }
    });

    // Products (limit)
    if (query.length >= 2) {
      state.products
        .filter(p => p.active && (
          p.name.toLowerCase().includes(query) ||
          p.sku.toLowerCase().includes(query) ||
          p.barcode.includes(query) ||
          p.brand.toLowerCase().includes(query)
        ))
        .slice(0, 8)
        .forEach(p => {
          items.push({
            id: `p-${p.id}`,
            label: p.name,
            hint: `${p.sku} · stock ${p.stock}`,
            path: '/pos',
            icon: Package,
            keywords: p.barcode,
          });
        });
    }

    // IMEI / serial lookup
    if (query.length >= 6) {
      const unit = findUnitByCode?.(query);
      if (unit) {
        const prod = state.products.find(p => p.id === unit.productId);
        items.unshift({
          id: `u-${unit.id}`,
          label: unit.imei || unit.serial || unit.id,
          hint: `${prod?.name || 'Unit'} · ${unit.status}`,
          path: '/units',
          icon: Cpu,
        });
      }
    }

    return items.slice(0, 20);
  }, [q, visibleNav, state.products, state.units, findUnitByCode]);

  useEffect(() => { setActive(0); }, [q, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
        setQ('');
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onOpen = () => { setOpen(true); setQ(''); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('nexfix:open-palette', onOpen as EventListener);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('nexfix:open-palette', onOpen as EventListener);
    };
  }, [open]);

  const go = useCallback((item: Item) => {
    if (item.path) navigate(item.path);
    setOpen(false);
    setQ('');
  }, [navigate]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(i => Math.min(i + 1, Math.max(0, results.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && results[active]) {
        e.preventDefault();
        go(results[active]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, results, active, go]);

  if (!open || !user) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-lg rounded-2xl border border-line bg-surface shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 border-b border-line">
          <Search size={16} className="text-faint shrink-0" />
          <input
            autoFocus
            className="flex-1 bg-transparent py-3.5 text-sm text-ink outline-none placeholder:text-faint"
            placeholder="Search pages, products, IMEI… (Ctrl+K)"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <button type="button" className="icon-btn !w-8 !h-8" onClick={() => setOpen(false)} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-faint">No matches</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.id}
                type="button"
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  i === active ? 'bg-violet-500/10 text-ink' : 'text-sub hover:bg-raised'
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item)}
              >
                <span className="w-8 h-8 rounded-lg bg-raised border border-line flex items-center justify-center shrink-0">
                  <item.icon size={15} className="text-violet-500" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink truncate">{item.label}</span>
                  {item.hint && <span className="block text-[11px] text-faint truncate">{item.hint}</span>}
                </span>
                {item.path && <span className="text-[10px] text-faint font-mono hidden sm:inline">{item.path}</span>}
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-line text-[10px] text-faint flex gap-3">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
