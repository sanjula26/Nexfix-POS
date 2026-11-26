import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, Plus, Pencil, Printer, Zap, Trash2, X, Search, PackageCheck } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, Field, Modal, PageHeading } from '../components/ui';
import { fmtDate, fmtRs } from '../lib/utils';
import { useBarcodeScanner } from '../lib/useBarcodeScanner';
import type { Purchase, PurchaseItem } from '../lib/types';
import { findDuplicateSupplierInvoices, getGrnBarcodeScanAction, validatePurchaseUnitIdentifiers } from '../lib/purchaseReconciliation';
import SearchableSelect from '../components/SearchableSelect';
import { idbDeleteMetaValue, idbGetMetaValue, idbPutMetaValue } from '../lib/db';
import { getCloudShopId } from '../lib/cloudSync';

interface Row { productId: string; qty: number; cost: number; sellingPrice: number; updateSellingPrice: boolean; unitText: string; }
interface BarcodeScanUndo { previousRows: Row[]; previousCount: number; productName: string; }
const emptyRow = (): Row => ({ productId: '', qty: 1, cost: 0, sellingPrice: 0, updateSellingPrice: false, unitText: '' });

interface GRNWorkingDraft {
  id: string;
  editingId: string | null;
  supplierId: string;
  invoiceNo: string;
  notes: string;
  rows: Row[];
  savedAt: string;
}
const GRN_WORKING_DRAFT_KEY = 'grn_working_draft_v1';
const createDraftId = () => globalThis.crypto?.randomUUID?.() || `grn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function grnPrintHtml(grn: Purchase, shopName: string) {
  // GRN names, supplier details and notes are user-controlled. Escape every
  // text value before embedding it in the printable HTML document.
  const rows = grn.items.map(i => `<tr><td>${escapeHtml(i.name)}</td><td class="num">${escapeHtml(i.qty)}</td><td class="num">${escapeHtml(fmtRs(i.cost))}</td><td class="num">${escapeHtml(fmtRs(i.qty * i.cost))}</td></tr>`).join('');
  const invoice = grn.supplierInvoiceNo ? `<p><b>Supplier Invoice:</b> ${escapeHtml(grn.supplierInvoiceNo)}</p>` : '';
  const notes = grn.notes ? `<div class="notes"><b>Notes</b><p>${escapeHtml(grn.notes)}</p></div>` : '';
  return `<!doctype html><html><head><title>${escapeHtml(grn.poNo)}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0;font-size:12px}.head{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}.head h1{margin:0;font-size:24px}.meta{text-align:right}.meta h2{margin:0 0 6px;font-size:20px}p{margin:5px 0;color:#555}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #ddd;padding:9px;text-align:left}th{background:#f3f4f6}.num{text-align:right}.total{margin-left:auto;width:280px;text-align:right;font-size:18px;font-weight:700;border-top:2px solid #111;padding-top:9px;margin-top:18px}.notes{margin-top:24px;white-space:pre-line}@media print{button{display:none}}</style></head><body><div class="head"><div><h1>${escapeHtml(shopName)}</h1><p>Goods Received Note</p></div><div class="meta"><h2>${escapeHtml(grn.poNo)}</h2><div>${escapeHtml(fmtDate(grn.date))}</div><div>Status: <b>${grn.status === 'received' ? 'PROCESSED' : 'DRAFT'}</b></div></div></div><p><b>Supplier:</b> ${escapeHtml(grn.supplierName)}</p>${invoice}<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total: ${escapeHtml(fmtRs(grn.total))}</div>${notes}</body></html>`;
}

