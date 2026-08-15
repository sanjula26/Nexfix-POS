import { useState } from 'react';
import { Search, Plus, Minus, Trash2, CreditCard } from 'lucide-react';
import { fmtRs } from '../lib/utils';
import type { CartLine, Product } from '../lib/types';

// Demo products (will be replaced by Supabase / local store)
const DEMO_PRODUCTS: Product[] = [
  {
    id: '1', name: 'Samsung Galaxy A15 5G', sku: 'SP-A15', barcode: '4791000001',
    cost: 62000, price: 74500, stock: 8, reorder_level: 5,
    track_imei: true, track_serial: false, track_expiry: false,
    warranty_months: 12, is_kit: false, is_service: false, active: true,
    attributes: {}, shop_id: 'demo', created_at: new Date().toISOString(),
  },
  {
    id: '2', name: 'Hikvision 4MP Dome Camera', sku: 'CCTV-HK4MP', barcode: '4791000002',
    cost: 8500, price: 12500, stock: 20, reorder_level: 5,
    track_imei: false, track_serial: true, track_expiry: false,
    warranty_months: 24, is_kit: false, is_service: false, active: true,
    attributes: { resolution: '4MP', poe: true, night_vision: '30m IR', weatherproof: 'IP67' },
    shop_id: 'demo', created_at: new Date().toISOString(),
  },
  {
    id: '3', name: '4-Camera CCTV Full Package', sku: 'KIT-CCTV4', barcode: '4791000003',
    cost: 45000, price: 68500, stock: 5, reorder_level: 2,
    track_imei: false, track_serial: false, track_expiry: false,
    warranty_months: 12, is_kit: true, is_service: false, active: true,
    attributes: {}, shop_id: 'demo', created_at: new Date().toISOString(),
  },
  {
    id: '4', name: 'USB-C Fast Charger 25W', sku: 'AC-CHG25', barcode: '4791000004',
    cost: 2800, price: 4950, stock: 35, reorder_level: 10,
    track_imei: false, track_serial: false, track_expiry: false,
    warranty_months: 6, is_kit: false, is_service: false, active: true,
    attributes: {}, shop_id: 'demo', created_at: new Date().toISOString(),
  },
];

export default function POS() {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');

  const filtered = DEMO_PRODUCTS.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase()) ||
    p.barcode?.includes(query) ||
    p.sku?.toLowerCase().includes(query.toLowerCase())
  );

  const addToCart = (p: Product) => {
    setCart(prev => {
      const existing = prev.find(l => l.product.id === p.id);
      if (existing) {
        return prev.map(l =>
          l.product.id === p.id ? { ...l, qty: l.qty + 1 } : l
        );
      }
      return [...prev, { product: p, qty: 1, price: p.price, discount: 0, unitIds: [] }];
    });
  };

  const updateQty = (id: string, delta: number) => {
    setCart(prev =>
      prev
        .map(l => (l.product.id === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l))
        .filter(l => l.qty > 0)
    );
  };

  const removeLine = (id: string) => {
    setCart(prev => prev.filter(l => l.product.id !== id));
  };

  const subtotal = cart.reduce((s, l) => s + l.price * l.qty - l.discount, 0);
  const total = subtotal;

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col lg:flex-row gap-4">
      {/* Product list */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name, SKU, barcode…"
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 outline-none"
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 content-start">
          {filtered.map(p => (
            <button
              key={p.id}
              onClick={() => addToCart(p)}
              className="text-left p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-blue-400 hover:shadow-md transition"
            >
              <div className="font-medium text-sm line-clamp-2">{p.name}</div>
              <div className="text-xs text-slate-500 mt-1">
                {p.is_kit && <span className="text-violet-600 mr-1">KIT</span>}
                {p.track_imei && <span className="text-amber-600 mr-1">IMEI</span>}
                Stock: {p.stock}
              </div>
              <div className="font-semibold text-blue-600 mt-1">{fmtRs(p.price, false)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Cart */}
      <div className="w-full lg:w-96 flex flex-col bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 font-semibold">
          Cart ({cart.length})
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {cart.length === 0 && (
            <div className="text-center text-slate-400 text-sm py-12">
              Cart is empty. Click products to add.
            </div>
          )}
          {cart.map(l => (
            <div key={l.product.id} className="flex gap-2 items-start p-2 rounded-lg bg-slate-50 dark:bg-slate-800">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{l.product.name}</div>
                <div className="text-xs text-slate-500">{fmtRs(l.price)} × {l.qty}</div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => updateQty(l.product.id, -1)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700">
                  <Minus size={14} />
                </button>
                <span className="w-6 text-center text-sm">{l.qty}</span>
                <button onClick={() => updateQty(l.product.id, 1)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700">
                  <Plus size={14} />
                </button>
                <button onClick={() => removeLine(l.product.id)} className="p-1 rounded text-red-500 hover:bg-red-50">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex justify-between text-lg font-bold">
            <span>Total</span>
            <span>{fmtRs(total)}</span>
          </div>
          <button
            disabled={cart.length === 0}
            className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium flex items-center justify-center gap-2"
          >
            <CreditCard size={18} />
            Checkout
          </button>
        </div>
      </div>
    </div>
  );
}
