import { useMemo, useState } from 'react';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtRs, uid } from '../lib/utils';
import type { KitItem, Product } from '../lib/types';

function loadKits(): KitItem[] {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return [];
    return (JSON.parse(raw).kitItems as KitItem[]) || [];
  } catch {
    return [];
  }
}

function persistKits(list: KitItem[]) {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return;
    const data = JSON.parse(raw);
    data.kitItems = list;
    localStorage.setItem('nexfix_pos_v2', JSON.stringify(data));
  } catch { /* ignore */ }
}

export default function Kits() {
  const { state, saveProduct, logAudit } = usePOS();
  const [kits, setKits] = useState<KitItem[]>(() => loadKits());
  const [q, setQ] = useState('');
  const [kitProductId, setKitProductId] = useState('');
  const [open, setOpen] = useState(false);
  const [compId, setCompId] = useState('');
  const [compQty, setCompQty] = useState(1);

  const kitProducts = state.products.filter(p => p.isKit && p.active);
  const components = state.products.filter(p => !p.isKit && p.active);

  const filteredKits = useMemo(() => {
    const query = q.trim().toLowerCase();
    return kitProducts.filter(p => !query || p.name.toLowerCase().includes(query) || p.sku.toLowerCase().includes(query));
  }, [kitProducts, q]);

  const linesFor = (kitId: string) => kits.filter(k => k.kitProductId === kitId);
  const nameOf = (id: string) => state.products.find(p => p.id === id)?.name || id;

  const markAsKit = (p: Product) => {
    saveProduct({ ...p, isKit: true });
    logAudit('UPDATE', 'Product', 'Marked as kit: ' + p.name);
  };

  const addComponent = () => {
    if (!kitProductId || !compId || compQty <= 0 || kitProductId === compId) return;
    const exists = kits.find(k => k.kitProductId === kitProductId && k.componentProductId === compId);
    const next = exists
      ? kits.map(k => (k.id === exists.id ? { ...k, qty: compQty } : k))
      : [{ id: uid(), kitProductId, componentProductId: compId, qty: compQty }, ...kits];
    setKits(next);
    persistKits(next);
    logAudit('UPDATE', 'Kit', 'BOM line for kit ' + kitProductId);
    setCompId('');
    setCompQty(1);
  };

  const removeLine = (id: string) => {
    const next = kits.filter(k => k.id !== id);
    setKits(next);
    persistKits(next);
  };

  return (
    <div className="space-y-4">
      <PageHeading
        chip="Inventory"
        title="Kits / BOM"
        sub="Bundle products — CCTV packages, laptop bundles, accessory kits"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> Manage kit
          </button>
        }
      />
      <SearchInput value={q} onChange={setQ} placeholder="Search kit products…" />
      {filteredKits.length === 0 ? (
        <EmptyState icon={<Boxes size={28} />} title="No kit products yet" sub="Use Manage kit to mark a product as kit and add components." />
      ) : (
        <div className="space-y-3">
          {filteredKits.map(p => {
            const lines = linesFor(p.id);
            const bomCost = lines.reduce((s, l) => {
              const c = state.products.find(x => x.id === l.componentProductId);
              return s + (c?.cost || 0) * l.qty;
            }, 0);
            return (
              <div key={p.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <div>
                    <div className="font-bold text-ink">{p.name}</div>
                    <div className="text-xs text-sub mt-0.5">{p.sku} · Sell {fmtRs(p.price)}</div>
                  </div>
                  <div className="flex gap-2">
                    <Badge tone="violet">KIT</Badge>
                    <Badge tone="slate">BOM cost {fmtRs(bomCost)}</Badge>
                  </div>
                </div>
                {lines.length === 0 ? (
                  <p className="text-sm text-faint">No components yet.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {lines.map(l => (
                      <li key={l.id} className="flex justify-between gap-2 border-t border-line pt-1.5">
                        <span>{nameOf(l.componentProductId)} × {l.qty}</span>
                        <button type="button" className="text-rose-500" onClick={() => removeLine(l.id)}><Trash2 size={14} /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Manage kit / BOM" wide>
        <div className="space-y-4">
          <Field label="Kit product">
            <select className="input" value={kitProductId} onChange={e => setKitProductId(e.target.value)}>
              <option value="">Select kit product…</option>
              {state.products.filter(p => p.active).map(p => (
                <option key={p.id} value={p.id}>{p.name}{p.isKit ? ' (kit)' : ''}</option>
              ))}
            </select>
          </Field>
          {kitProductId && !state.products.find(p => p.id === kitProductId)?.isKit && (
            <button type="button" className="btn btn-soft text-sm" onClick={() => {
              const p = state.products.find(x => x.id === kitProductId);
              if (p) markAsKit(p);
            }}>Mark selected product as Kit</button>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <Field label="Component">
              <select className="input" value={compId} onChange={e => setCompId(e.target.value)}>
                <option value="">Select component…</option>
                {components.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Qty">
              <input type="number" className="input" value={compQty} min={0.01} step={0.01} onChange={e => setCompQty(Number(e.target.value) || 1)} />
            </Field>
            <button type="button" className="btn btn-primary" onClick={addComponent}>Add to BOM</button>
          </div>
          {kitProductId && (
            <div className="rounded-xl border border-line p-3">
              <div className="text-xs font-bold uppercase text-sub mb-2">Current BOM</div>
              {linesFor(kitProductId).length === 0 ? <p className="text-sm text-faint">Empty</p> : linesFor(kitProductId).map(l => (
                <div key={l.id} className="flex justify-between text-sm py-1 border-t border-line">
                  <span>{nameOf(l.componentProductId)} × {l.qty}</span>
                  <button type="button" className="text-rose-500" onClick={() => removeLine(l.id)}>Remove</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
