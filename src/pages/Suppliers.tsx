import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Phone, Mail, Truck, Package } from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Modal, Field, EmptyState, PageHeading, Badge } from '../components/ui';
import { uid, fmtNum } from '../lib/utils';
import type { Supplier } from '../lib/types';

export default function Suppliers() {
  const { state, saveSupplier, deleteSupplier, can } = usePOS();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState<Supplier | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.suppliers.filter(s =>
      !q || s.name.toLowerCase().includes(q) || (s.contactPerson || '').toLowerCase().includes(q) || s.phone.includes(q)
    );
  }, [state.suppliers, search]);

  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    const phone = editing.phone.trim();
    const email = (editing.email || '').trim().toLowerCase();
    if (!name || !phone) return;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    saveSupplier({
      ...editing,
      name,
      phone,
      email: email || undefined,
      contactPerson: editing.contactPerson?.trim() || undefined,
      address: editing.address?.trim() || undefined,
    });
    setEditing(null);
  };

  const productCount = (id: string) => state.products.filter(p => p.supplierId === id).length;
  const emailInvalid = !!editing?.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editing.email.trim());

  return (
    <div>
      <PageHeading
        chip="Sourcing" chipTone="blue"
        title="Suppliers"
        sub={`${state.suppliers.length} registered suppliers`}
        actions={
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing({ id: uid(), name: '', contactPerson: '', phone: '', email: '', address: '', createdAt: new Date().toISOString() });
              setIsNew(true);
            }}
          >
            <Plus size={15} /> Add Supplier
          </button>
        }
      />

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line">
          <SearchInput value={search} onChange={setSearch} placeholder="Search suppliers..." className="max-w-md" />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Truck size={26} />} title="No suppliers found" sub="Add your distributors to track purchases" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px]">
              <thead>
                <tr>
                  <th className="th">Supplier</th><th className="th">Contact</th><th className="th">Address</th>
                  <th className="th">Products</th><th className="th !text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.id} className="hover:bg-raised/40 transition-colors">
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-white flex items-center justify-center shadow-md shrink-0">
                          <Truck size={16} />
                        </span>
                        <div>
                          <div className="font-semibold text-ink">{s.name}</div>
                          {s.contactPerson && <div className="text-[11px] text-faint mt-0.5">Contact: {s.contactPerson}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="td">
                      <div className="flex items-center gap-1.5 text-[13px] text-sub"><Phone size={12} className="text-faint" />{s.phone}</div>
                      {s.email && <div className="flex items-center gap-1.5 text-[12px] text-sky-500 mt-1"><Mail size={12} />{s.email}</div>}
                    </td>
                    <td className="td text-[13px] text-sub">{s.address || '—'}</td>
                    <td className="td">
                      <Badge tone="slate" className="num"><Package size={10} /> {fmtNum(productCount(s.id))} items</Badge>
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        <button className="icon-btn !w-8 !h-8" onClick={() => { setEditing({ ...s }); setIsNew(false); }}><Pencil size={14} /></button>
                        {can('act:deleteRecords') && (
                          <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={() => setDeleting(s)}><Trash2 size={14} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'Add supplier' : 'Edit supplier'} sub={editing?.name}>
        {editing && (
          <div className="space-y-4">
            <Field label="Company name">
              <input className="input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Mobile World Imports" />
            </Field>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Contact person">
                <input className="input" value={editing.contactPerson || ''} onChange={e => setEditing({ ...editing, contactPerson: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input className="input num" value={editing.phone} onChange={e => setEditing({ ...editing, phone: e.target.value })} placeholder="+94 11 000 0000" />
              </Field>
            </div>
            <Field label="Email">
              <input className={`input ${emailInvalid ? 'border-rose-500 focus:border-rose-500' : ''}`} value={editing.email || ''} onChange={e => setEditing({ ...editing, email: e.target.value })} placeholder="orders@supplier.lk" />
              {emailInvalid && <div className="text-xs text-rose-500 mt-1">Enter a valid email address.</div>}
            </Field>
            <Field label="Address">
              <input className="input" value={editing.address || ''} onChange={e => setEditing({ ...editing, address: e.target.value })} placeholder="City, District" />
            </Field>
            <div className="flex gap-2.5 pt-1">
              <button className="btn btn-primary flex-1" onClick={save} disabled={!editing.name.trim() || !editing.phone.trim() || emailInvalid}>
                <Plus size={15} /> {isNew ? 'Add supplier' : 'Save changes'}
              </button>
              <button className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete supplier?" sub={deleting?.name}>
        <p className="text-sm text-sub">
          Remove <b className="text-ink">{deleting?.name}</b>?
          {deleting && productCount(deleting.id) > 0 && (
            <span className="block mt-2 text-amber-600 dark:text-amber-400 font-medium">
              {productCount(deleting.id)} product(s) are linked to this supplier — they will keep their stock data.
            </span>
          )}
        </p>
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleting) deleteSupplier(deleting.id); setDeleting(null); }}>
            <Trash2 size={15} /> Delete
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleting(null)}>Keep supplier</button>
        </div>
      </Modal>
    </div>
  );
}
