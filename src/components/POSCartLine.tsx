import { useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Lock, Minus, Pencil, Plus, X } from 'lucide-react';
import { Badge } from './ui';
import { fmtRs } from '../lib/utils';

function CartLine({
  line, unitPrice, canDiscount, canEditPrice, onAskUnlock, onQty, onDisc, onPrice, onRemove,
}: {
  line: { productId: string; qty: number; discount: number; price?: number; product: { name: string; price: number; stock: number; sku: string } };
  unitPrice: number;
  canDiscount: boolean;
  canEditPrice: boolean;
  onAskUnlock: () => void;
  onQty: (q: number) => void;
  onDisc: (d: number) => void;
  onPrice: (p: number | undefined) => void;
  onRemove: () => void;
}) {
  const [editingQty, setEditingQty] = useState(false);
  const [qtyVal, setQtyVal] = useState(String(line.qty));
  const [discOpen, setDiscOpen] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceVal, setPriceVal] = useState('');

  const overridden = line.price !== undefined && line.price !== line.product.price;
  const gross = unitPrice * line.qty;
  const net = gross - (line.discount || 0);
  const atMax = line.qty >= line.product.stock;

  const commitQty = () => {
    const q = Math.round(parseFloat(qtyVal) || 0);
    onQty(q);
    setEditingQty(false);
  };
  const startPriceEdit = () => {
    if (!canEditPrice) { onAskUnlock(); return; }
    setPriceVal(String(unitPrice));
    setEditingPrice(true);
  };
  const commitPrice = () => {
    const v = parseFloat(priceVal);
    if (!isNaN(v) && v >= 0) onPrice(v === line.product.price ? undefined : v);
    setEditingPrice(false);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}
      className="px-5 sm:px-6 py-3 border-b border-line/70"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-ink truncate flex items-center gap-1.5">
            {line.product.name}
            {overridden && <Badge tone="violet" className="!text-[8.5px] !px-1.5 !py-0">PRICE EDIT</Badge>}
          </div>
          <div className="text-[10.5px] num flex items-center gap-1.5 mt-0.5 flex-wrap">
            {editingPrice ? (
              <span className="flex items-center gap-1">
                Rs.
                <input
                  className="w-20 text-[11px] num bg-surface border border-violet-400 rounded-md px-1.5 py-0.5 outline-none"
                  value={priceVal}
                  autoFocus
                  inputMode="decimal"
                  onChange={e => setPriceVal(e.target.value.replace(/[^\d.]/g, ''))}
                  onBlur={commitPrice}
                  onKeyDown={e => { if (e.key === 'Enter') commitPrice(); if (e.key === 'Escape') setEditingPrice(false); }}
                />
                <span className="text-faint">each</span>
              </span>
            ) : (
              <button
                className="text-faint hover:text-violet-500 inline-flex items-center gap-1 transition-colors"
                title={canEditPrice ? 'Click to edit unit price' : 'Price edit needs admin password'}
                onClick={startPriceEdit}
              >
                {fmtRs(unitPrice, false)} each
                {overridden && <span className="text-faint/70 line-through">{fmtRs(line.product.price, false)}</span>}
                {canEditPrice ? <Pencil size={9} /> : <Lock size={9} className="text-amber-500" />}
              </button>
            )}
            {atMax && <span className="text-rose-500 font-extrabold">· Only {line.product.stock} in stock!</span>}
          </div>
        </div>

        {/* qty stepper with click-to-edit */}
        <div className="flex items-center gap-1 bg-raised rounded-lg p-0.5 border border-line shrink-0">
          <button className="w-6 h-6 rounded-md flex items-center justify-center text-sub hover:bg-surface hover:text-ink" onClick={() => onQty(line.qty - 1)}>
            <Minus size={12} />
          </button>
          {editingQty ? (
            <input
              className="w-10 text-center text-[13px] font-bold num bg-surface border border-violet-400 rounded-md outline-none py-0.5"
              value={qtyVal}
              autoFocus
              inputMode="numeric"
              onChange={e => setQtyVal(e.target.value.replace(/\D/g, ''))}
              onBlur={commitQty}
              onKeyDown={e => { if (e.key === 'Enter') commitQty(); if (e.key === 'Escape') setEditingQty(false); }}
            />
          ) : (
            <button
              className="w-7 text-center text-[13px] font-bold num hover:bg-surface rounded-md py-0.5"
              title="Click to type quantity"
              onClick={() => { setQtyVal(String(line.qty)); setEditingQty(true); }}
            >
              {line.qty}
            </button>
          )}
          <button className="w-6 h-6 rounded-md flex items-center justify-center text-sub hover:bg-surface hover:text-ink" onClick={() => onQty(line.qty + 1)} disabled={atMax}>
            <Plus size={12} />
          </button>
        </div>

        <div className="w-[104px] shrink-0">
          {canDiscount ? (
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-extrabold text-faint">Rs.</span>
              <input
                aria-label={`Discount in rupees for ${line.product.name}`}
                className={`input !w-full !h-9 !py-1 !pl-7 !pr-2 num !text-[12px] text-right !rounded-lg focus:!border-violet-500 focus:!ring-2 focus:!ring-violet-500/15 ${line.discount > 0 ? "!border-violet-400 !text-violet-600 font-extrabold !bg-violet-500/[0.04]" : ""}`}
                value={line.discount > 0 ? String(line.discount) : ""}
                placeholder="0"
                inputMode="decimal"
                type="text"
                autoComplete="off"
                onFocus={e => e.currentTarget.select()}
                onChange={e => {
                  const raw = e.target.value.replace(/[^\d.]/g, "");
                  const parts = raw.split(".");
                  const normalized = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : raw;
                  if (normalized === "" || normalized === ".") onDisc(0);
                  else {
                    const value = Number(normalized);
                    if (Number.isFinite(value)) onDisc(value);
                  }
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") { onDisc(0); e.currentTarget.blur(); }
                }}
                title="Item discount (Rs.) — click and type"
              />
            </div>
          ) : (
            <button
              type="button"
              className="w-full h-9 flex justify-end items-center gap-1 text-[10px] text-faint"
              title="Item discount needs permission"
              onClick={onAskUnlock}
            >
              <Lock size={10} className="text-amber-500" /> Locked
            </button>
          )}
        </div>
        <div className="w-[86px] text-right shrink-0">
          {(line.discount > 0 || overridden) && <div className="text-[10px] text-faint line-through num">{fmtRs(line.product.price * line.qty, false)}</div>}
          <div className="text-[13px] font-extrabold num text-ink">{fmtRs(net, false)}</div>
        </div>

        {/* Keep the Discount column directly editable so the value is visible in the cart row. */}
        <button className="icon-btn !w-7 !h-7 shrink-0 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={onRemove} title="Remove">
          <X size={13} />
        </button>
      </div>

      {line.discount > 0 && (
        <div className="mt-1 ml-auto w-fit text-[10px] font-semibold text-violet-500 num">Item discount − {fmtRs(line.discount, false)}</div>
      )}
    </motion.div>
  );
    }

