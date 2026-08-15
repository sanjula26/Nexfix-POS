import { useMemo, useState } from 'react';
import { Cpu, Plus, Search, Trash2, Smartphone, AlertTriangle } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import type { InventoryUnit, UnitStatus } from '../lib/types';

const STATUS_TONE: Record<UnitStatus, string> = {
  in_stock: 'emerald',
  sold: 'slate',
  returned: 'amber',
  reserved: 'violet',
  defective: 'rose',
};

export default function Units() {
  const { state, saveUnit, deleteUnit, can } = usePOS();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [editing, setEditing] = useState<InventoryUnit | null>(null);
  const [isNew, setIsNew] = useState(false);

  const units = state.units || [];
  const products = state.products;

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return units.filter(u => {
      if (status !== 'all' && u.status !== status) return false;
      if (!query) return true;
      const p = products.find(x => x.id === u.productId);
      return (
        (u.imei || '').toLowerCase().includes(query) ||
        (u.serial || '').toLowerCase().includes(query) ||
        (p?.name || '').toLowerCase().includes(query) ||
        (u.note || '').toLowerCase().includes(query)
      );
    });
  }, [units, products, q, status]);

  const expiringSoon = useMemo(() => {
    const soon = Date.now() + 30 * 86400000;
    return units.filter(u => u.expiryDate && u.status === 'in_stock' && new Date(u.expiryDate).getTime() < soon);
  }, [units]);

  const openNew = () => {
    const firstTracked = products.find(p => p.trackImei || p.trackSerial) || products[0];
    setEditing({
      id: uid(),
      productId: firstTracked?.id || '',
      status: 'in_stock',
      createdAt: new Date().toISOString(),
      imei: '',
      serial: '',
    });
    setIsNew(true);
  };

  const save = () => {
    if (!editing || !editing.productId) return;
    // allow saving placeholder units (fill IMEI later)
    if (!editing.imei?.trim() && !editing.serial?.trim() && !editing.note?.trim() && isNew) return;
    saveUnit({
      ...editing,
      imei: editing.imei?.trim() || undefined,
      serial: editing.serial?.trim() || undefined,
      expiryDate: editing.expiryDate || undefined,
      note: editing.note?.trim() || undefined,
    });
    setEditing(null);
  };

  return (
    <div>
      <PageHeading
        chip="Traceability" chipTone="violet"
        title="IMEI / Serial Units"
        sub={`${units.filter(u => u.status === 'in_stock').length} in stock · full history per unit`}
        actions={
          can('act:manageStock') && (
            <button className="btn btn-primary" onClick={openNew}>
              <Plus size={15} /> Add unit
            </button>
          )
        }
      />

      {expiringSoon.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-2.5 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <b>{expiringSoon.length}</b> unit(s) expire within 30 days
            <span className="text-faint"> — check serials: {expiringSoon.slice(0, 3).map(u => u.serial || u.imei).join(', ')}</span>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line flex flex-wrap gap-3 items-center">
          <SearchInput value={q} onChange={setQ} placeholder="Search IMEI, serial, product…" className="flex-1 min-w-[220px]" />
          <select className="input w-40" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="all">All status</option>
            <option value="in_stock">In stock</option>
            <option value="sold">Sold</option>
            <option value="returned">Returned</option>
            <option value="defective">Defective</option>
          </select>
          <span className="text-xs text-faint">{rows.length} units</span>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={<Cpu size={26} />} title="No units found" sub="Add IMEI/serial units when receiving stock" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">Product</th>
                  <th className="th">IMEI</th>
                  <th className="th">Serial</th>
                  <th className="th">Expiry</th>
                  <th className="th">Status</th>
                  <th className="th">Sale</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map(u => {
                  const p = products.find(x => x.id === u.productId);
                  const expired = u.expiryDate && new Date(u.expiryDate).getTime() < Date.now();
                  return (
                    <tr key={u.id} className="hover:bg-raised/40">
                      <td className="td">
                        <div className="font-semibold text-ink text-[13px]">{p?.name || '—'}</div>
                        <div className="text-[11px] text-faint">{p?.sku}</div>
                      </td>
                      <td className="td num text-[12px]">{u.imei || '—'}</td>
                      <td className="td num text-[12px]">{u.serial || '—'}</td>
                      <td className={`td text-[12px] ${expired ? 'text-rose-500 font-bold' : ''}`}>
                        {u.expiryDate ? fmtDate(u.expiryDate) : '—'}
                      </td>
                      <td className="td"><Badge tone={(STATUS_TONE[u.status] as any) || 'slate'}>{u.status}</Badge></td>
                      <td className="td text-[12px] text-sub">{u.saleBillNo || '—'}</td>
                      <td className="td">
                        <div className="flex gap-1">
                          <button className="icon-btn !w-8 !h-8" onClick={() => { setEditing({ ...u }); setIsNew(false); }}>
                            <Search size={14} />
                          </button>
                          {can('act:deleteRecords') && u.status === 'in_stock' && (
                            <button className="icon-btn !w-8 !h-8 hover:!text-rose-500" onClick={() => deleteUnit(u.id)}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'Add unit' : 'Unit details'} sub={editing?.imei || editing?.serial}>
        {editing && (
          <div className="space-y-3">
            <Field label="Product">
              <select
                className="input"
                value={editing.productId}
                onChange={e => setEditing({ ...editing, productId: e.target.value })}
                disabled={!isNew}
              >
                {products.filter(p => p.active).map(p => (
                  <option key={p.id} value={p.id}>{p.name} {p.trackImei ? '(IMEI)' : p.trackSerial ? '(Serial)' : ''}</option>
                ))}
              </select>
            </Field>
            <Field label="IMEI">
              <span className="relative block">
                <Smartphone size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input className="input pl-9 num" value={editing.imei || ''} onChange={e => setEditing({ ...editing, imei: e.target.value })} placeholder="15-digit IMEI" />
              </span>
            </Field>
            <Field label="Serial number">
              <input className="input num" value={editing.serial || ''} onChange={e => setEditing({ ...editing, serial: e.target.value })} placeholder="Optional serial" />
            </Field>
            <Field label="Expiry date" hint="For batteries / items with shelf life">
              <input className="input" type="date" value={editing.expiryDate?.slice(0, 10) || ''} onChange={e => setEditing({ ...editing, expiryDate: e.target.value || undefined })} />
            </Field>
            <Field label="Status">
              <select className="input" value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as UnitStatus })}>
                {(['in_stock', 'sold', 'returned', 'reserved', 'defective'] as UnitStatus[]).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Note">
              <input className="input" value={editing.note || ''} onChange={e => setEditing({ ...editing, note: e.target.value })} />
            </Field>
            <div className="flex gap-2.5 pt-1">
              <button className="btn btn-primary flex-1" onClick={save} disabled={!editing.productId}>
                {isNew ? 'Add unit' : 'Save'}
              </button>
              <button className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