export default function GRN() {
  const { state, user, saveGRNDraft, updateGRNDraft, processGRN, deletePurchase, createPurchaseReturn, can } = usePOS();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [receivedForTags, setReceivedForTags] = useState<Array<{ productId: string; qty: number }>>([]);
  const [printPreview, setPrintPreview] = useState<{ grn: Purchase; html: string } | null>(null);
  const [selectedGrn, setSelectedGrn] = useState<Purchase | null>(null);
  const [printReady, setPrintReady] = useState(false);
  const printFrame = useRef<HTMLIFrameElement | null>(null);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [barcodeScanCount, setBarcodeScanCount] = useState(0);
  const [lastBarcodeUndo, setLastBarcodeUndo] = useState<BarcodeScanUndo | null>(null);
  const [search, setSearch] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [priceChanges, setPriceChanges] = useState<Array<{ name: string; old: number; next: number }>>([]);
  const [returnPurchase, setReturnPurchase] = useState<Purchase | null>(null);
  const [returnLines, setReturnLines] = useState<Array<{ itemIdx: number; maxQty: number; qty: number; unitIds: string[] }>>([]);
  const [returnReason, setReturnReason] = useState('');
  const [formMode, setFormMode] = useState<'receive' | 'return'>('receive');
  const [returnGrnId, setReturnGrnId] = useState('');
  const [formError, setFormError] = useState('');
  const [actionRunning, setActionRunning] = useState(false);
  const [invoiceWarning, setInvoiceWarning] = useState(false);
  const [invoiceOverrideReason, setInvoiceOverrideReason] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const workingDraftKey = `${GRN_WORKING_DRAFT_KEY}:${encodeURIComponent(getCloudShopId() || state.settings.shopName.trim().toLowerCase() || 'local-shop')}:${encodeURIComponent(state.settings.branchId || 'local')}`;
  const [workingDraft, setWorkingDraft] = useState<GRNWorkingDraft | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [recoveryLoadError, setRecoveryLoadError] = useState('');
  const [recoveryRetry, setRecoveryRetry] = useState(0);
  const [draftSaveStatus, setDraftSaveStatus] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [confirmWorkingDraftDiscard, setConfirmWorkingDraftDiscard] = useState(false);
  const draftIdRef = useRef('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSequenceRef = useRef(0);
  const latestWorkingDraftRef = useRef<GRNWorkingDraft | null>(null);
  const latestWorkingDraftKeyRef = useRef(workingDraftKey);
  latestWorkingDraftKeyRef.current = workingDraftKey;
  const isReceivingFormRef = useRef(false);
  const drafts = state.purchases.filter(p => p.status === 'pending');
  const processed = state.purchases.filter(p => p.status === 'received');
  const q = search.trim().toLowerCase();
  const duplicateInvoiceMatches = formMode === 'receive'
    ? findDuplicateSupplierInvoices(supplierId, invoiceNo, state.purchases, editingId || undefined)
    : [];
  const confirmPurchase = confirmId ? state.purchases.find(p => p.id === confirmId) : undefined;
  const confirmInvoiceDuplicates = confirmPurchase
    ? findDuplicateSupplierInvoices(confirmPurchase.supplierId, confirmPurchase.supplierInvoiceNo || '', state.purchases, confirmPurchase.id)
    : [];
  const canOverrideInvoiceDuplicate = user?.role === 'admin' || user?.role === 'manager';

  useEffect(() => {
    let cancelled = false;
    setWorkingDraft(null);
    setRecoveryLoaded(false);
    setRecoveryLoadError('');
    setDraftSaveStatus('loading');
    void idbGetMetaValue<GRNWorkingDraft>(workingDraftKey).then(saved => {
      if (cancelled) return;
      if (saved && typeof saved.id === 'string' && Array.isArray(saved.rows)) {
        setWorkingDraft(saved);
        setDraftSaveStatus('saved');
      } else {
        setDraftSaveStatus('saved');
      }
      setRecoveryLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setWorkingDraft(null);
      setDraftSaveStatus('error');
      setRecoveryLoadError('Could not check unfinished GRN recovery data in local storage. Retry this check before creating or editing a GRN.');
    });
    return () => { cancelled = true; };
  }, [workingDraftKey, recoveryRetry]);
  useBarcodeScanner(code => {
    const match = state.products.find(p => p.barcode.trim().toLowerCase() === code.trim().toLowerCase());
    if (!match || actionRunning || formMode !== 'receive' || view !== 'form') return;
    const action = getGrnBarcodeScanAction(rows, match.id);
    setLastBarcodeUndo({
      previousRows: rows.map(row => ({ ...row })),
      previousCount: barcodeScanCount,
      productName: match.name,
    });
    setBarcodeScanCount(count => count + 1);
    if (action.type === 'increment') {
      const currentQty = rows[action.index]?.qty;
      const nextQty = Number.isFinite(currentQty) ? Math.max(0, Math.floor(currentQty)) + 1 : 1;
      setRow(action.index, { qty: nextQty }, 'barcode');
      return;
    }
    if (action.type === 'fill') {
      setRow(action.index, { productId: match.id }, 'barcode');
      return;
    }
    setRows(previous => [...previous, { ...emptyRow(), productId: match.id, cost: match.cost, sellingPrice: match.price }]);
  }, { enabled: view === 'form' && formMode === 'receive' && !actionRunning, force: true, minLength: 3 });
  const list = state.purchases.filter(p => !q || p.poNo.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q) || (p.supplierInvoiceNo || '').toLowerCase().includes(q)).sort((a, b) => +new Date(b.date) - +new Date(a.date));

  // A GRN opened from the report carries its exact purchase ID in the URL.
  // Wait for IndexedDB hydration before resolving it so history opens reliably.
  const requestedGrnId = searchParams.get('grn');
  useEffect(() => {
    if (!requestedGrnId) return;
    const match = state.purchases.find(p => p.id === requestedGrnId);
    if (!match) return;
    setSearch(match.poNo);
    setSelectedGrn(match);
    navigate('/grn', { replace: true });
  }, [requestedGrnId, state.purchases, navigate]);

  const findGrn = () => {
    const term = search.trim().toLowerCase();
    if (!term) { setLookupError('Enter a GRN number to find its saved record.'); return; }
    const match = state.purchases.find(p => p.poNo.trim().toLowerCase() === term);
    if (!match) { setLookupError('No saved GRN matches that number. Check the GRN number and try again.'); return; }
    setLookupError('');
    setSelectedGrn(match);
  };

  const setRow = (index: number, patch: Partial<Row>, source: 'manual' | 'barcode' = 'manual') => {
    if (source !== 'barcode') setLastBarcodeUndo(null);
    setRows(prev => prev.map((r, i) => {
      if (i !== index) return r;
      const next = { ...r, ...patch };
      if (patch.productId) {
        const p = state.products.find(x => x.id === patch.productId);
        if (p) { next.cost = p.cost; next.sellingPrice = p.price; next.unitText = ''; }
      }
      return next;
    }));
  };

  const undoLastBarcodeScan = () => {
    if (!lastBarcodeUndo || actionRunning) return;
    setRows(lastBarcodeUndo.previousRows.map(row => ({ ...row })));
    setBarcodeScanCount(lastBarcodeUndo.previousCount);
    setLastBarcodeUndo(null);
  };

  const makeWorkingDraft = useCallback((): GRNWorkingDraft => ({
    id: draftIdRef.current || createDraftId(),
    editingId,
    supplierId,
    invoiceNo,
    notes,
    rows: rows.map(row => ({ ...row })),
    savedAt: new Date().toISOString(),
  }), [editingId, supplierId, invoiceNo, notes, rows]);

  latestWorkingDraftRef.current = makeWorkingDraft();
  isReceivingFormRef.current = view === 'form' && formMode === 'receive';

  const persistWorkingDraft = useCallback(async (): Promise<boolean> => {
    if (formMode !== 'receive') return true;
    if (!recoveryLoaded || recoveryLoadError) {
      setDraftSaveStatus('error');
      setFormError(recoveryLoadError || 'Local GRN recovery check is not complete. Retry the check before saving this draft.');
      return false;
    }
    const snapshot = makeWorkingDraft();
    draftIdRef.current = snapshot.id;
    setDraftSaveStatus('saving');
    const ok = await idbPutMetaValue(workingDraftKey, snapshot);
    if (!ok) {
      setDraftSaveStatus('error');
      setFormError('Local draft save failed. Check available storage and retry before leaving this GRN.');
      return false;
    }
    setWorkingDraft(snapshot);
    setDraftSaveStatus('saved');
    return true;
  }, [formMode, makeWorkingDraft, workingDraftKey, recoveryLoaded, recoveryLoadError]);

  const closeForm = async () => {
    if (actionRunning) return;
    if (formMode === 'receive') {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveSequenceRef.current += 1;
      const saved = await persistWorkingDraft();
      if (!saved) return;
    }
    setView('list');
  };

  const resumeWorkingDraft = () => {
    if (!workingDraft) return;
    if (workingDraft.editingId) {
      const existing = state.purchases.find(p => p.id === workingDraft.editingId);
      if (!existing || existing.status !== 'pending') {
        setFormError('The GRN being edited is no longer a pending draft. Save or discard this recovery copy before continuing.');
        return;
      }
    }
    draftIdRef.current = workingDraft.id;
    setEditingId(workingDraft.editingId);
    setSupplierId(workingDraft.supplierId);
    setInvoiceNo(workingDraft.invoiceNo);
    setNotes(workingDraft.notes);
    setRows(workingDraft.rows.length ? workingDraft.rows.map(row => ({ ...row })) : [emptyRow()]);
    setBarcodeScanCount(0);
    setLastBarcodeUndo(null);
    setFormMode('receive');
    setFormError('');
    setView('form');
  };

  const discardWorkingDraft = async () => {
    const ok = await idbDeleteMetaValue(workingDraftKey);
    if (!ok) {
      setFormError('Could not delete the unfinished local draft. Please retry.');
      return;
    }
    setWorkingDraft(null);
    setConfirmWorkingDraftDiscard(false);
    setDraftSaveStatus('saved');
    draftIdRef.current = '';
  };

  const startNew = () => {
    if (workingDraft || !recoveryLoaded || recoveryLoadError) return;
    draftIdRef.current = createDraftId();
    setFormError(''); setHighlightedId(null); setInvoiceWarning(false); setInvoiceOverrideReason(''); setEditingId(null); setSupplierId(''); setInvoiceNo(''); setNotes(''); setRows([emptyRow()]); setBarcodeScanCount(0); setLastBarcodeUndo(null); setFormMode('receive'); setReturnGrnId(''); setReturnPurchase(null); setReturnLines([]); setReturnReason(''); setView('form');
  };
  const openReturn = (p: Purchase) => {
    const returnedByItem = new Map<number, number>();
    for (const ret of state.purchaseReturns || []) if (ret.purchaseId === p.id) for (const item of ret.items) returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
    setReturnPurchase(p); setReturnReason('');
    setReturnLines(p.items.map((item, itemIdx) => {
      const already = returnedByItem.get(itemIdx) || 0;
      const product = state.products.find(x => x.id === item.productId);
      const stock = Math.max(0, product?.stock ?? 0);
      const tracked = Array.isArray(item.unitIdentifiers) && item.unitIdentifiers.length > 0;
      const unitStock = tracked
        ? (state.units || []).filter(u => u.productId === item.productId && u.purchaseId === p.id && u.status === 'in_stock').length
        : Number.MAX_SAFE_INTEGER;
      const remaining = Math.max(0, item.qty - already);
      return { itemIdx, maxQty: Math.min(remaining, stock, unitStock), qty: 0, unitIds: [] };
    }));
  };
  const edit = (p: Purchase) => { if (workingDraft || !recoveryLoaded || recoveryLoadError) return; draftIdRef.current = createDraftId(); setFormError(''); setEditingId(p.id); setSupplierId(p.supplierId); setInvoiceNo(p.supplierInvoiceNo || ''); setNotes(p.notes || ''); setRows(p.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice, unitText: (i.unitIdentifiers || []).map(u => [u.imei, u.serial].filter(Boolean).join(',')).join('\n') }))); setBarcodeScanCount(0); setLastBarcodeUndo(null); setFormMode('receive'); setView('form'); };

  useEffect(() => {
    if (!recoveryLoaded || view !== 'form' || formMode !== 'receive') return;
    const sequence = ++saveSequenceRef.current;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setDraftSaveStatus('saving');
    saveTimerRef.current = setTimeout(() => {
      const snapshot = makeWorkingDraft();
      draftIdRef.current = snapshot.id;
      void idbPutMetaValue(workingDraftKey, snapshot).then(ok => {
        if (sequence !== saveSequenceRef.current) return;
        if (ok) {
          setWorkingDraft(snapshot);
          setDraftSaveStatus('saved');
        } else {
          setDraftSaveStatus('error');
          setFormError('Auto-save failed. Check local storage space and use Retry before leaving this GRN.');
        }
      });
    }, 450);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [recoveryLoaded, view, formMode, makeWorkingDraft, workingDraftKey]);

  // Best-effort final checkpoint when the user navigates to another page or closes the window.
  // The debounced transaction remains the primary save path; this cleanup is an extra safeguard.
  useEffect(() => () => {
    const snapshot = latestWorkingDraftRef.current;
    if (isReceivingFormRef.current && snapshot) {
      void idbPutMetaValue(latestWorkingDraftKeyRef.current, { ...snapshot, savedAt: new Date().toISOString() });
    }
  }, []);

  const buildItems = (): PurchaseItem[] => rows.filter(r => r.productId).map(r => {
    const product = state.products.find(p => p.id === r.productId);
    const qty = Number(r.qty);
    const rawLines = r.unitText.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const unitIdentifiers = (product?.trackImei || product?.trackSerial)
      ? rawLines.map(line => {
          const parts = line.split(',').map(x => x.trim());
          if (product.trackImei && product.trackSerial) return { imei: parts[0] || '', serial: parts.slice(1).join(',').trim() };
          if (product.trackImei) return { imei: parts[0] || '' };
          return { serial: parts[0] || '' };
        })
      : undefined;
    return { productId: r.productId, name: product?.name || '', qty, cost: Number(r.cost), sellingPrice: Number(r.sellingPrice), updateSellingPrice: r.updateSellingPrice, ...(unitIdentifiers ? { unitIdentifiers } : {}) };
  });

  const validateForm = (items: PurchaseItem[]) => {
    if (!state.suppliers.some(s => s.id === supplierId)) return 'Select a supplier.';
    if (!items.length) return 'Add at least one valid product line.';
    for (const item of items) {
      if (!Number.isInteger(item.qty) || item.qty <= 0) return item.name + ': quantity must be a positive whole number.';
      if (!Number.isFinite(item.cost) || item.cost < 0) return item.name + ': cost cannot be negative.';
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.productId)) return 'Each product can appear only once per GRN.';
      seen.add(item.productId);
      const product = state.products.find(p => p.id === item.productId);
      if (product?.trackImei || product?.trackSerial) {
        const ids = item.unitIdentifiers || [];
        if (ids.length !== item.qty) return product.trackImei && product.trackSerial ? `${item.name}: enter one IMEI and Serial pair for every unit.` : product.trackImei ? `${item.name}: enter one IMEI for every unit.` : `${item.name}: enter one Serial number for every unit.`;
        if (ids.some(u => (product.trackImei && !u.imei?.trim()) || (product.trackSerial && !u.serial?.trim()))) return `${item.name}: every tracked unit must have the required identifier.`;
        const identifierKeys = ids.map(u => [u.imei, u.serial].filter(Boolean).map(v => String(v).trim().toLowerCase()).join('|'));
        if (new Set(identifierKeys).size !== identifierKeys.length) return `${item.name}: duplicate IMEI/Serial values were pasted in this line set.`;
      }
    }
    const validationPurchase: Purchase = { id: 'validation', poNo: 'GRN-VALIDATION', date: new Date().toISOString(), supplierId, supplierName: state.suppliers.find(s => s.id === supplierId)?.name || '', items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0), status: 'pending' };
    const result = validatePurchaseUnitIdentifiers(validationPurchase, state.products, state.units || [], state.purchases.filter(p => p.id !== editingId));
    if (!result.ok) return result.error || 'IMEI/Serial validation failed.';
    return '';
  };

  const saveDraft = async () => {
    if (actionRunning) return;
    if (!recoveryLoaded || recoveryLoadError) {
      setFormError(recoveryLoadError || 'Local GRN recovery check is not complete. Retry before saving.');
      return;
    }
    const supplier = state.suppliers.find(s => s.id === supplierId);
    const items = buildItems();
    const error = validateForm(items);
    if (error) { setFormError(error); return; }
    if (!supplier) return;
    setActionRunning(true);
    setFormError('');
    try {
      const payload = { supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) };
      let savedId = editingId;
      if (editingId) {
        const result = updateGRNDraft(editingId, payload);
        if (!result.ok) { setFormError(result.error || 'Unable to update this GRN draft.'); return; }
        setHighlightedId(editingId);
      } else {
        const result = saveGRNDraft(payload);
        if (!result.ok || !result.purchase) { setFormError(result.error || 'Unable to save this GRN draft.'); return; }
        savedId = result.purchase.id;
        setHighlightedId(result.purchase.id);
      }
      if (savedId) setEditingId(savedId);
      const cleared = await idbDeleteMetaValue(workingDraftKey);
      if (cleared) {
        setWorkingDraft(null);
        draftIdRef.current = '';
      } else if (savedId) {
        const recoveryCopy = { ...makeWorkingDraft(), editingId: savedId };
        const preserved = await idbPutMetaValue(workingDraftKey, recoveryCopy);
        if (preserved) setWorkingDraft(recoveryCopy);
        setDraftSaveStatus('error');
        setFormError('The GRN was saved, but its temporary recovery copy could not be cleared. Use Discard on the recovery banner after confirming the saved GRN.');
      }
      setView('list');
    } finally {
      setActionRunning(false);
    }
  };

  const askProcess = () => {
    if (actionRunning) return;
    if (!recoveryLoaded || recoveryLoadError) {
      setFormError(recoveryLoadError || 'Local GRN recovery check is not complete. Retry before processing stock.');
      return;
    }
    const supplier = state.suppliers.find(s => s.id === supplierId);
    const items = buildItems();
    const error = validateForm(items);
    if (error) { setFormError(error); return; }
    if (!supplier) return;
    setFormError('');
    const conflicts = items.map(i => { const p = state.products.find(x => x.id === i.productId); return p && i.updateSellingPrice && i.sellingPrice !== p.price ? { name: p.name, old: p.price, next: i.sellingPrice || p.price } : null; }).filter(Boolean) as Array<{ name: string; old: number; next: number }>;
    setPriceChanges(conflicts);
    setActionRunning(true);
    setFormError('');
    try {
      const payload = { supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) };
      if (editingId) {
        const result = updateGRNDraft(editingId, payload);
        if (!result.ok) { setFormError(result.error || 'Unable to update this GRN draft.'); return; }
        setInvoiceOverrideReason('');
        setConfirmId(editingId);
      } else {
        const result = saveGRNDraft(payload);
        if (!result.ok || !result.purchase) { setFormError(result.error || 'Unable to save this GRN draft.'); return; }
        setEditingId(result.purchase.id);
        setInvoiceOverrideReason('');
        setConfirmId(result.purchase.id);
      }
    } finally {
      setActionRunning(false);
    }
  };

  const process = async () => {
    if (!confirmId || actionRunning) return;
    if (!recoveryLoaded || recoveryLoadError) {
      setFormError(recoveryLoadError || 'Local GRN recovery check is not complete. Retry before processing stock.');
      setConfirmId(null);
      setPriceChanges([]);
      return;
    }
    const purchase = state.purchases.find(p => p.id === confirmId);
    if (!purchase || purchase.status !== 'pending') {
      setConfirmId(null); setPriceChanges([]);
      setFormError('This GRN is no longer available as a pending draft. Refresh the page and try again.');
      return;
    }
    const unitValidation = validatePurchaseUnitIdentifiers(purchase, state.products, state.units || [], state.purchases);
    if (!unitValidation.ok) {
      setConfirmId(null); setPriceChanges([]); setEditingId(purchase.id); setSupplierId(purchase.supplierId); setInvoiceNo(purchase.supplierInvoiceNo || ''); setNotes(purchase.notes || '');
      setRows(purchase.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice, unitText: (i.unitIdentifiers || []).map(u => [u.imei, u.serial].filter(Boolean).join(',')).join('\n') })));
      setBarcodeScanCount(0);
      setLastBarcodeUndo(null);
      setFormMode('receive'); setFormError(unitValidation.error || 'The GRN changed after the confirmation opened. Correct its IMEI/Serial data before processing.'); setView('form');
      return;
    }
    setActionRunning(true);
    try {
      const result = await processGRN(confirmId, user?.name || 'Unknown', invoiceOverrideReason.trim());
      if (!result.ok) {
        setFormError(result.error || 'Unable to process this GRN. No stock was changed.');
        setConfirmId(null); setPriceChanges([]);
        setView('form');
        return;
      }
      const clearedRecovery = await idbDeleteMetaValue(workingDraftKey);
      if (clearedRecovery) {
        setWorkingDraft(null);
        draftIdRef.current = '';
      } else {
        const staleRecovery = { ...makeWorkingDraft(), editingId: confirmId };
        if (await idbPutMetaValue(workingDraftKey, staleRecovery)) setWorkingDraft(staleRecovery);
        setDraftSaveStatus('error');
      }
      setReceivedForTags(purchase.items.map(item => ({ productId: item.productId, qty: Math.max(1, Math.floor(item.qty || 1)) })));
      setConfirmId(null); setPriceChanges([]);
      setFormError(''); setView('list');
    } finally {
      setActionRunning(false);
    }
  };

  return (
    <div>
      <PageHeading
        chip="Procurement"
        chipTone="blue"
        title="Goods Received Notes"
        sub={processed.length + ' processed · ' + drafts.length + ' drafts'}
        actions={<button className="btn btn-primary" onClick={startNew} disabled={!!workingDraft || !recoveryLoaded || !!recoveryLoadError}><Plus size={15} /> New GRN</button>}
      />

      {recoveryLoadError && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/[0.05] p-4 mb-5">
          <p className="text-sm font-semibold text-rose-600">Local GRN recovery check failed</p>
          <p className="text-sm text-sub mt-1">{recoveryLoadError} Existing saved work will not be replaced.</p>
          <button className="btn btn-soft mt-3" onClick={() => { setDraftSaveStatus('loading'); setRecoveryLoadError(''); setRecoveryRetry(value => value + 1); }}>
            Retry local recovery check
          </button>
        </div>
      )}

      {receivedForTags.length > 0 && <div className="card p-4 mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border border-emerald-500/30 bg-emerald-500/[0.05]"><div><div className="font-bold text-ink">GRN processed successfully</div><div className="text-sm text-sub mt-1">Print product price labels for {receivedForTags.length} received product line(s). Received quantities will be preselected as label copies.</div></div>{can('page:pricetags') && <button className="btn btn-primary" onClick={() => { try { sessionStorage.setItem('nexfix_grn_price_tags_v1', JSON.stringify({ items: receivedForTags })); } catch { setFormError('Could not prepare the price-tag selection. Open Price Tags and select products manually.'); return; } navigate('/price-tags'); }}><Printer size={15}/> Print price tags for these items</button>}</div>}

      <div className="card p-4 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl bg-raised border border-line p-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-faint">Processed GRNs</div>
            <div className="num text-xl font-extrabold mt-1">{processed.length}</div>
          </div>
          <div className="rounded-xl bg-raised border border-line p-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-faint">Draft GRNs</div>
            <div className="num text-xl font-extrabold mt-1">{drafts.length}</div>
          </div>
          <div className="rounded-xl bg-raised border border-line p-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-faint">Received value</div>
            <div className="num text-xl font-extrabold mt-1">{fmtRs(processed.reduce((s, p) => s + p.total, 0))}</div>
          </div>
        </div>
      </div>

      {view === 'list' && workingDraft && (
        <div className="card p-4 mb-5 border border-amber-500/30 bg-amber-500/[0.05]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-bold text-ink">Unfinished GRN recovered</div>
              <div className="text-sm text-sub mt-1">Your previous work was saved locally on this PC at {fmtDate(workingDraft.savedAt)}. Continue from the saved fields and rows. Stock has not been changed.</div>
              {draftSaveStatus === 'error' && <div className="text-xs text-rose-600 mt-1">The recovery copy needs attention. Confirm the saved GRN before discarding this temporary copy.</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={resumeWorkingDraft}><Pencil size={14}/> Continue GRN</button>
              <button className="btn btn-soft" onClick={() => setConfirmWorkingDraftDiscard(true)}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {view === 'form' ? (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="font-bold text-ink">{editingId ? 'Edit GRN draft' : formMode === 'return' ? 'New Supplier Return' : 'New GRN'}</h2>
              <p className="text-xs text-sub mt-1">
                {formMode === 'return' ? 'Return received items to the supplier and deduct stock automatically.' : 'Stock is updated only when the GRN is processed.'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {formMode === 'receive' && <span className="text-xs text-sub" role="status">{draftSaveStatus === 'saving' ? 'Saving locally…' : draftSaveStatus === 'error' ? 'Save failed — retry required' : workingDraft?.savedAt ? 'Saved locally · ' + new Date(workingDraft.savedAt).toLocaleTimeString() : 'Saved locally'}</span>}
              {formMode === 'receive' && draftSaveStatus === 'error' && <button className="btn btn-soft !py-1.5 !px-2.5 !text-xs" onClick={() => void persistWorkingDraft()}>Retry save</button>}
              <button className="btn btn-soft" onClick={() => void closeForm()} disabled={actionRunning}><X size={14} /> Save & Close</button>
            </div>
          </div>

          {!editingId && (
            <div className="flex gap-2 p-1 rounded-xl bg-raised border border-line mb-5">
              <button className={`flex-1 btn ${formMode === 'receive' ? 'btn-primary' : 'btn-soft'}`} onClick={() => { setFormError(''); setFormMode('receive'); }} disabled={actionRunning}>
                <PackageCheck size={14} /> Receive Stock
              </button>
              <button className={`flex-1 btn ${formMode === 'return' ? 'bg-rose-600 text-white' : 'btn-soft'}`} onClick={() => { setFormError(''); setFormMode('return'); setReturnPurchase(null); setReturnLines([]); setReturnReason(''); setReturnGrnId(''); }} disabled={actionRunning}>
                <Trash2 size={14} /> Return to Supplier
              </button>
            </div>
          )}

          {formError && formMode === 'return' && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-600 mb-4">{formError}</div>
          )}

          {formMode === 'return' ? (
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Processed GRN to return from">
                <select
                  className="input"
                  value={returnGrnId}
                  onChange={e => {
                    const id = e.target.value;
                    setReturnGrnId(id);
                    const p = processed.find(x => x.id === id);
                    if (p) openReturn(p);
                    else { setReturnPurchase(null); setReturnLines([]); }
                  }}
                  disabled={actionRunning}
                >
                  <option value="">Select processed GRN...</option>
                  {processed.map(p => <option key={p.id} value={p.id}>{p.poNo} · {p.supplierName} · {fmtDate(p.date)}</option>)}
                </select>
              </Field>
              <Field label="Return reason *">
                <select className="input" value={returnReason} onChange={e => setReturnReason(e.target.value)} disabled={actionRunning}>
                  <option value="">Select reason...</option>
                  <option>Defective / Damaged</option>
                  <option>Wrong item received</option>
                  <option>Excess quantity</option>
                  <option>Quality issue</option>
                  <option>Price dispute</option>
                  <option>Other</option>
                </select>
              </Field>

              {!returnPurchase && (
                <div className="md:col-span-2 rounded-xl border border-dashed border-line bg-raised p-8 text-center">
                  <Trash2 size={24} className="mx-auto text-faint mb-2" />
                  <div className="font-semibold text-ink">Select a processed GRN</div>
                  <div className="text-xs text-sub mt-1">Choose a processed GRN above to see remaining returnable quantities and the debit amount.</div>
                </div>
              )}

              {returnPurchase && (
                <div className="md:col-span-2 mt-5 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-sub mb-2">Items to return</div>
                  {returnPurchase.items.map((item, itemIdx) => {
                    const tracked = Array.isArray(item.unitIdentifiers) && item.unitIdentifiers.length > 0;
                    const availableUnits = tracked
                      ? (state.units || []).filter(u => u.productId === item.productId && u.purchaseId === returnPurchase.id && u.status === 'in_stock')
                      : [];
                    const line = returnLines.find(x => x.itemIdx === itemIdx) || { itemIdx, maxQty: 0, qty: 0, unitIds: [] };
                    return (
                      <div key={itemIdx} className="rounded-xl border border-line bg-surface p-3">
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-ink truncate">{item.name}</div>
                            <div className="text-xs text-sub">Received: {item.qty} · Available: {line.maxQty} · Cost: {fmtRs(item.cost)}</div>
                          </div>
                          {!tracked && (
                            <input
                              className="input num !w-24 text-center"
                              type="number"
                              min="0"
                              max={line.maxQty}
                              value={line.qty || ''}
                              placeholder="Qty"
                              onChange={e => {
                                const qty = Math.max(0, Math.min(line.maxQty, Math.floor(Number(e.target.value) || 0)));
                                setReturnLines(ls => ls.map(x => x.itemIdx === itemIdx ? { ...x, qty } : x));
                              }}
                              disabled={actionRunning}
                            />
                          )}
                          <div className="num w-24 text-right font-bold text-rose-600">{line.qty ? fmtRs(line.qty * item.cost) : '—'}</div>
                        </div>
                        {tracked && (
                          <div className="mt-3 rounded-lg border border-line bg-raised p-3">
                            <div className="text-[10px] uppercase font-bold tracking-wider text-faint mb-2">Select units to return</div>
                            {availableUnits.length === 0 ? (
                              <div className="text-xs text-faint">No in-stock tracked units are available for return.</div>
                            ) : (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {availableUnits.map(unit => {
                                  const selected = line.unitIds.includes(unit.id);
                                  const label = [unit.imei, unit.serial].filter(Boolean).join(' · ') || unit.id;
                                  return (
                                    <label key={unit.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer ${selected ? 'border-rose-400 bg-rose-50 dark:bg-rose-900/20' : 'border-line bg-surface'}`}>
                                      <input
                                        type="checkbox"
                                        checked={selected}
                                        onChange={() => {
                                          setReturnLines(ls => ls.map(x => {
                                            if (x.itemIdx !== itemIdx) return x;
                                            const nextIds = selected ? x.unitIds.filter(id => id !== unit.id) : [...x.unitIds, unit.id];
                                            return { ...x, unitIds: nextIds, qty: nextIds.length };
                                          }));
                                        }}
                                        disabled={actionRunning}
                                      />
                                      <span className="font-mono break-all">{label}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                            <div className="text-[11px] text-sub mt-2">Selected: {line.unitIds.length} / {line.maxQty}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 mt-4">
                    <span className="font-semibold text-sub">Debit amount</span>
                    <span className="num text-lg font-extrabold text-rose-600">
                      {fmtRs(returnLines.reduce((sum, line) => sum + line.qty * (returnPurchase.items[line.itemIdx]?.cost || 0), 0))}
                    </span>
                  </div>
                  <div className="flex justify-end mt-4">
                    <button
                      className="btn bg-rose-600 hover:bg-rose-700 text-white"
                      disabled={actionRunning || !returnReason.trim() || !returnLines.some(x => x.qty > 0)}
                      onClick={async () => {
                        if (actionRunning) return;
                        setActionRunning(true);
                        try {
                          const result = await createPurchaseReturn({
                            purchaseId: returnPurchase.id,
                            lines: returnLines.filter(x => x.qty > 0).map(x => ({ itemIdx: x.itemIdx, qty: x.qty, ...(x.unitIds.length ? { unitIds: x.unitIds } : {}) })),
                            reason: returnReason.trim(),
                          });
                          if (result) {
                            setReturnPurchase(null); setReturnLines([]); setReturnGrnId(''); setReturnReason(''); setFormError(''); setView('list');
                          } else {
                            setFormError('Unable to create the supplier return. Check the GRN status, available stock, purchase permissions, and cloud connection.');
                          }
                        } finally {
                          setActionRunning(false);
                        }
                      }}
                    >
                      <Trash2 size={14} /> Create return & deduct stock
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <Field label="Supplier">
                  <SearchableSelect value={supplierId} options={state.suppliers} onChange={setSupplierId} disabled={actionRunning} placeholder="Search supplier by name or phone…" ariaLabel="Supplier" clearable getLabel={s => s.name} getSearchText={s => [s.name,s.phone].filter(Boolean).join(' ')} renderOption={s => <><div className="font-semibold text-ink text-sm">{s.name}</div><div className="text-[11px] text-sub">{[s.phone,s.email].filter(Boolean).join(' · ')}</div></>} />
                </Field>
                <Field label="Supplier invoice number">
                  <input className={`input ${invoiceWarning ? 'border-amber-500/50' : ''}`} value={invoiceNo} onChange={e => { setInvoiceNo(e.target.value); setInvoiceWarning(false); }} placeholder="Supplier invoice / reference (recommended)" disabled={actionRunning} />
                  {invoiceWarning && <div className="text-xs text-amber-600 mt-1">Invoice number is empty. You can continue, but verify the supplier reference before processing.</div>}
                  {duplicateInvoiceMatches.length > 0 && (
                    <div role="alert" className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3 text-xs">
                      <div className="font-bold text-amber-700">Possible duplicate supplier invoice</div>
                      <div className="text-sub mt-1">This supplier and invoice number already appear on:</div>
                      <div className="mt-2 space-y-1">{duplicateInvoiceMatches.map(match => <div key={match.id}><b>{match.poNo}</b> · {match.status === 'received' ? 'Processed' : 'Draft'} · {fmtDate(match.date)}</div>)}</div>
                      <div className="text-sub mt-2">Saving a draft is allowed. Processing requires Admin/Manager approval and a reason.</div>
                    </div>
                  )}
                </Field>
                <Field label="Notes">
                  <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional receiving note" disabled={actionRunning} />
                </Field>
              </div>

              <div className="mt-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-sub">Items</span>
                    {barcodeScanCount > 0 && <span className="text-[11px] text-sub rounded-full bg-raised border border-line px-2 py-1">Scans this session: {barcodeScanCount}</span>}
                    {lastBarcodeUndo && <button className="btn btn-soft !text-xs" onClick={undoLastBarcodeScan} disabled={actionRunning}>Undo last scan · {lastBarcodeUndo.productName}</button>}
                  </div>
                  <button className="btn btn-soft !text-xs" onClick={() => { setLastBarcodeUndo(null); setRows(r => [...r, emptyRow()]); }} disabled={actionRunning}><Plus size={13} /> Add line</button>
                </div>
                <div className="space-y-3">
                  {rows.map((r, i) => {
                    const p = state.products.find(x => x.id === r.productId);
                    const tracked = !!(p?.trackImei || p?.trackSerial);
                    const sellBelowCost = r.updateSellingPrice && r.sellingPrice < r.cost;
                    return (
                      <div key={i} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
                        <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,1.6fr)_90px_120px_40px] gap-3 items-start">
                          <div><div className="text-[10px] uppercase font-bold tracking-wider text-faint mb-1">Product / SKU / Barcode</div><SearchableSelect value={r.productId} options={state.products.filter(p => p.active)} onChange={id => setRow(i, { productId: id })} disabled={actionRunning} placeholder="Search product, SKU or barcode…" ariaLabel="GRN product" clearable maxResults={40} getLabel={p => p.name} getSearchText={p => [p.name,p.sku,p.barcode,p.brand].filter(Boolean).join(' ')} renderOption={p => <><div className="font-semibold text-ink text-sm">{p.name}</div><div className="text-[11px] text-sub">{[p.sku,p.barcode,p.brand].filter(Boolean).join(' · ')}</div></>} /></div>
                          <div><div className="text-[10px] uppercase font-bold tracking-wider text-faint mb-1">Qty</div><input className="input num" type="number" min="1" step="1" value={r.qty || ''} onChange={e => setRow(i, { qty: e.target.value === '' ? 0 : Number(e.target.value) })} placeholder="Qty" disabled={actionRunning} /></div>
                          <div><div className="text-[10px] uppercase font-bold tracking-wider text-faint mb-1">Cost</div><input className="input num" type="number" min="0" step="0.01" value={Number.isFinite(r.cost) ? r.cost : ''} onChange={e => setRow(i, { cost: e.target.value === '' ? 0 : Number(e.target.value) })} placeholder="Cost" disabled={actionRunning} /></div>
                          <button className="icon-btn !w-9 !h-9 mt-5" disabled={actionRunning || rows.length === 1} onClick={() => { setLastBarcodeUndo(null); setRows(rs => rs.filter((_, idx) => idx !== i)); }} title="Remove line"><X size={14} /></button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                          <div className="rounded-lg border border-line bg-raised p-3">
                            <div className="text-[10px] uppercase font-bold tracking-wider text-faint mb-2">IMEI / Serial</div>
                            {tracked ? <textarea className="input min-h-24 text-xs" rows={4} value={r.unitText} onChange={e => setRow(i, { unitText: e.target.value })} placeholder={p?.trackImei && p?.trackSerial ? 'Paste one IMEI,SERIAL pair per line…' : p?.trackImei ? 'Paste one IMEI per line…' : 'Paste one Serial per line…'} disabled={actionRunning} /> : <div className="text-xs text-faint py-4">This product is not IMEI / Serial tracked.</div>}
                            {tracked && <div className="text-[11px] text-sub mt-1">Expected: {r.qty > 0 ? r.qty : 0} line{r.qty === 1 ? '' : 's'} · blank lines ignored · duplicates rejected</div>}
                          </div>
                          <div className="rounded-lg border border-line bg-raised p-3">
                            <label className="flex items-center gap-2 text-sm font-semibold text-sub"><input type="checkbox" checked={r.updateSellingPrice} onChange={e => setRow(i, { updateSellingPrice: e.target.checked })} disabled={actionRunning} /> Update sell price</label>
                            {r.updateSellingPrice && <input className="input num mt-3" type="number" min="0" step="0.01" value={r.sellingPrice || ''} onChange={e => setRow(i, { sellingPrice: e.target.value === '' ? 0 : Number(e.target.value) })} placeholder="Sell price" disabled={actionRunning} />}
                            {sellBelowCost && <div className="text-xs text-amber-600 mt-2">Sell price is below cost.</div>}
                            <div className="flex justify-between mt-4 text-xs text-sub"><span>Line total</span><span className="num font-bold text-ink">{fmtRs(Math.max(0, r.qty) * Math.max(0, r.cost))}</span></div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {formError && <div className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-600">{formError}</div>}

              <div className="flex items-center justify-between rounded-xl bg-violet-500/[0.06] border border-violet-500/15 px-4 py-3 mt-5">
                <span className="font-semibold text-sub">GRN Total</span>
                <span className="num text-lg font-extrabold text-violet-500">{fmtRs(rows.reduce((s, r) => s + Math.max(0, r.qty) * Math.max(0, r.cost), 0))}</span>
              </div>

              <div className="flex gap-2.5 mt-5">
                <button className="btn btn-primary flex-1" onClick={saveDraft} disabled={actionRunning}>
                  <ClipboardCheck size={15} /> {actionRunning ? 'Saving...' : 'Save draft'}
                </button>
                <button className="btn btn-outline-emerald flex-1" onClick={askProcess} disabled={actionRunning}>
                  <Zap size={15} /> {actionRunning ? 'Saving...' : 'Save & process'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-line">
            <div className="flex flex-col sm:flex-row gap-2 max-w-xl">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <input className="input pl-9" value={search} onChange={e => { setSearch(e.target.value); setLookupError(""); }} onKeyDown={e => { if (e.key === "Enter") findGrn(); }} placeholder="Search GRN, supplier or invoice..." />
              </div>
              <button type="button" className="btn btn-primary" onClick={findGrn} disabled={actionRunning}>Find GRN</button>
            </div>
            {lookupError && <p role="alert" className="text-xs text-rose-600 mt-2">{lookupError}</p>}
          </div>
          {list.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={26} />} title="No GRNs found" sub="Create a GRN draft to record incoming stock." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead><tr><th className="th">GRN / PO</th><th className="th">Date</th><th className="th">Supplier</th><th className="th">Invoice</th><th className="th">Items</th><th className="th">Status</th><th className="th !text-right">Total</th><th className="th !text-right">Actions</th></tr></thead>
                <tbody>
                  {list.map(p => (
                    <tr key={p.id} className={`hover:bg-raised/40 transition-colors ${highlightedId === p.id ? 'bg-emerald-500/[0.08] ring-1 ring-inset ring-emerald-500/20' : ''}`}>
                      <td className="td font-bold text-violet-500"><button type="button" className="underline underline-offset-2 hover:text-violet-700" onClick={() => setSelectedGrn(p)}>{p.poNo}</button></td>
                      <td className="td text-xs text-sub">{fmtDate(p.date)}</td>
                      <td className="td font-semibold">{p.supplierName}</td>
                      <td className="td text-xs text-sub">{p.supplierInvoiceNo || '—'}</td>
                      <td className="td text-xs text-sub">{p.items.map(i => i.name + ' ×' + i.qty).join(', ')}</td>
                      <td className="td"><Badge tone={p.status === 'received' ? 'emerald' : 'amber'}>{p.status === 'received' ? <PackageCheck size={11} /> : <ClipboardCheck size={11} />}{p.status === 'received' ? 'PROCESSED' : 'DRAFT'}</Badge></td>
                      <td className="td num font-bold text-right">{fmtRs(p.total)}</td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          {p.status === 'pending' && <button className="icon-btn !w-8 !h-8" title="Edit" onClick={() => edit(p)} disabled={actionRunning}><Pencil size={14} /></button>}
                          {can('act:export') && <button className="icon-btn !w-8 !h-8" title="Print" onClick={() => { setPrintReady(false); setPrintPreview({ grn: p, html: grnPrintHtml(p, state.settings.shopName) }); }} disabled={actionRunning}><Printer size={14} /></button>}
                          {p.status === 'pending' && (
                            <button
                              className="btn btn-outline-emerald !py-1.5 !px-2.5 !text-xs"
                              disabled={actionRunning}
                              onClick={() => {
                                const validation = validatePurchaseUnitIdentifiers(p, state.products, state.units || [], state.purchases);
                                if (!validation.ok) {
                                  setFormError(validation.error || 'This GRN has invalid IMEI/Serial values. Edit the draft and correct them before processing.');
                                  setEditingId(p.id); setSupplierId(p.supplierId); setInvoiceNo(p.supplierInvoiceNo || ''); setNotes(p.notes || '');
                                  setRows(p.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice, unitText: (i.unitIdentifiers || []).map(u => [u.imei, u.serial].filter(Boolean).join(',')).join('\n') })));
                                  setFormMode('receive'); setView('form'); return;
                                }
                                setFormError(''); setFormMode('receive'); setPriceChanges([]); setConfirmId(p.id);
                              }}
                            >
                              <Zap size={13} /> Process
                            </button>
                          )}
                          {p.status === 'pending' && can('act:deleteRecords') && <button className="icon-btn !w-8 !h-8 hover:!text-rose-500" onClick={() => setDeleteId(p.id)} disabled={actionRunning}><Trash2 size={14} /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal open={!!confirmId} onClose={() => !actionRunning && setConfirmId(null)} title="Process GRN?" sub="Stock will be added once, and the GRN becomes immutable.">
        <p className="text-sm text-sub">This action updates inventory and records the receipt in the inventory ledger. It cannot be repeated after processing.</p>
        {confirmId && (() => {
          const p = state.purchases.find(x => x.id === confirmId);
          if (!p) return null;
          const unitCount = p.items.filter(i => state.products.find(x => x.id === i.productId)?.trackImei || state.products.find(x => x.id === i.productId)?.trackSerial).reduce((sum, i) => sum + i.qty, 0);
          return <div className="mt-4 rounded-xl border border-line bg-raised p-3 text-sm space-y-1">
            <div><span className="text-sub">Supplier:</span> <b>{p.supplierName}</b></div>
            <div><span className="text-sub">Total:</span> <b className="num">{fmtRs(p.total)}</b></div>
            <div><span className="text-sub">Units:</span> <b>{unitCount}</b></div>
          </div>;
        })()}
        {confirmInvoiceDuplicates.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-3 space-y-2">
            <p className="text-sm font-bold text-amber-700">Duplicate supplier invoice detected</p>
            <p className="text-xs text-sub">The same normalized invoice number is already recorded for this supplier:</p>
            {confirmInvoiceDuplicates.map(match => <div key={match.id} className="text-xs text-sub"><b>{match.poNo}</b> · {match.status === 'received' ? 'Processed' : 'Draft'} · {fmtDate(match.date)}</div>)}
            {canOverrideInvoiceDuplicate ? (
              <Field label="Admin/Manager override reason (optional)">
                <textarea className="input min-h-20 text-sm" rows={3} value={invoiceOverrideReason} onChange={e => setInvoiceOverrideReason(e.target.value)} placeholder="Optional: explain why this supplier invoice is being received again…" disabled={actionRunning} />
                <p className="text-[11px] text-sub mt-1">You can leave this blank. If entered, the reason will be saved in the audit log.</p>
              </Field>
            ) : (
              <p className="text-xs font-semibold text-rose-600">Only an Admin or Manager can approve this duplicate invoice. No stock will be added until it is approved.</p>
            )}
          </div>
        )}
        {priceChanges.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <p className="text-xs font-bold text-amber-600 mb-2">Selling price changes</p>
            {priceChanges.map(c => <p key={c.name} className="text-xs text-sub">{c.name}: {fmtRs(c.old)} → {fmtRs(c.next)}</p>)}
          </div>
        )}
        <div className="flex gap-2 mt-5">
          <button className="btn btn-outline-emerald flex-1" onClick={process} disabled={actionRunning || !recoveryLoaded || !!recoveryLoadError || (confirmInvoiceDuplicates.length > 0 && !canOverrideInvoiceDuplicate)}>
            <Zap size={14} /> {actionRunning ? 'Processing...' : 'Process GRN'}
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setConfirmId(null)} disabled={actionRunning}>Cancel</button>
        </div>
      </Modal>

      <Modal open={confirmWorkingDraftDiscard} onClose={() => setConfirmWorkingDraftDiscard(false)} title="Discard unfinished GRN?">
        <p className="text-sm text-sub">This removes only the unfinished local recovery copy. It does not change inventory stock or processed GRNs.</p>
        <div className="flex gap-2 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => void discardWorkingDraft()}>Discard unfinished work</button>
          <button className="btn btn-soft flex-1" onClick={() => setConfirmWorkingDraftDiscard(false)}>Keep draft</button>
        </div>
      </Modal>

      <Modal open={!!deleteId} onClose={() => !actionRunning && setDeleteId(null)} title="Delete GRN draft?">
        <p className="text-sm text-sub">Only a draft can be deleted. Processed GRNs remain as permanent stock history.</p>
        <div className="flex gap-2 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleteId) deletePurchase(deleteId); setDeleteId(null); }} disabled={actionRunning}>Delete draft</button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleteId(null)} disabled={actionRunning}>Cancel</button>
        </div>
      </Modal>

      <Modal open={!!selectedGrn} onClose={() => setSelectedGrn(null)} title={selectedGrn ? 'GRN ' + selectedGrn.poNo : 'GRN details'} sub="Complete receiving record · read-only history" wide>
        {selectedGrn && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-line bg-raised p-3 text-sm">
              <div><span className="text-sub">Supplier:</span> <b>{selectedGrn.supplierName}</b></div>
              <div><span className="text-sub">Date:</span> <b>{fmtDate(selectedGrn.date)}</b></div>
              <div><span className="text-sub">Supplier invoice:</span> <b>{selectedGrn.supplierInvoiceNo || '—'}</b></div>
              <div><span className="text-sub">Status:</span> <b>{selectedGrn.status === 'received' ? 'PROCESSED' : 'DRAFT'}</b></div>
              {selectedGrn.processedBy && <div><span className="text-sub">Processed by:</span> <b>{selectedGrn.processedBy}</b></div>}
              {selectedGrn.processedAt && <div><span className="text-sub">Processed at:</span> <b>{fmtDate(selectedGrn.processedAt)}</b></div>}
              {selectedGrn.branchId && <div><span className="text-sub">Branch:</span> <b>{selectedGrn.branchId}</b></div>}
            </div>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[560px]">
                <thead><tr><th className="th">Product</th><th className="th text-right">Qty</th><th className="th text-right">Unit cost</th><th className="th text-right">Line total</th></tr></thead>
                <tbody>{selectedGrn.items.map((item, index) => (
                  <tr key={item.productId + ':' + index}>
                    <td className="td">
                      <div className="font-semibold">{item.name}</div>
                      {item.unitIdentifiers?.length ? <div className="text-[11px] text-sub mt-1 break-all">{item.unitIdentifiers.map(unit => [unit.imei, unit.serial].filter(Boolean).join(' / ')).join(' · ')}</div> : null}
                    </td>
                    <td className="td num text-right">{item.qty}</td>
                    <td className="td num text-right">{fmtRs(item.cost)}</td>
                    <td className="td num text-right font-semibold">{fmtRs(item.qty * item.cost)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="flex justify-between rounded-xl border border-line p-3"><span className="font-semibold text-sub">GRN Total</span><b className="num text-lg">{fmtRs(selectedGrn.total)}</b></div>
            {selectedGrn.notes && <div className="rounded-xl border border-line p-3 text-sm"><b>Notes</b><p className="text-sub mt-1 whitespace-pre-wrap">{selectedGrn.notes}</p></div>}
            <div className="flex flex-wrap justify-end gap-2">
              {selectedGrn.status === 'pending' && <button className="btn btn-soft" onClick={() => { const target=selectedGrn; setSelectedGrn(null); edit(target); }}><Pencil size={14}/> Edit draft</button>}
              {can('act:export') && <button className="btn btn-primary" onClick={() => { setPrintReady(false); setPrintPreview({ grn:selectedGrn, html:grnPrintHtml(selectedGrn,state.settings.shopName) }); }}><Printer size={14}/> Print / Save PDF</button>}
              <button className="btn btn-soft" onClick={() => setSelectedGrn(null)}>Close</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!printPreview} onClose={() => { if (!actionRunning) { setPrintPreview(null); setPrintReady(false); } }} title={printPreview ? 'GRN ' + printPreview.grn.poNo : 'GRN print preview'} sub="Preview the A4 goods received note before printing or saving as PDF" wide>
        {printPreview && (
          <div className="space-y-3">
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-primary" onClick={() => printFrame.current?.contentWindow?.print()} disabled={!printReady}><Printer size={15} /> Print</button>
              <button type="button" className="btn btn-soft" onClick={() => printFrame.current?.contentWindow?.print()} disabled={!printReady}><Printer size={15} /> Download PDF</button>
              <button type="button" className="btn btn-soft" onClick={() => { setPrintPreview(null); setPrintReady(false); }}>Close</button>
            </div>
            <div className="rounded-xl border border-line bg-slate-100 p-2"><iframe ref={printFrame} title="GRN print preview" srcDoc={printPreview.html} onLoad={() => setPrintReady(true)} className="w-full h-[70vh] rounded-lg bg-white border border-line" /></div>
            <p className="text-xs text-faint text-center">Use the browser print dialog and choose “Save as PDF” to download a PDF copy.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}