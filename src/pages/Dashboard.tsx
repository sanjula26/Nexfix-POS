import { ShoppingCart, Package, Wrench, Users, TrendingUp, AlertTriangle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { fmtRs } from '../lib/utils';

export default function Dashboard() {
  const { user } = useAuth();

  const cards = [
    { label: "Today's Sales", value: fmtRs(0), icon: TrendingUp, color: 'bg-emerald-500' },
    { label: 'Open Repairs', value: '0', icon: Wrench, color: 'bg-amber-500' },
    { label: 'Low Stock Items', value: '0', icon: AlertTriangle, color: 'bg-rose-500' },
    { label: 'Customers', value: '0', icon: Users, color: 'bg-blue-500' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-slate-500 text-sm">
          Welcome back, {user?.full_name}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(c => (
          <div
            key={c.label}
            className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 flex items-start gap-4"
          >
            <div className={`w-10 h-10 rounded-lg ${c.color} text-white flex items-center justify-center`}>
              <c.icon size={20} />
            </div>
            <div>
              <div className="text-sm text-slate-500">{c.label}</div>
              <div className="text-xl font-bold mt-0.5">{c.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6">
        <h2 className="font-semibold mb-3">Quick Start</h2>
        <ul className="text-sm text-slate-600 dark:text-slate-400 space-y-2 list-disc list-inside">
          <li>Go to <strong>POS</strong> to start selling</li>
          <li>Add products in <strong>Inventory</strong> (supports IMEI, Serial, Kits, CCTV attributes)</li>
          <li>Create <strong>Quotations</strong> for customers before converting to sales</li>
          <li>Manage <strong>Repairs</strong> and <strong>Warranty Claims</strong></li>
          <li>Configure Supabase in <code>.env</code> for multi-device cloud sync</li>
        </ul>
      </div>

      <div className="bg-blue-50 dark:bg-blue-950/40 rounded-xl border border-blue-200 dark:border-blue-900 p-5 text-sm">
        <strong>Next steps for full production use:</strong>
        <ol className="mt-2 list-decimal list-inside space-y-1 text-slate-700 dark:text-slate-300">
          <li>Create a free Supabase project</li>
          <li>Run <code>supabase/schema.sql</code> in the SQL editor</li>
          <li>Copy URL + anon key into <code>.env</code></li>
          <li>Restart <code>npm run dev</code></li>
        </ol>
      </div>
    </div>
  );
}
