import { useState } from 'react';
import { Plus, Search, Package } from 'lucide-react';
import { fmtRs } from '../lib/utils';

export default function Inventory() {
  const [q, setQ] = useState('');

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-slate-500">
            Products, Kits, IMEI/Serial units, CCTV attributes
          </p>
        </div>
        <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
          <Plus size={16} />
          Add Product
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search products…"
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center">
        <Package className="mx-auto text-slate-300 mb-3" size={40} />
        <p className="text-slate-500 text-sm">
          No products yet. Connect Supabase and seed data, or add products manually.
        </p>
        <p className="text-xs text-slate-400 mt-2">
          Supports: IMEI tracking · Serial numbers · Kits/BOM · Custom attributes (CCTV resolution, PoE, etc.) · Warranty months
        </p>
      </div>
    </div>
  );
}
