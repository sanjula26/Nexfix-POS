import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Package, Plus, Trash2, PauseCircle, Landmark,
  CreditCard, Banknote, Smartphone, HandCoins, X, Boxes, History, Zap,
  UserRound, Coins, UserPlus, Search, CheckCircle2,
  ReceiptText, ChevronDown, Tag, ShoppingBag, Keyboard, Grid3X3,
  AlertTriangle, LockKeyhole, ArrowLeftRight, ShieldCheck,
  Loader2, Eye, EyeOff, Lock, Star, BadgeDollarSign, Printer,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { findCloudCustomerByPhone, getCloudShopId } from '../lib/cloudSync';
import { SearchInput, Badge, Modal, Field } from '../components/ui';
import ReceiptModal, { buildWhatsAppText } from '../components/ReceiptModal';
import CartLine from '../components/POSCartLine';
import POSToastStack from '../components/POSToastStack';
import POSKeyboardHint from '../components/POSKeyboardHint';
import POSMobileCheckoutBar from '../components/POSMobileCheckoutBar';
import POSReprintWhatsAppModal from '../components/POSReprintWhatsAppModal';
import POSQuickAddCustomerModal from '../components/POSQuickAddCustomerModal';
import POSHeldSalesModal from '../components/POSHeldSalesModal';
import POSCashDrawerModal from '../components/POSCashDrawerModal';
import POSBillReversalModal from '../components/POSBillReversalModal';
import POSPriceOverrideGate from '../components/POSPriceOverrideGate';
import POSReprintBillsModal from '../components/POSReprintBillsModal';
import POSImeiUnitPicker from '../components/POSImeiUnitPicker';
import POSTradeInEntry from '../components/POSTradeInEntry';
import POSAccessorySuggestions from '../components/POSAccessorySuggestions';
import POSSalesmanNoteControls from '../components/POSSalesmanNoteControls';
import POSLoyaltyRedeemPanel from '../components/POSLoyaltyRedeemPanel';
import POSPaymentMethodSelector from '../components/POSPaymentMethodSelector';
import POSCheckoutWhatsAppField from '../components/POSCheckoutWhatsAppField';
import POSWhatsAppReceiptOptIn from '../components/POSWhatsAppReceiptOptIn';
import POSDiscountControl from '../components/POSDiscountControl';
import POSTaxControl from '../components/POSTaxControl';
import POSServiceDeliveryCharge from '../components/POSServiceDeliveryCharge';
import POSBillSummary from '../components/POSBillSummary';
import { fmtRs, dkey, timeAgo, uid, salePayments, waLink, openWhatsAppLink, normalizeWhatsAppPhone } from '../lib/utils';
import { useBarcodeScanner } from '../lib/useBarcodeScanner';
import type { PaymentMethod, PaymentLeg, Sale, Customer } from '../lib/types';

const CAT_ICON: Record<string, React.ElementType> = {
  Smartphones: Smartphone, Laptops: Package, Audio: Zap, Power: Zap,
  Accessories: Package, Storage: Package, Wearables: Smartphone, Printers: Package,
};
const CAT_TINT: Record<string, string> = {
  Smartphones: 'from-violet-500 to-indigo-600', Laptops: 'from-sky-500 to-blue-600',
  Audio: 'from-fuchsia-500 to-pink-500', Power: 'from-amber-500 to-orange-600',
  Accessories: 'from-emerald-500 to-teal-600', Storage: 'from-cyan-500 to-sky-600',
  Wearables: 'from-rose-500 to-pink-600', Printers: 'from-slate-500 to-slate-700',
};

const PAYMENTS: { key: PaymentMethod; label: string; icon: React.ElementType }[] = [
  { key: 'cash', label: 'Cash', icon: Banknote },
  { key: 'card', label: 'Card', icon: CreditCard },
  { key: 'bank', label: 'Bank', icon: Landmark },
  { key: 'mobile', label: 'Mobile', icon: Smartphone },
  { key: 'credit', label: 'Credit', icon: HandCoins },
];
const SPLIT_METHODS = PAYMENTS.filter(p => p.key !== 'credit');

interface Line { productId: string; qty: number; discount: number; price?: number; unitIds?: string[] }

/** live thousand-separator formatting while typing */
const fmtMoneyInput = (raw: string): string => {
  if (raw === '') return '';
  const hasDot = raw.includes('.');
  const [i, d] = raw.split('.');
  const int = (i || '').replace(/^0+(?=\d)/, '');
  const withCommas = int ? Number(int).toLocaleString('en-US') : hasDot ? '0' : '';
  return d !== undefined ? `${withCommas}.${d.slice(0, 2)}` : withCommas;
};

interface Toast { id: string; msg: string; tone: 'rose' | 'amber' }

export default function POS() {
  const { state, user, can, completeSaleCloud, holdSale, resumeHold, deleteHold, saveCustomer, adminPrompt, verifyAdminPin, findUnitByCode, requestBillReverse } = usePOS();
  const navigate = useNavigate();

  /* catalog */
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');

  /* cart */
  const [lines, setLines] = useState<Line[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** product waiting for IMEI/serial unit selection */
  const [unitPickProductId, setUnitPickProductId] = useState<string | null>(null);
  const [unitPickSearch, setUnitPickSearch] = useState('');

  /* customer */
  const [customerId, setCustomerId] = useState('');
  const [custQuery, setCustQuery] = useState('');
  const [custOpen, setCustOpen] = useState(false);
  const [addCustOpen, setAddCustOpen] = useState(false);
  const [newCust, setNewCust] = useState({ name: '', phone: '', nic: '', address: '' });
  const [billingWhatsApp, setBillingWhatsApp] = useState('');
  const custBoxRef = useRef<HTMLDivElement>(null);
  const custInputRef = useRef<HTMLInputElement>(null);

  /* bill meta */
  const [salesmanId, setSalesmanId] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  /* charges */
  const [discMode, setDiscMode] = useState<'rs' | 'pct'>('rs');
  const [discount, setDiscount] = useState('');
  const [taxPct, setTaxPct] = useState(() => String(state.settings.taxDefault || ''));
  const [shipOpen, setShipOpen] = useState(false);
  const [shipping, setShipping] = useState('');
  const [tradeInOpen, setTradeInOpen] = useState(false);
  const [tradeIn, setTradeIn] = useState({ productId: '', imei: '', serial: '', value: '', addToInventory: true });

  /* loyalty */
  const [redeemOn, setRedeemOn] = useState(false);
  const [points, setPoints] = useState('');

  /* payment */
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [creditTender, setCreditTender] = useState<Exclude<PaymentMethod, 'credit'>>('cash');
  const [waReceipt, setWaReceipt] = useState(false);
  const [paid, setPaid] = useState('');
  const [paidAuto, setPaidAuto] = useState(true);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [splitOn, setSplitOn] = useState(false);
  const [legs, setLegs] = useState<PaymentLeg[]>([{ method: 'cash', amount: 0 }]);

  /* price override gate */
  const [priceUnlocked, setPriceUnlocked] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [gatePin, setGatePin] = useState('');
  const [gateErr, setGateErr] = useState('');
  const [gateBusy, setGateBusy] = useState(false);
  const [gateShow, setGateShow] = useState(false);

  const [doneSale, setDoneSale] = useState<Sale | null>(null);
  const [doneSaleWhatsApp, setDoneSaleWhatsApp] = useState('');
  const [reprintOpen, setReprintOpen] = useState(false);
  const [reprintSearch, setReprintSearch] = useState('');
  const [reprintWhatsAppSale, setReprintWhatsAppSale] = useState<Sale | null>(null);
  const [reprintWhatsAppPhone, setReprintWhatsAppPhone] = useState('');
  const [finishingSale, setFinishingSale] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseSale, setReverseSale] = useState<Sale | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [error, setError] = useState('');
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const discRef = useRef<HTMLInputElement>(null);
  const billingRef = useRef<HTMLElement>(null);

  useEffect(() => { setSalesmanId(user?.id || ''); }, [user?.id]);

  /* Import lines from Quotations → Convert to Sale */
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('nexfix_quote_convert');
      if (!raw) return;
      sessionStorage.removeItem('nexfix_quote_convert');
      const data = JSON.parse(raw) as {
        quoteNo?: string;
        customerName?: string;
        customerPhone?: string;
        lines?: { productId: string; name: string; qty: number; price: number }[];
      };
      if (!data.lines?.length) return;
      const next: Line[] = [];
      for (const l of data.lines) {
        let pid = l.productId;
        if (!pid || !state.products.some(p => p.id === pid)) {
          const match = state.products.find(
            p => p.active && p.name.toLowerCase() === (l.name || '').toLowerCase(),
          );
          pid = match?.id || '';
        }
        if (!pid) continue;
        next.push({ productId: pid, qty: l.qty || 1, discount: 0, price: l.price });
      }
      if (next.length) setLines(next);
      if (data.customerName) {
        const cust = state.customers.find(
          c => c.name.toLowerCase() === data.customerName!.toLowerCase()
            || (data.customerPhone && c.phone.includes(data.customerPhone)),
        );
        if (cust) setCustomerId(cust.id);
      }
      if (data.quoteNo) setNote(`From quote ${data.quoteNo}`);
      setError('');
    } catch { /* ignore */ }
  // run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const products = useMemo(() => state.products.filter(p => p.active), [state.products]);
  const activeStaff = state.users.filter(u => u.active);
  const categories = ['all', ...Array.from(new Set(products.map(p => p.category)))];

  const filtered = products.filter(p => {
    const q = search.trim().toLowerCase();
    const matchQ = !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode.includes(q) || p.brand.toLowerCase().includes(q);
    const matchC = cat === 'all' || p.category === cat;
    return matchQ && matchC;
  });

  /* cashier-facing type-ahead: keep the primary search compact and scanner friendly */
  const itemSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [products, search]);

  const itemUnitSuggestion = useMemo(() => {
    const code = search.trim();
    if (!code) return undefined;
    const unit = findUnitByCode?.(code);
    return unit && unit.status === 'in_stock' ? unit : undefined;
  }, [findUnitByCode, search]);

  /* frequently sold -> quick add */
  const favorites = useMemo(() => {
    const qty = new Map<string, number>();
    state.sales.filter(s => s.status !== 'refunded').forEach(s =>
      s.items.forEach(it => qty.set(it.productId, (qty.get(it.productId) || 0) + it.qty)),
    );
    return [...qty.entries()]
      .map(([id, q]) => ({ p: products.find(x => x.id === id)!, q }))
      .filter(x => x.p && x.p.active && x.p.stock > 0)
      .sort((a, b) => b.q - a.q)
      .slice(0, 8);
  }, [state.sales, state.products]); // eslint-disable-line react-hooks/exhaustive-deps

  const detailed = lines
    .map(l => ({ ...l, product: products.find(p => p.id === l.productId)! }))
    .filter(l => l.product);

  const bundleSuggestions = useMemo(() => {
    if (!lines.length) return [];
    const cartIds = new Set(lines.map(line => line.productId));
    const cartProducts = state.products.filter(product => cartIds.has(product.id));
    const accessoryPattern = /accessor|charger|cable|case|cover|glass|protector|adapter|earbud|headphone|mouse|keyboard|bag|hub/i;
    return state.products.filter(product => {
      if (!product.active || product.isService || product.stock <= 0 || cartIds.has(product.id)) return false;
      const accessory = accessoryPattern.test(product.category) || accessoryPattern.test(product.name);
      if (!accessory) return false;
      return cartProducts.some(cartProduct =>
        (product.brand && cartProduct.brand && product.brand.toLowerCase() === cartProduct.brand.toLowerCase()) ||
        !product.brand || !cartProduct.brand
      );
    }).sort((a,b) => Number(Boolean(b.brand)) - Number(Boolean(a.brand)) || a.name.localeCompare(b.name)).slice(0,3);
  }, [lines, state.products]);


  /* ---------- totals ---------- */
  const linePrice = (l: (typeof detailed)[number]) => l.price ?? l.product.price;
  const gross = detailed.reduce((s, l) => s + linePrice(l) * l.qty, 0);
  const lineDisc = detailed.reduce((s, l) => s + (l.discount || 0), 0);
  const baseAfterLines = gross - lineDisc;
  const discCart = discMode === 'pct'
    ? Math.min(baseAfterLines, (baseAfterLines * (parseFloat(discount) || 0)) / 100)
    : Math.min(parseFloat(discount) || 0, baseAfterLines);
  const activePromotions = useMemo(() => {
    const today = dkey(new Date());
    return (state.settings.promotions || []).filter(p => {
      if (p.active === false || !p.category || !Number.isFinite(Number(p.discountPct)) || Number(p.discountPct) <= 0) return false;
      if (p.startDate && today < p.startDate) return false;
      if (p.endDate && today > p.endDate) return false;
      return true;
    });
  }, [state.settings.promotions]);
  const promoDiscount = Math.min(baseAfterLines - discCart, detailed.reduce((sum, l) => {
    const pct = activePromotions.filter(p => p.category.trim().toLowerCase() === l.product.category.trim().toLowerCase()).reduce((best, p) => Math.max(best, Number(p.discountPct) || 0), 0);
    return sum + (linePrice(l) * l.qty - (l.discount || 0)) * Math.min(100, pct) / 100;
  }, 0));
  const rawTradeInValue = Math.max(0, parseFloat(tradeIn.value) || 0);
  const tradeInValue = Math.min(rawTradeInValue, Math.max(0, baseAfterLines - discCart - promoDiscount));
  // Cloud atomic sales send trade-in as part of the discount, so tax must use
  // the same post-trade-in taxable base in the POS preview.
  const taxable = Math.max(0, baseAfterLines - discCart - promoDiscount - tradeInValue);
  const tax = (taxable * (parseFloat(taxPct) || 0)) / 100;
  const shipAmt = shipOpen ? Math.max(0, parseFloat(shipping) || 0) : 0;
  const customer = state.customers.find(c => c.id === customerId);
  const billingWhatsAppDigits = normalizeWhatsAppPhone(billingWhatsApp);
  const billingWhatsAppCustomer = useMemo(() => {
    if (billingWhatsAppDigits.length < 9) return undefined;
    return state.customers.find(c => normalizeWhatsAppPhone(c.phone) === billingWhatsAppDigits);
  }, [state.customers, billingWhatsAppDigits]);
  useEffect(() => {
    if (customer?.phone) setBillingWhatsApp(customer.phone);
    else if (!customerId && !billingWhatsAppDigits) setBillingWhatsApp('');
  }, [customer?.phone, customerId, billingWhatsAppDigits]);
  useEffect(() => {
    if (billingWhatsAppCustomer && billingWhatsAppCustomer.id !== customerId) {
      setCustomerId(billingWhatsAppCustomer.id);
      setCustQuery(billingWhatsAppCustomer.phone);
    }
  }, [billingWhatsAppCustomer, customerId]);
  const maxRedeem = customer?.loyaltyPoints || 0;
  const redeemedPts = redeemOn ? Math.min(Math.max(0, Math.floor(parseFloat(points) || 0)), maxRedeem) : 0;
  const preTotal = taxable + tax + shipAmt;
  const loyaltyPointValue = Math.max(0, Number(state.settings.loyaltyPointValue ?? 20));
  const pointsVal = Math.min(redeemedPts * loyaltyPointValue, preTotal);
  const total = Math.max(0, Math.round((preTotal - pointsVal) * 100) / 100);
  const legSum = legs.reduce((a, l) => a + (l.amount || 0), 0);
  const paidNum = splitOn ? legSum : parseFloat(paid) || 0;
  const hasCredit = payment === 'credit';
  const creditDue = hasCredit ? Math.max(0, total - paidNum) : 0;
  const intentionalCredit = creditDue > 0.009;
  const change = hasCredit ? 0 : Math.max(0, paidNum - total);
  const shortage = Math.max(0, total - paidNum);
  const itemCount = detailed.reduce((s, l) => s + l.qty, 0);

  /* keep cashless tenders pinned to the total unless the cashier overrode it */
  useEffect(() => {
    // Cash and cashless single-tender bills default to exact payment. Credit
    // remains deliberately manual, and split tenders keep their own amounts.
    if (!splitOn && payment !== 'credit' && paidAuto) {
      setPaid(total > 0 ? String(total) : '');
    }
  }, [total, payment, splitOn, paidAuto]);

  // Restore the current cashier's unfinished bill once per POS mount. Drafts
  // are tab-session scoped and expire after 12 hours to avoid stale checkout.
  const draftKey = `nexfix_pos_draft_v1:${user?.id || 'anonymous'}`;
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw) as {
          savedAt?: number; lines?: Line[]; customerId?: string; custQuery?: string;
          billingWhatsApp?: string; salesmanId?: string; note?: string; noteOpen?: boolean;
          discMode?: 'rs' | 'pct'; discount?: string; taxPct?: string; shipOpen?: boolean;
          shipping?: string; tradeInOpen?: boolean; tradeIn?: typeof tradeIn;
          redeemOn?: boolean; points?: string; payment?: PaymentMethod;
          creditTender?: Exclude<PaymentMethod, 'credit'>; waReceipt?: boolean;
          paid?: string; paidAuto?: boolean; splitOn?: boolean; legs?: PaymentLeg[];
        };
        if (draft.savedAt && Date.now() - draft.savedAt < 12 * 60 * 60 * 1000 && Array.isArray(draft.lines) && draft.lines.length) {
          setLines(draft.lines.filter(line => line && typeof line.productId === 'string' && Number.isFinite(line.qty) && line.qty > 0));
          setCustomerId(draft.customerId || '');
          setCustQuery(draft.custQuery || '');
          setBillingWhatsApp(draft.billingWhatsApp || '');
          setSalesmanId(draft.salesmanId || user?.id || '');
          setNote(draft.note || '');
          setNoteOpen(Boolean(draft.noteOpen));
          setDiscMode(draft.discMode === 'pct' ? 'pct' : 'rs');
          setDiscount(draft.discount || '');
          setTaxPct(draft.taxPct ?? String(state.settings.taxDefault || ''));
          setShipOpen(Boolean(draft.shipOpen));
          setShipping(draft.shipping || '');
          setTradeInOpen(Boolean(draft.tradeInOpen));
          if (draft.tradeIn) setTradeIn(draft.tradeIn);
          setRedeemOn(Boolean(draft.redeemOn));
          setPoints(draft.points || '');
          setPayment(draft.payment || 'cash');
          setCreditTender(draft.creditTender || 'cash');
          setWaReceipt(Boolean(draft.waReceipt));
          setPaid(draft.paid || '');
          setPaidAuto(Boolean(draft.paidAuto));
          setSplitOn(Boolean(draft.splitOn));
          if (draft.legs?.length) setLegs(draft.legs);
          setError('');
        } else if (raw) {
          sessionStorage.removeItem(draftKey);
        }
      }
    } catch {
      try { sessionStorage.removeItem(draftKey); } catch { /* optional session storage */ }
    } finally {
      setDraftLoaded(true);
    }
  // Restore only once. Subsequent edits are handled by the debounced writer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce small sessionStorage writes so typing stays responsive. Empty
  // carts remove the draft (clear, successful sale, and successful hold).
  useEffect(() => {
    if (!draftLoaded) return;
    const timer = window.setTimeout(() => {
      try {
        if (!lines.length) {
          sessionStorage.removeItem(draftKey);
          return;
        }
        sessionStorage.setItem(draftKey, JSON.stringify({
          savedAt: Date.now(), lines, customerId, custQuery, billingWhatsApp,
          salesmanId, note, noteOpen, discMode, discount, taxPct, shipOpen,
          shipping, tradeInOpen, tradeIn, redeemOn, points, payment, creditTender,
          waReceipt, paid, paidAuto, splitOn, legs,
        }));
      } catch { /* draft persistence is best-effort if storage is unavailable */ }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    draftLoaded, draftKey, lines, customerId, custQuery, billingWhatsApp, salesmanId,
    note, noteOpen, discMode, discount, taxPct, shipOpen, shipping, tradeInOpen,
    tradeIn, redeemOn, points, payment, creditTender, waReceipt, paid, paidAuto,
    splitOn, legs,
  ]);

  // IndexedDB is the authoritative local POS store. If a durable write
  // fails, warn the cashier so they verify sale status before retrying.
  useEffect(() => {
    const onStorageError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setError(detail?.message || 'Local POS storage failed. Verify the sale status before retrying.');
    };
    window.addEventListener('nexfix:storage-error', onStorageError);
    return () => window.removeEventListener('nexfix:storage-error', onStorageError);
  }, []);

  /* ---------- toasts ---------- */
  const toast = (msg: string, tone: Toast['tone'] = 'rose') => {
    const id = uid();
    setToasts(t => [...t.slice(-2), { id, msg, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3600);
  };

  /* ---------- auto-focus the scanner field ---------- */
  const focusSearch = () => searchBoxRef.current?.querySelector('input')?.focus();
  useEffect(() => { const t = setTimeout(focusSearch, 120); return () => clearTimeout(t); }, []);

  /* ---------- customers ---------- */
  const customerPhoneQuery = normalizeWhatsAppPhone(custQuery);
  const exactPhoneCustomer = useMemo(() => {
    if (customerPhoneQuery.length < 9) return undefined;
    return state.customers.find(c => normalizeWhatsAppPhone(c.phone) === customerPhoneQuery);
  }, [state.customers, customerPhoneQuery]);

  const custResults = useMemo(() => {
    const q = custQuery.trim().toLowerCase();
    if (!q) return state.customers.slice(0, 6);
    const digits = normalizeWhatsAppPhone(q);
    return state.customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (digits.length >= 3 && normalizeWhatsAppPhone(c.phone).includes(digits)) ||
      (c.nic || '').toLowerCase().includes(q),
    ).slice(0, 8);
  }, [state.customers, custQuery]);

  /* A complete phone number should select the existing customer automatically. */
  useEffect(() => {
    if (exactPhoneCustomer && customerId !== exactPhoneCustomer.id) {
      setCustomerId(exactPhoneCustomer.id);
      setCustOpen(false);
    }
  }, [exactPhoneCustomer, customerId]);

  const recentCustomers = useMemo(() => {
    const seen = new Map<string, Customer>();
    [...state.sales]
      .sort((a, b) => +new Date(b.date) - +new Date(a.date))
      .forEach(s => {
        if (!s.customerId || seen.has(s.customerId)) return;
        const c = state.customers.find(x => x.id === s.customerId);
        if (c) seen.set(c.id, c);
      });
    return [...seen.values()].filter(c => c.id !== customerId).slice(0, 3);
  }, [state.sales, state.customers, customerId]);

  const customerLastPurchases = useMemo(() => {
    if (!customerId) return [] as Sale[];
    return [...state.sales].filter(s => s.customerId === customerId && (s.status === 'completed' || s.status === 'exchanged')).sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 5);
  }, [state.sales, customerId]);

  useEffect(() => {
    if (!custOpen) return;
    const h = (e: MouseEvent) => {
      if (custBoxRef.current && !custBoxRef.current.contains(e.target as Node)) setCustOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [custOpen]);

  /* ---------- cart ops ---------- */
  const usedUnitIds = () => new Set(lines.flatMap(l => l.unitIds || []));

  const addUnitToCart = (productId: string, unitId: string) => {
    const p = products.find(x => x.id === productId);
    if (!p) return;
    const used = usedUnitIds();
    if (used.has(unitId)) { toast('That unit is already in the cart', 'rose'); return; }
    const cur = lines.find(l => l.productId === productId);
    if (cur) {
      if (cur.qty + 1 > p.stock) { toast(`Only ${p.stock} in stock — ${p.name}`, 'rose'); return; }
      setLines(ls => {
        const line = ls.find(l => l.productId === productId)!;
        return [{ ...line, qty: line.qty + 1, unitIds: [...(line.unitIds || []), unitId] }, ...ls.filter(l => l.productId !== productId)];
      });
    } else {
      setLines(ls => [{ productId, qty: 1, discount: 0, unitIds: [unitId] }, ...ls]);
    }
    setUnitPickProductId(null);
    setUnitPickSearch('');
    toast(`Added · ${p.name}`, 'amber');
  };

  const add = (id: string) => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const cur = lines.find(l => l.productId === id)?.qty || 0;
    if (p.stock === 0) { toast(`OUT OF STOCK — ${p.name}`, 'rose'); return; }
    if (cur + 1 > p.stock) { toast(`Only ${p.stock} in stock — ${p.name}`, 'rose'); return; }
    // Tracked products require picking a specific IMEI/serial unit
    if (p.trackImei || p.trackSerial) {
      setUnitPickProductId(id);
      setUnitPickSearch('');
      return;
    }
    if (p.stock <= p.reorderLevel) toast(`LOW STOCK · only ${p.stock - cur} left — ${p.name}`, 'rose');
    setLines(ls => {
      const ex = ls.find(l => l.productId === id);
      return ex ? [{ ...ex, qty: ex.qty + 1 }, ...ls.filter(l => l.productId !== id)] : [{ productId: id, qty: 1, discount: 0 }, ...ls];
    });
    toast(`Added · ${p.name}`, 'amber');
  };
  const setQty = (id: string, qty: number) => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    if (qty <= 0) return setLines(ls => ls.filter(l => l.productId !== id));
    // For tracked products, qty can only grow via unit picker
    if (p.trackImei || p.trackSerial) {
      const line = lines.find(l => l.productId === id);
      if (!line) return;
      if (qty < line.qty) {
        // trim units from the end
        setLines(ls => ls.map(l => l.productId === id
          ? { ...l, qty, unitIds: (l.unitIds || []).slice(0, qty) }
          : l));
      } else if (qty > line.qty) {
        setUnitPickProductId(id);
        setUnitPickSearch('');
      }
      return;
    }
    setLines(ls => ls.map(l => (l.productId === id ? { ...l, qty: Math.min(qty, p.stock) } : l)));
  };
  const setLineDisc = (id: string, disc: number) => {
    const line = detailed.find(l => l.productId === id);
    if (!line) return;
    setLines(ls => ls.map(l => (l.productId === id ? { ...l, discount: Math.min(Math.max(0, disc), linePrice(line) * l.qty) } : l)));
  };
  const setLinePrice = (id: string, price: number | undefined) => {
    setLines(ls => ls.map(l => (l.productId === id ? { ...l, price } : l)));
  };

  const reset = () => {
    setLines([]); setCustomerId(''); setCustQuery(''); setBillingWhatsApp(''); setDiscount(''); setDiscMode('rs');
    setTaxPct(String(state.settings.taxDefault || '')); setShipOpen(false); setShipping('');
    setTradeInOpen(false); setTradeIn({ productId: '', imei: '', serial: '', value: '', addToInventory: true });
    setRedeemOn(false); setPoints(''); setPayment('cash'); setPaid(total > 0 ? String(total) : ''); setPaidAuto(true);
    setWaReceipt(false);
    // Keep Split mode selected between bills. The cashier can press Split again
    // to return to the normal single-payment buttons.
    setLegs([{ method: 'cash', amount: 0 }]);
    setError('');
    setNote(''); setNoteOpen(false); setPriceUnlocked(false);
    setSalesmanId(user?.id || '');
  };

  /* ---------- finish ---------- */
  const finish = async () => {
    if (finishingSale) return;
    setError('');
    // Cash-session and branch matching are enforced authoritatively by completeSaleCloud,
    // which can distinguish a missing session from an unconfirmed opening float.
    if (lines.length === 0) return setError('Add at least one item to the cart');

    // Validate the aggregate quantity per product before calling Supabase.
    // Quotation imports/older held carts can contain duplicate product lines,
    // even though the normal cashier add flow merges them into one line.
    // The cloud RPC correctly validates the aggregate too; doing the same
    // preflight locally gives the cashier the real stock error before a remote
    // transaction is attempted.
    const requestedQtyByProduct = new Map<string, number>();
    for (const line of lines) {
      const qty = Number(line.qty);
      const current = requestedQtyByProduct.get(line.productId) || 0;
      requestedQtyByProduct.set(line.productId, current + (Number.isFinite(qty) ? qty : 0));
    }
    for (const [productId, requestedQty] of requestedQtyByProduct) {
      const product = products.find(p => p.id === productId);
      if (!product || !Number.isFinite(requestedQty) || requestedQty <= 0) {
        return setError('One or more sale lines are invalid');
      }
      const kitItems = product.isKit
        ? (state.kitItems || []).filter(k => k.kitProductId === product.id && Number.isFinite(k.qty) && k.qty > 0)
        : [];
      if (!kitItems.length && requestedQty > product.stock) {
        return setError(`Only ${product.stock} in stock — ${product.name}`);
      }
    }

    if ((discCart > 0 || lineDisc > 0) && !can('act:discount')) return setError('Your role cannot apply discounts');
    if (tradeInOpen) {
      const tp = products.find(p => p.id === tradeIn.productId);
      if (!tp) return setError('Select the trade-in device/product');
      if (tradeInValue <= 0) return setError('Enter a valid trade-in value');
      if (tradeIn.addToInventory && (!tp.trackImei && !tp.trackSerial)) return setError('The selected product is not configured for IMEI/Serial inventory');
      if (tradeIn.addToInventory && tp.trackImei && !tradeIn.imei.trim()) return setError('Enter the trade-in IMEI');
      if (tradeIn.addToInventory && tp.trackSerial && !tradeIn.serial.trim()) return setError('Enter the trade-in serial number');
    }
    if (hasCredit && paidNum > total + 0.009) return setError('Amount received now cannot exceed the bill total.');
    // Resolve a matching existing customer synchronously at click time too; do not
    // rely only on the auto-link effect having rendered before Complete Sale.
    const saleCustomerId = customerId || billingWhatsAppCustomer?.id || exactPhoneCustomer?.id;
    const saleCustomer = saleCustomerId ? state.customers.find(c => c.id === saleCustomerId) : undefined;
    if (intentionalCredit && !saleCustomerId) return setError('Select a customer before selling on credit. A matching saved WhatsApp/phone number will be linked automatically.');
    if (intentionalCredit && !can('act:creditSale')) return setError('Your role cannot make credit sales.');
    if (intentionalCredit && saleCustomer?.creditLimit && saleCustomer.creditLimit > 0 && saleCustomer.creditBalance + creditDue > saleCustomer.creditLimit) {
      return setError(`Credit limit exceeded. Existing due ${fmtRs(saleCustomer.creditBalance)} + this bill credit ${fmtRs(creditDue)} is above the ${fmtRs(saleCustomer.creditLimit)} limit.`);
    }
    // Require IMEI/serial for tracked lines
    for (const l of lines) {
      const p = products.find(x => x.id === l.productId);
      if (p && (p.trackImei || p.trackSerial)) {
        if (!l.unitIds || l.unitIds.length !== l.qty) {
          return setError(`Select IMEI/Serial for ${p.name} (${l.qty} unit${l.qty > 1 ? 's' : ''})`);
        }
      }
    }
    if (splitOn) {
      if (legs.some(l => l.amount <= 0)) return setError('Enter an amount greater than zero for every split payment');
      if (!hasCredit && legSum < total - 0.009) return setError(`Split payments are short by ${fmtRs(total - legSum)}`);
      if (legSum > total + 0.009) return setError(`Split payments exceed the bill total by ${fmtRs(legSum - total)}. Adjust the amounts before completing.`);
      
    } else if (!hasCredit && paidNum < total) {
      return setError(`Still ${fmtRs(total - paidNum)} short of the total`);
    }
    /* Validate the explicitly entered billing WhatsApp number before entering the finishing state. */
    const whatsappDigits = normalizeWhatsAppPhone(billingWhatsApp || customer?.phone || custQuery);
    if (billingWhatsApp.trim() && (whatsappDigits.length < 9 || whatsappDigits.length > 15)) {
      return setError('Enter a valid WhatsApp number before completing this bill.');
    }

    /* Reserve the WhatsApp tab during the user click so popup blockers do not block it after the async sale completes. */
    setFinishingSale(true);
    const autoWhatsApp = whatsappDigits.length >= 9 && (waReceipt || state.settings.whatsappReceipts);
    const whatsappWindow = autoWhatsApp ? window.open('about:blank', '_blank') : null;
    if (whatsappWindow) {
      try { whatsappWindow.opener = null; } catch { /* browser may make opener read-only */ }
    }

    let sale: Sale | null = null;
    try {
      sale = await completeSaleCloud({
      lines: lines.map(l => {
        const p = products.find(x => x.id === l.productId)!;
        const base: { productId: string; qty: number; discount: number; price?: number; unitIds?: string[] } = {
          productId: l.productId, qty: l.qty, discount: l.discount, unitIds: l.unitIds,
        };
        if (l.price !== undefined && l.price !== p.price) base.price = l.price;
        return base;
      }),
      customerId: saleCustomerId || undefined,
      // Promotions are already materialized into each line by the sale engine.
      // Only the cashier-entered cart-level discount belongs in input.discount;
      // sending promoDiscount here would apply the promotion twice.
      discount: discCart,
      tradeIn: tradeInOpen ? { productId: tradeIn.productId, value: tradeInValue, imei: tradeIn.imei.trim() || undefined, serial: tradeIn.serial.trim() || undefined, addToInventory: tradeIn.addToInventory } : undefined,
      taxPct: parseFloat(taxPct) || 0,
      shipping: shipAmt,
      pointsRedeemed: redeemedPts,
      payment,
      amountPaid: paidNum,
      payments: splitOn ? legs : (hasCredit && paidNum > 0 ? [{ method: creditTender, amount: paidNum }] : undefined),
      creditDue: hasCredit ? creditDue : 0,
      note: note.trim() || undefined,
      salesmanId: salesmanId || undefined,
    });
    } catch (error) {
      if (whatsappWindow) whatsappWindow.close();
      const message = error instanceof Error ? error.message.trim() : '';
      setError(message ? `Sale could not be completed: ${message}` : 'Sale could not be completed. Please try again.');
      return;
    } finally {
      setFinishingSale(false);
    }
    if (sale) {
      setDoneSale(sale);
      setDoneSaleWhatsApp(whatsappDigits);
      /* WhatsApp receipt — navigate the user-approved tab after the sale is confirmed. */
      if (whatsappWindow && whatsappDigits.length >= 9) {
        whatsappWindow.location.href = waLink(whatsappDigits, buildWhatsAppText(sale, state.settings));
      }
      reset();
      setTimeout(focusSearch, 150);
    } else {
      if (whatsappWindow) whatsappWindow.close();
      setError('Sale was not completed. The sale handler returned no receipt; check the cash session and cloud status, then retry. If this repeats, contact an admin before retrying to avoid duplicate billing.');
    }
  };

  /* ---------- hold ---------- */
  const hold = () => {
    if (lines.length === 0) return;
    holdSale({
      label: `Held · ${itemCount} item(s)`,
      lines: lines.map(l => ({ productId: l.productId, qty: l.qty, discount: l.discount, price: l.price, unitIds: l.unitIds })),
      customerId: customerId || undefined,
      discount: discCart, taxPct: parseFloat(taxPct) || 0,
      discountMode: discMode,
      shipping: shipAmt || undefined,
      points: redeemedPts || undefined,
      redeemOn,
      payment,
      paid: paidNum || undefined,
      splitOn,
      legs: splitOn ? legs : undefined,
      note: note.trim() || undefined,
      salesmanId: salesmanId || undefined,
      billingWhatsApp: billingWhatsApp || undefined,
      tradeIn: tradeInOpen && tradeInValue > 0 ? {
        ...tradeIn,
        value: tradeInValue,
        imei: tradeIn.imei.trim() || undefined,
        serial: tradeIn.serial.trim() || undefined,
      } : undefined,
    });
    toast('Sale parked safely — all bill details were saved', 'amber');
    reset();
  };
  const resume = (id: string) => {
    const h = resumeHold(id);
    if (!h) return;
    setLines(h.lines.map(l => ({ ...l, discount: l.discount || 0, price: l.price, unitIds: l.unitIds })));
    setCustomerId(h.customerId || '');
    setDiscount(h.discount ? String(h.discount) : '');
    setDiscMode(h.discountMode || 'rs');
    setTaxPct(h.taxPct ? String(h.taxPct) : '');
    setShipOpen(Boolean(h.shipping));
    setShipping(h.shipping ? String(h.shipping) : '');
    setRedeemOn(Boolean(h.redeemOn));
    setPoints(h.points ? String(h.points) : '');
    setPayment(h.payment || 'cash');
    setPaid(h.paid ? String(h.paid) : '');
    setPaidAuto(false);
    setSplitOn(Boolean(h.splitOn));
    setLegs(h.legs?.length ? h.legs : [{ method: h.payment || 'cash', amount: h.paid || 0 }]);
    setNote(h.note || '');
    setNoteOpen(Boolean(h.note));
    setSalesmanId(h.salesmanId || user?.id || '');
    setBillingWhatsApp(h.billingWhatsApp || '');
    if (h.tradeIn) {
      setTradeInOpen(true);
      setTradeIn({
        productId: h.tradeIn.productId || '',
        imei: h.tradeIn.imei || '',
        serial: h.tradeIn.serial || '',
        value: String(h.tradeIn.value || ''),
        addToInventory: h.tradeIn.addToInventory !== false,
      });
    } else {
      setTradeInOpen(false);
      setTradeIn({ productId: '', imei: '', serial: '', value: '', addToInventory: true });
    }
    setHeldOpen(false);
    billingRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  /* ---------- quick add customer ---------- */
  const quickAddCustomer = async () => {
    const name = newCust.name.trim();
    const phone = newCust.phone.trim();
    if (!name || !phone) return;
    const normalized = normalizeWhatsAppPhone(phone);
    if (normalized.length < 9) {
      toast('Enter a valid WhatsApp phone number', 'rose');
      return;
    }
    const national = normalized.startsWith('94') ? normalized.slice(2) : normalized;
    if (normalized === '94770000000' || (national.length >= 8 && /^(\d)\1+$/.test(national))) {
      toast('That looks like a placeholder number. Enter the customer’s real phone number.', 'rose');
      return;
    }
    const existing = state.customers.find(c => normalizeWhatsAppPhone(c.phone) === normalized);
    if (existing) {
      setCustomerId(existing.id);
      setCustQuery(existing.phone);
      setAddCustOpen(false);
      setNewCust({ name: '', phone: '', nic: '', address: '' });
      setBillingWhatsApp(existing.phone);
      toast('Existing customer selected — this WhatsApp number is already saved', 'amber');
      return;
    }

    // Check cloud before minting a local customer ID. This prevents a local
    // duplicate when the same phone is already registered under another ID.
    const cloudShopId = getCloudShopId();
    if (cloudShopId && typeof navigator !== 'undefined' && navigator.onLine) {
      const cloudMatch = await findCloudCustomerByPhone(phone, cloudShopId);
      if (!cloudMatch.ok && cloudMatch.error !== 'offline') {
        toast(`Could not check cloud customers: ${cloudMatch.error || 'unknown error'}`, 'rose');
        return;
      }
      if (cloudMatch.customer) {
        const remote = cloudMatch.customer;
        // Keep the cloud ID and current credit/loyalty values locally so future
        // sales, customer selection, and credit settlement all refer to one ID.
        saveCustomer({
          id: remote.id, name: remote.name || name, phone: remote.phone || phone,
          email: remote.email || undefined, nic: remote.nic || undefined,
          address: remote.address || undefined, createdAt: new Date().toISOString(),
          creditBalance: Number(remote.credit_balance) || 0,
          loyaltyPoints: Number(remote.loyalty_points) || 0,
          creditLimit: Number(remote.credit_limit) > 0 ? Number(remote.credit_limit) : undefined,
        });
        setCustomerId(remote.id);
        setCustQuery(remote.name || remote.phone || phone);
        setAddCustOpen(false);
        setNewCust({ name: '', phone: '', nic: '', address: '' });
        setBillingWhatsApp(remote.phone || phone);
        toast('Existing cloud customer selected by phone number', 'amber');
        return;
      }
    }

    const c = { id: uid(), name, phone, nic: newCust.nic.trim() || undefined, address: newCust.address.trim() || undefined, createdAt: new Date().toISOString(), creditBalance: 0, loyaltyPoints: 0 };
    saveCustomer(c);
    setCustomerId(c.id);
    setCustQuery(phone);
    setBillingWhatsApp(phone);
    setAddCustOpen(false);
    setNewCust({ name: '', phone: '', nic: '', address: '' });
  };

  /* ---------- admin gate (price override) ---------- */
  const tryGate = () => {
    if (!gatePin || gateBusy) return;
    setGateBusy(true); setGateErr('');
    setTimeout(() => {
      const ok = verifyAdminPin(gatePin, 'price override');
      setGateBusy(false);
      if (ok) { setPriceUnlocked(true); setGateOpen(false); setGatePin(''); toast('Price override unlocked for this bill', 'amber'); }
      else { setGateErr('Incorrect admin password'); setGatePin(''); }
    }, 350);
  };

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (adminPrompt) return; // session suspended while admin prompt is visible
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'F2') { e.preventDefault(); billingRef.current?.scrollIntoView({ behavior: 'smooth' }); custInputRef.current?.focus(); custInputRef.current?.select(); }
      else if (e.key === 'F3') { e.preventDefault(); focusSearch(); }
      else if (e.key === 'F4') { e.preventDefault(); if (can('act:discount')) { discRef.current?.focus(); discRef.current?.select(); } }
      else if (e.key === 'F5') { e.preventDefault(); hold(); }
      else if (e.key === 'F6') { e.preventDefault(); finish(); }
      else if (e.key === 'F8') { e.preventDefault(); if (lines.length) reset(); }
      else if (e.key === 'Escape' && !typing && lines.length > 0) reset();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, total, paid, legs, payment, customerId, splitOn, discount, taxPct, shipping, points, redeemOn, adminPrompt, note, salesmanId]);

  /* barcode scan → enter adds instantly */
  useEffect(() => {
    const el = searchBoxRef.current?.querySelector('input');
    if (!el) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const q = search.trim().toLowerCase();
        const exact = products.find(p => p.barcode === search.trim() || p.sku.toLowerCase() === q);
        if (exact) { add(exact.id); setSearch(''); el.focus(); }
        else if (filtered.length === 1) { add(filtered[0].id); setSearch(''); }
        else {
          // try IMEI / serial from search box
          const unit = findUnitByCode?.(search.trim());
          if (unit && unit.status === 'in_stock') {
            addUnitToCart(unit.productId, unit.id);
            setSearch('');
            el.focus();
          }
        }
      }
    };
    el.addEventListener('keydown', h);
    return () => el.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, products, filtered]);

  /* hardware scanner (keyboard wedge) — works even when search is not focused */
  useBarcodeScanner((code) => {
    if (adminPrompt) return;
    const byBarcode = products.find(p => p.barcode === code || p.sku.toLowerCase() === code.toLowerCase());
    if (byBarcode) {
      add(byBarcode.id);
      toast(`Scanned ${byBarcode.name}`, 'amber');
      return;
    }
    const unit = findUnitByCode?.(code);
    if (unit && unit.status === 'in_stock') {
      addUnitToCart(unit.productId, unit.id);
      toast(`Unit ${unit.imei || unit.serial}`, 'amber');
      return;
    }
    toast(`Unknown code: ${code}`, 'rose');
  }, { enabled: !adminPrompt, force: false });

  /* drawer figures */
  const todaySales = state.sales.filter(s => dkey(s.date) === dkey(new Date()) && s.status !== 'refunded');
  const cashOf = (ss: typeof todaySales) => ss.reduce((a, s) => a + salePayments(s).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0), 0);
  const myToday = todaySales.filter(s => s.cashierId === user?.id);
  const myCash = cashOf(myToday);
  const session = state.sessions.find(s => s.cashierId === user?.id && s.date === dkey(new Date()));
  const expected = (session?.opening ?? state.settings.openingFloat) + (user?.role === 'cashier' ? myCash : cashOf(todaySales));

  const todayBills = useMemo(() => [...state.sales]
    .filter(s => dkey(s.date) === dkey(new Date()))
    .sort((a, b) => +new Date(b.date) - +new Date(a.date)), [state.sales]);

  const reprintBills = useMemo(() => {
    const q = reprintSearch.trim().toLowerCase();
    if (!q) return todayBills;
    return todayBills.filter(s => {
      const phone = s.customerId ? state.customers.find(c => c.id === s.customerId)?.phone || '' : '';
      return s.billNo.toLowerCase().includes(q)
        || (s.customerName || '').toLowerCase().includes(q)
        || (s.cashierName || '').toLowerCase().includes(q)
        || phone.toLowerCase().includes(q);
    });
  }, [todayBills, reprintSearch, state.customers]);

  const openReprintSale = (sale: Sale) => {
    setReprintOpen(false);
    setDoneSale(sale);
  };

  const sendReprintWhatsApp = (sale: Sale) => {
    const customerPhone = sale.customerId ? state.customers.find(c => c.id === sale.customerId)?.phone || '' : '';
    setReprintWhatsAppSale(sale);
    setReprintWhatsAppPhone(customerPhone);
  };

  const confirmReprintWhatsApp = () => {
    if (!reprintWhatsAppSale) return;
    const digits = normalizeWhatsAppPhone(reprintWhatsAppPhone);
    if (digits.length < 9 || digits.length > 15) return;
    openWhatsAppLink(digits, buildWhatsAppText(reprintWhatsAppSale, state.settings));
    setReprintWhatsAppSale(null);
    setReprintWhatsAppPhone('');
  };

  const payState: 'idle' | 'short' | 'exact' | 'change' | 'due' =
    total <= 0 ? 'idle'
      : intentionalCredit ? 'due'
      : !hasCredit && shortage > 0.009 ? 'short'
      : change > 0.009 ? 'change'
      : 'exact';

  // A preview only: the authoritative invoice number is returned by the
  // cloud/local sale transaction after SAVE. This keeps the terminal clear
  // without pretending a multi-machine cloud sequence is already reserved.
  const maxBillSeq = state.sales.reduce((m, s) => {
    const n = parseInt(s.billNo.split('-').pop() || '0', 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  const nextBillSeq = Math.max(state.counters.bill || 1, maxBillSeq + 1);
  const nextBillPreview = `NFX-${dkey(new Date()).replaceAll('-', '')}-${String(nextBillSeq).slice(-4).padStart(4, '0')}`;

  return (
    <div className="pb-24">

      {/* ============ CENTER: Billing (main focus) ============ */}
      <section
        ref={billingRef}
        id="billing"
        className="card mx-auto w-full max-w-[1060px] overflow-hidden shadow-[0_30px_80px_-24px_rgba(109,40,217,0.35)] !border-violet-200/80 dark:!border-violet-500/25"
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 bg-gradient-to-r from-violet-600 via-indigo-600 to-violet-600 text-white">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center backdrop-blur">
              <ReceiptText size={18} />
            </span>
            <div>
              <div className="font-display font-extrabold text-[16px] tracking-wide">BILLING</div>
              <div className="text-[11px] text-violet-200 num">{itemCount} items · {detailed.length} lines</div>
            </div>
          </div>
          <div className="flex items-center gap-2 min-w-0 max-w-[72%] overflow-x-auto no-scrollbar">
            <button className="btn shrink-0 !py-2 !px-3 bg-white text-violet-700 hover:bg-violet-50 !text-xs font-extrabold shadow-sm" onClick={hold} disabled={lines.length === 0} title="Hold sale (F5)">
              <PauseCircle size={14} /> HOLD <span className="hidden sm:inline">F5</span>
            </button>
            <button className="btn !py-2 !px-3 bg-white/15 text-white hover:bg-white/25 !text-xs" onClick={() => navigate('/exchanges')} title="Start a return / exchange">
              <ArrowLeftRight size={14} /> <span className="hidden sm:inline">Return</span>
            </button>
            <button className={`btn !py-2 !px-3 !text-xs ${state.held.length ? 'bg-amber-400/90 text-amber-950 hover:bg-amber-300' : 'bg-white/15 text-white hover:bg-white/25'}`} onClick={() => setHeldOpen(true)}>
              <History size={14} /> Held <span className="num bg-black/15 rounded-full px-1.5">{state.held.length}</span>
            </button>
            <button className="btn !py-2 !px-3 bg-white/15 text-white hover:bg-white/25 !text-xs" onClick={() => { setReverseSale(null); setReverseReason(''); setReverseOpen(true); }} title="Request admin approval to reverse a bill">
              <ShieldCheck size={14} /> <span className="hidden sm:inline">REVERSE</span>
            </button>
            <button className="btn !py-2 !px-3 bg-white/15 text-white hover:bg-white/25 !text-xs" onClick={() => setDrawerOpen(true)}>
              <Landmark size={14} /> <span className="hidden sm:inline">Drawer</span>
            </button>
            <button
              className="btn !py-2 !px-3 bg-white/15 text-white hover:bg-white/25 !text-xs disabled:opacity-40"
              onClick={() => {
                if (lines.length === 0) {
                  setCustomerId('');
                  setCustQuery('');
                  focusSearch();
                  return;
                }
                if (window.confirm('Clear the current bill and return to Walk-in customer?')) {
                  reset();
                  setTimeout(focusSearch, 80);
                }
              }}
              disabled={lines.length === 0 && !customerId}
              title="Clear bill (F8)"
            >
              <Trash2 size={14} /> CLEAR <span className="hidden sm:inline">F8</span>
            </button>
            <button
              className="btn !py-2 !px-3 bg-white/15 text-white hover:bg-white/25 !text-xs disabled:opacity-40"
              onClick={() => {
                if (todayBills.length) { setReprintSearch(''); setReprintOpen(true); }
                else toast('No completed bills were found for today', 'rose');
              }}
              disabled={!todayBills.length}
              title="Choose any completed bill from today to print or send"
            >
              <Printer size={14} /> REPRINT
            </button>
          </div>
        </div>

        <POSBillSummary
          nextBillPreview={nextBillPreview}
          customerName={customer?.name || 'Walk-in Customer'}
          customerPhone={customer?.phone || billingWhatsApp || '—'}
          creditBalance={customer?.creditBalance || 0}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] items-start">
          {/* ---- LEFT: customer + cart ---- */}
          <div className="min-w-0">
            {/* A. customer — compact, separate from item search */}
            <div className="px-5 sm:px-6 pt-3 pb-3 border-b border-line bg-raised/20">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[10px] font-extrabold tracking-[0.14em] uppercase text-faint flex items-center gap-1.5"><UserRound size={11} /> Customer</span>
                {!customer && <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">Walk-in customer</span>}
              </div>
              {customer ? (
                <div className="rounded-xl bg-violet-500/[0.07] border border-violet-500/20 p-3">
                  <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white flex items-center justify-center font-bold shrink-0">
                      {customer.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-bold text-ink truncate">{customer.name}</div>
                      <div className="text-[11px] text-sub num">{customer.phone}</div>
                    </div>
                    <Badge tone="amber" className="num shrink-0"><Coins size={11} /> {customer.loyaltyPoints} pts</Badge>
                    <button className="icon-btn !w-7 !h-7" onClick={() => { setCustomerId(''); setRedeemOn(false); setPoints(''); setCustQuery(''); }} title="Change customer">
                      <X size={13} />
                    </button>
                  </div>
                  {customer.creditBalance > 0 && (
                    <div className="flex items-center justify-between mt-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2">
                      <span className="text-[10.5px] font-extrabold tracking-wide text-rose-500 flex items-center gap-1.5">
                        <BadgeDollarSign size={12} /> OUTSTANDING BALANCE
                      </span>
                      <span className="num text-[13px] font-extrabold text-rose-500">{fmtRs(customer.creditBalance)}</span>
    
                  {customerLastPurchases.length > 0 && (
                    <div className="mt-3 rounded-lg border border-line bg-raised/50 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold uppercase tracking-wider text-sub mb-1.5">Last purchases</div>
                      <div className="space-y-1">
                        {customerLastPurchases.map(s => <div key={s.id} className="flex items-center justify-between gap-3 text-[11px]"><span className="text-sub truncate">{s.billNo} · {s.items.slice(0, 2).map(x => x.name).join(', ')}{s.items.length > 2 ? '…' : ''}</span><span className="num font-semibold text-ink shrink-0">{fmtRs(s.total, false)}</span></div>)}
                      </div>
                    </div>
                  )}
                </div>
                  )}
                </div>
              ) : (
                <div ref={custBoxRef} className="relative">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
                      <input
                        ref={custInputRef}
                        className="input pl-9 pr-8 !py-2.5"
                        inputMode="tel"
                        autoComplete="off"
                        placeholder="Search customer by name or phone... (F2)"
                        value={custQuery}
                        onFocus={() => setCustOpen(true)}
                        onChange={e => { setCustQuery(e.target.value); setCustOpen(true); }}
                      />
                      <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
                    </div>
                    <button
                      className="btn btn-soft !border-emerald-300/60 !text-emerald-600 dark:!text-emerald-400 hover:!bg-emerald-500/10 shrink-0"
                      onClick={() => {
                        const digits = normalizeWhatsAppPhone(custQuery);
                        setNewCust(nc => ({
                          ...nc,
                          phone: digits.length >= 9 ? custQuery.trim() : nc.phone,
                          name: nc.name || '',
                        }));
                        setAddCustOpen(true);
                      }}
                    >
                      <UserPlus size={15} /> <span className="hidden sm:inline">Add New Customer</span>
                    </button>
                  </div>

                  <AnimatePresence>
                    {custOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.14 }}
                        className="absolute left-0 right-0 top-full mt-1.5 z-30 card !rounded-xl overflow-hidden shadow-xl"
                      >
                        <button
                          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raised/60 transition-colors border-b border-line"
                          onClick={() => { setCustomerId(''); setCustOpen(false); setCustQuery(''); }}
                        >
                          <span className="w-8 h-8 rounded-full bg-raised flex items-center justify-center text-sub"><UserRound size={15} /></span>
                          <span>
                            <span className="block text-[13px] font-bold text-ink">Walk-in customer</span>
                            <span className="block text-[10.5px] text-faint">No profile · quick sale</span>
                          </span>
                          <span className="ml-auto"><CheckCircle2 size={15} className="text-emerald-500" /></span>
                        </button>
                        <div className="max-h-56 overflow-y-auto">
                          {custResults.map(c => (
                            <button
                              key={c.id}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raised/60 transition-colors"
                              onClick={() => { setCustomerId(c.id); setCustOpen(false); setCustQuery(''); }}
                            >
                              <span className="w-8 h-8 rounded-full bg-violet-500/12 text-violet-500 flex items-center justify-center text-xs font-bold border border-violet-500/20">
                                {c.name.charAt(0).toUpperCase()}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[13px] font-semibold text-ink truncate">{c.name}{c.nic ? <span className="text-faint font-normal"> · {c.nic}</span> : ''}</span>
                                <span className="block text-[10.5px] text-faint num">{c.phone}</span>
                              </span>
                              {c.creditBalance > 0 && (
                                <Badge tone="rose" className="num !text-[9px] shrink-0">owes {fmtRs(c.creditBalance, false)}</Badge>
                              )}
                              {c.loyaltyPoints > 0 && <Badge tone="amber" className="num !text-[9px] shrink-0">{c.loyaltyPoints} pts</Badge>}
                            </button>
                          ))}
                          {custResults.length === 0 && (
                            <div className="px-4 py-4 text-center">
                              <p className="text-xs text-faint">No customer found for “{custQuery}”</p>
                              <button
                                className="btn btn-soft !text-xs mt-2.5"
                                onClick={() => {
                                  const digits = normalizeWhatsAppPhone(custQuery);
                                  setNewCust(nc => ({
                                    ...nc,
                                    name: digits ? 'Walk-in Customer' : custQuery.trim(),
                                    phone: digits ? custQuery.trim() : nc.phone,
                                  }));
                                  setAddCustOpen(true);
                                  setCustOpen(false);
                                }}
                              >
                                <UserPlus size={13} /> Add this number as customer
                              </button>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {recentCustomers.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                      <span className="text-[9.5px] font-bold tracking-wider uppercase text-faint">Recent</span>
                      {recentCustomers.map(c => (
                        <button
                          key={c.id}
                          onClick={() => setCustomerId(c.id)}
                          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-sub bg-raised border border-line rounded-full pl-0.5 pr-2.5 py-0.5 hover:border-violet-400 hover:text-violet-500 transition-colors"
                        >
                          <span className="w-[18px] h-[18px] rounded-full bg-violet-500/15 text-violet-500 flex items-center justify-center text-[9px] font-bold">
                            {c.name.charAt(0).toUpperCase()}
                          </span>
                          {c.name.split(' ')[0]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <POSSalesmanNoteControls
                staff={activeStaff}
                salesmanId={salesmanId}
                note={note}
                noteOpen={noteOpen}
                onSalesmanChange={setSalesmanId}
                onToggleNote={() => setNoteOpen(open => !open)}
                onNoteChange={setNote}
              />
            </div>

            {/* B. HERO ITEM SEARCH — primary cashier entry point */}
            <div className="px-5 sm:px-6 pt-4 pb-3 border-b border-line bg-gradient-to-b from-violet-500/[0.035] to-transparent">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-[10px] font-extrabold tracking-[0.14em] uppercase text-violet-500">Add item</div>
                  <div className="text-[12px] font-semibold text-sub">Fast barcode / SKU / product / IMEI search</div>
                </div>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-lg bg-raised border border-line px-2 py-1 text-[9.5px] font-bold text-faint">
                  <Keyboard size={10} /> F3
                </span>
              </div>
              <div ref={searchBoxRef} className="relative">
                <div className="relative">
                  <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-violet-500 pointer-events-none" />
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Scan barcode, SKU, name or IMEI…"
                    className="w-full !pl-11 !pr-4 !py-3.5 !text-[15px] !rounded-xl !border-violet-300/70 dark:!border-violet-500/30 !bg-surface shadow-[0_8px_28px_-16px_rgba(124,58,237,.5)]"
                  />
                </div>
                <AnimatePresence>
                  {itemSuggestions.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                      className="absolute left-0 right-0 top-full mt-1.5 z-40 card !rounded-xl overflow-hidden shadow-2xl"
                    >
                      {itemUnitSuggestion && (() => {
                        const p = products.find(x => x.id === itemUnitSuggestion.productId);
                        if (!p) return null;
                        return (
                          <button className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left bg-amber-500/[0.06] hover:bg-amber-500/[0.1] border-b border-line"
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => { addUnitToCart(itemUnitSuggestion.productId, itemUnitSuggestion.id); setSearch(''); setTimeout(focusSearch, 0); }}>
                            <span className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0"><Smartphone size={14} /></span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[12px] font-bold text-ink truncate">{p.name} · IMEI / Serial</span>
                              <span className="block text-[10px] text-faint num">{itemUnitSuggestion.imei || itemUnitSuggestion.serial} · Unit available</span>
                            </span>
                            <span className="text-[10px] font-extrabold text-amber-600">ADD UNIT</span>
                          </button>
                        );
                      })()}
                      {itemSuggestions.map(p => {
                        const Icon = CAT_ICON[p.category] || Package;
                        const inCart = lines.find(l => l.productId === p.id)?.qty || 0;
                        return (
                          <button
                            key={p.id}
                            className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-raised/70 border-b border-line last:border-b-0"
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => { add(p.id); setSearch(''); setTimeout(focusSearch, 0); }}
                          >
                            <span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center shrink-0"><Icon size={14} /></span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[12px] font-bold text-ink truncate">{p.name}</span>
                              <span className="block text-[10px] text-faint num">{p.sku} · {p.barcode || 'No barcode'} · {p.stock} in stock</span>
                            </span>
                            {inCart > 0 && <span className="num text-[10px] font-bold text-violet-500">×{inCart}</span>}
                            <span className="num text-[12px] font-extrabold text-violet-600 dark:text-violet-400">{fmtRs(p.price, false)}</span>
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* C. cart items */}
            <div className="hidden md:grid grid-cols-[minmax(0,1fr)_92px_104px_86px_38px] gap-3 items-center px-5 sm:px-6 py-2 bg-violet-500/[0.055] border-b border-line text-[9.5px] font-extrabold uppercase tracking-wider text-faint">
              <span>Item / code · price</span>
              <span className="text-center">Qty</span>
              <span className="text-right">Discount</span>
              <span className="text-right">Amount</span>
              <span className="text-center">Action</span>
            </div>
            <div className="min-h-[190px] max-h-[400px] overflow-y-auto">
              {detailed.length === 0 ? (
                <div className="flex flex-col items-center py-12 text-center px-6">
                  <div className="relative w-24 h-24 mb-4">
                    <span className="absolute inset-0 rounded-[1.6rem] bg-gradient-to-br from-violet-500/12 to-indigo-500/12 border border-violet-500/15" />
                    <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-amber-400/20 border border-amber-400/30" />
                    <span className="absolute -bottom-1.5 -left-2.5 w-5 h-5 rounded-full bg-sky-400/20 border border-sky-400/30" />
                    <span className="absolute inset-0 flex items-center justify-center text-violet-400"><ShoppingBag size={36} strokeWidth={1.5} /></span>
                  </div>
                  <p className="font-bold text-ink">Ready to bill</p>
                  <p className="text-xs text-faint mt-1">Scan a barcode, press <b className="text-sub">F3</b> to search, or tap products below</p>
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {detailed.map(l => (
                    <CartLine
                      key={l.productId}
                      line={l}
                      unitPrice={linePrice(l)}
                      canDiscount={can('act:discount')}
                      canEditPrice={user?.role === 'admin' || priceUnlocked}
                      onAskUnlock={() => { setGateOpen(true); setGatePin(''); setGateErr(''); }}
                      onQty={q => setQty(l.productId, q)}
                      onDisc={d => setLineDisc(l.productId, d)}
                      onPrice={v => setLinePrice(l.productId, v)}
                      onRemove={() => setLines(ls => ls.filter(x => x.productId !== l.productId))}
                    />
                  ))}
                </AnimatePresence>
              )}
            </div>

            <POSAccessorySuggestions items={bundleSuggestions} onAdd={id => add(id)} />

            {/* keyboard hints */}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-5 sm:px-6 py-3 border-t border-line text-[10px] text-faint font-medium">
              <Keyboard size={11} className="text-faint" />
              <span><POSKeyboardHint>F2</POSKeyboardHint> Customer</span>
              <span><POSKeyboardHint>F3</POSKeyboardHint> Search</span>
              <span><POSKeyboardHint>F4</POSKeyboardHint> Discount</span>
              <span><POSKeyboardHint>F5</POSKeyboardHint> Hold</span>
              <span><POSKeyboardHint>F6</POSKeyboardHint> Complete</span>
              <span><POSKeyboardHint>F8</POSKeyboardHint> Clear</span>
            </div>
          </div>

          {/* ---- RIGHT: calculation & payment ---- */}
          <div className="min-w-0 p-5 sm:p-6 space-y-2 border-t lg:border-t-0 lg:border-l border-line bg-raised/30 lg:sticky lg:top-4 lg:self-start">
            <Row label={`Subtotal (${itemCount} items)`} value={fmtRs(baseAfterLines)} />

            {/* discount with Rs / % toggle */}
            <POSDiscountControl
              mode={discMode}
              discount={discount}
              calculatedDiscount={discCart}
              canDiscount={can('act:discount')}
              inputRef={discRef}
              onModeChange={setDiscMode}
              onDiscountChange={setDiscount}
            />
            {promoDiscount > 0 && <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-sub">Promotion <span className="text-emerald-600 dark:text-emerald-400 text-[10.5px]">(active)</span></span>
              <span className="w-24 text-right num text-[12.5px] font-semibold text-emerald-600 dark:text-emerald-400">- {fmtRs(promoDiscount, false)}</span>
            </div>}

            {/* tax */}
            <POSTaxControl
              defaultRate={state.settings.taxDefault}
              taxRate={taxPct}
              calculatedTax={tax}
              onTaxRateChange={setTaxPct}
            />

            <POSServiceDeliveryCharge
              open={shipOpen}
              amount={shipping}
              calculatedAmount={shipAmt}
              onOpen={() => setShipOpen(true)}
              onClose={() => { setShipOpen(false); setShipping(''); }}
              onAmountChange={setShipping}
            />

            {tradeInOpen && tradeInValue > 0 && <div className="flex items-center justify-between gap-3 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/20 px-2.5 py-2">
              <span className="text-[12.5px] text-sub">Trade-in credit</span>
              <span className="num text-[12.5px] font-bold text-emerald-600 dark:text-emerald-400">- {fmtRs(tradeInValue, false)}</span>
            </div>}

            {customer && customer.creditBalance > 0.009 && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-2.5 flex items-center justify-between gap-3">
                <div><div className="text-[11px] font-bold text-amber-600">Existing credit balance</div><div className="num text-sm font-extrabold">{fmtRs(customer.creditBalance)}</div></div>
                <button className="btn btn-soft !px-3 !py-2 !text-xs !text-amber-600" onClick={() => navigate(`/credit-settle?customer=${encodeURIComponent(customer.id)}`)}>Settle credit</button>
              </div>
            )}

            <POSLoyaltyRedeemPanel
              customer={customer}
              enabled={redeemOn}
              points={points}
              maxRedeem={maxRedeem}
              redeemedPoints={redeemedPts}
              pointsValue={pointsVal}
              pointValue={loyaltyPointValue}
              onToggle={() => { setRedeemOn(r => !r); if (redeemOn) setPoints(''); }}
              onPointsChange={value => setPoints(value.replace(/\D/g, ''))}
              onSetMax={() => setPoints(String(maxRedeem))}
            />

            <POSTradeInEntry
              open={tradeInOpen}
              productId={tradeIn.productId}
              imei={tradeIn.imei}
              serial={tradeIn.serial}
              value={tradeIn.value}
              addToInventory={tradeIn.addToInventory}
              products={products.filter(product => product.trackImei || product.trackSerial)}
              onOpen={() => setTradeInOpen(true)}
              onClose={() => { setTradeInOpen(false); setTradeIn({ productId: '', imei: '', serial: '', value: '', addToInventory: true }); }}
              onProductChange={productId => setTradeIn(v => ({ ...v, productId }))}
              onImeiChange={imei => setTradeIn(v => ({ ...v, imei }))}
              onSerialChange={serial => setTradeIn(v => ({ ...v, serial }))}
              onValueChange={value => setTradeIn(v => ({ ...v, value: value.replace(/[^\d.]/g, '') }))}
              onAddToInventoryChange={addToInventory => setTradeIn(v => ({ ...v, addToInventory }))}
            />

            {/* full amount before payment */}
            <div className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11.5px] font-bold text-sub">Full Amount</span>
                <span className="num text-[15px] font-extrabold text-ink">{fmtRs(preTotal)}</span>
              </div>
              {pointsVal > 0 && (
                <div className="flex items-center justify-between mt-1 text-[10.5px]">
                  <span className="text-amber-600 dark:text-amber-400">Loyalty points applied</span>
                  <span className="num font-bold text-amber-600 dark:text-amber-400">− {fmtRs(pointsVal, false)}</span>
                </div>
              )}
            </div>

            {/* grand total */}
            <div className="!mt-3.5 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-4 flex items-end justify-between shadow-lg shadow-violet-600/30">
              <div className="text-white">
                <div className="text-[10px] font-extrabold tracking-[0.16em] text-violet-200 uppercase">Grand Total</div>
                {pointsVal > 0 && <div className="text-[10px] text-amber-300 num font-semibold mt-0.5">points applied: −{fmtRs(pointsVal)}</div>}
                <div className="text-[10px] text-violet-200 mt-0.5">incl. tax &amp; charges</div>
              </div>
              <div className="num text-[32px] leading-none font-extrabold text-white drop-shadow-sm">{fmtRs(total)}</div>
            </div>

            <POSPaymentMethodSelector
              methods={PAYMENTS}
              splitMethods={SPLIT_METHODS}
              payment={payment}
              splitOn={splitOn}
              legs={legs}
              canCreditSale={can('act:creditSale')}
              coverageLabel={Math.abs(total - legSum) < 0.01 ? 'Fully covered' : legSum > total ? `${fmtRs(legSum - total)} over (change)` : `${fmtRs(total - legSum)} remaining`}
              coverageClassName={Math.abs(total - legSum) < 0.01 ? 'text-emerald-500' : legSum > total ? 'text-sky-500' : 'text-amber-500'}
              formatAmount={amount => fmtMoneyInput(String(amount))}
              onPaymentSelect={method => {
                setPayment(method);
                if (method === 'credit') { setPaidAuto(false); setPaid(''); }
                else { setPaidAuto(true); setPaid(total > 0 ? String(total) : ''); }
              }}
              onToggleSplit={() => { setSplitOn(value => !value); if (!splitOn) setLegs([{ method: 'cash', amount: total }]); }}
              onLegMethodChange={(index, method) => setLegs(current => current.map((leg, i) => i === index ? { ...leg, method } : leg))}
              onLegAmountChange={(index, value) => setLegs(current => current.map((leg, i) => i === index ? { ...leg, amount: parseFloat(value.replace(/[^\d.]/g, '')) || 0 } : leg))}
              onRemoveLeg={index => setLegs(current => current.filter((_, i) => i !== index))}
              onAddPayment={() => setLegs(current => [...current, { method: 'card', amount: Math.max(0, total - legSum) }])}
            />

            {splitOn && hasCredit && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-[9px] uppercase tracking-wide text-faint">Total</div><div className="font-extrabold num text-xs">{fmtRs(total)}</div></div>
                <div><div className="text-[9px] uppercase tracking-wide text-faint">Received now</div><div className="font-extrabold num text-xs text-emerald-600">{fmtRs(Math.min(total, Math.max(0, paidNum)))}</div></div>
                <div><div className="text-[9px] uppercase tracking-wide text-faint">Balance on credit</div><div className="font-extrabold num text-xs text-amber-600">{fmtRs(creditDue)}</div></div>
              </div>
            )}

            {/* amount paid */}
            {!splitOn && (
              <div>
                <span className="block text-[10px] font-bold tracking-wider uppercase text-faint mb-1.5">
                  {hasCredit ? 'Amount received now (partial credit)' : 'Amount paid'}
                </span>
                <input
                  className="input num !text-xl !font-extrabold !py-2.5 text-right"
                  value={fmtMoneyInput(paid)}
                  onChange={e => { setPaid(e.target.value.replace(/[^\d.]/g, '')); setPaidAuto(false); }}
                  placeholder="0.00" inputMode="decimal"
                  onKeyDown={e => { if (e.key === 'Enter') finish(); }}
                />
                {hasCredit && (
                  <div className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div><div className="text-[9px] uppercase tracking-wide text-faint">Total</div><div className="font-extrabold num text-xs">{fmtRs(total)}</div></div>
                      <div><div className="text-[9px] uppercase tracking-wide text-faint">Received now</div><div className="font-extrabold num text-xs text-emerald-600">{fmtRs(Math.min(total, Math.max(0, paidNum)))}</div></div>
                      <div><div className="text-[9px] uppercase tracking-wide text-faint">Balance on credit</div><div className="font-extrabold num text-xs text-amber-600">{fmtRs(creditDue)}</div></div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <label htmlFor="credit-tender-method" className="text-sub font-semibold">Received by</label>
                      <select id="credit-tender-method" className="input !py-1 !w-auto" value={creditTender} onChange={e => setCreditTender(e.target.value as Exclude<PaymentMethod, 'credit'>)}>
                        {SPLIT_METHODS.map(method => <option key={method.key} value={method.key}>{method.label}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" className="btn btn-soft flex-1 !py-1.5 !text-[11px]" onClick={() => { setPaid('0'); setPaidAuto(false); }}>Full credit (received 0)</button>
                      <button type="button" className="btn btn-soft flex-1 !py-1.5 !text-[11px]" onClick={() => { setPaid(String(total)); setPaidAuto(false); }}>Received = total</button>
                    </div>
                    {customer && <div className="text-[11px] text-sub">Existing customer credit: <b className="num">{fmtRs(customer.creditBalance)}</b>{customer.creditLimit && customer.creditLimit > 0 ? <> · Limit <b className="num">{fmtRs(customer.creditLimit)}</b> · Remaining <b className="num">{fmtRs(Math.max(0, customer.creditLimit - customer.creditBalance))}</b></> : null}</div>}
                    {intentionalCredit && customer?.creditLimit && customer.creditLimit > 0 && customer.creditBalance + creditDue > customer.creditLimit && <div role="alert" className="text-[11px] font-bold text-rose-500">This bill would exceed the customer's credit limit.</div>}
                  </div>
                )}
              </div>
            )}

            <POSCheckoutWhatsAppField
              value={billingWhatsApp}
              customerMatched={Boolean(billingWhatsAppCustomer)}
              onChange={value => {
                setBillingWhatsApp(value);
                const digits = normalizeWhatsAppPhone(value);
                const match = digits.length >= 9
                  ? state.customers.find(c => normalizeWhatsAppPhone(c.phone) === digits)
                  : undefined;
                if (match) {
                  setCustomerId(match.id);
                  setCustQuery(match.phone);
                } else if (customerId) {
                  setCustomerId('');
                  setCustQuery('');
                }
              }}
            />

            {/* change / balance due */}
            <AnimatePresence mode="wait">
              {total > 0 && (
                <motion.div
                  key={payState}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className={`flex justify-between items-center rounded-xl px-4 py-3 border ${
                    payState === 'change'
                      ? 'bg-emerald-500/10 border-emerald-500/30'
                      : payState === 'exact'
                        ? 'bg-sky-500/10 border-sky-500/30'
                        : payState === 'due' || payState === 'short'
                          ? 'bg-rose-500/10 border-rose-500/30'
                          : 'bg-raised border-line'
                  }`}
                >
                  <span className={`text-[11px] font-extrabold tracking-wide ${
                    payState === 'change' ? 'text-emerald-600 dark:text-emerald-400'
                    : payState === 'exact' ? 'text-sky-600 dark:text-sky-400'
                    : payState === 'due' || payState === 'short' ? 'text-rose-500'
                    : 'text-faint'
                  }`}>
                    {payState === 'change' && 'CHANGE TO GIVE'}
                    {payState === 'exact' && (paidNum > 0 ? 'EXACT AMOUNT' : 'AWAITING PAYMENT')}
                    {payState === 'due' && 'BALANCE DUE (CREDIT)'}
                    {payState === 'short' && 'SHORT OF TOTAL'}
                    {payState === 'idle' && 'AWAITING PAYMENT'}
                  </span>
                  <span className={`num text-[17px] font-extrabold ${
                    payState === 'change' ? 'text-emerald-600 dark:text-emerald-400'
                    : payState === 'exact' ? 'text-sky-600 dark:text-sky-400'
                    : payState === 'due' || payState === 'short' ? 'text-rose-500'
                    : 'text-faint'
                  }`}>
                    {payState === 'change' && fmtRs(change)}
                    {payState === 'exact' && (paidNum > 0 ? fmtRs(0) : fmtRs(total))}
                    {(payState === 'due' || payState === 'short') && fmtRs(shortage)}
                    {payState === 'idle' && fmtRs(total)}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            <POSWhatsAppReceiptOptIn
              visible={Boolean(customer?.phone) && !state.settings.whatsappReceipts}
              phone={customer?.phone || ''}
              enabled={waReceipt}
              onToggle={() => setWaReceipt(value => !value)}
            />

            {error && <p className="text-xs font-semibold text-rose-500">{error}</p>}

            {/* D. actions */}
            <div className="grid grid-cols-[auto_1fr] gap-2.5 pt-1.5">
              <button className="btn btn-soft !px-4" onClick={hold} disabled={lines.length === 0} title="Hold sale (F5)">
                <PauseCircle size={15} /> Hold Sale
              </button>
              <button
                className="btn btn-primary !py-4 !text-[16px] !rounded-xl !font-extrabold tracking-wide shadow-xl shadow-violet-600/40"
                onClick={finish}
                disabled={lines.length === 0 || finishingSale}
                title="Complete sale (F6)"
              >
                <Zap size={17} /> {finishingSale ? 'Completing…' : `Complete Sale · ${fmtRs(total)}`}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ============ BELOW: quick add + secondary catalog ============ */}
      <section className="card mx-auto w-full max-w-[1060px] mt-5 p-4 sm:p-5">
        {favorites.length > 0 && (
          <div className="mb-4">
            <span className="flex items-center gap-1.5 text-[10px] font-extrabold tracking-[0.14em] text-faint uppercase mb-2">
              <Star size={11} className="text-amber-500" /> Quick add · frequently sold
            </span>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {favorites.map(({ p }) => {
                const Icon = CAT_ICON[p.category] || Package;
                const tint = CAT_TINT[p.category] || 'from-violet-500 to-indigo-600';
                const inCart = lines.find(l => l.productId === p.id)?.qty || 0;
                return (
                  <button key={p.id} onClick={() => add(p.id)} disabled={inCart >= p.stock}
                    className="flex items-center gap-2 rounded-xl border border-line bg-surface pl-1.5 pr-3 py-1.5 hover:border-violet-400 hover:shadow-md transition-all shrink-0 disabled:opacity-50">
                    <span className={`w-7 h-7 rounded-lg bg-gradient-to-br ${tint} text-white flex items-center justify-center`}><Icon size={13} /></span>
                    <span className="text-left">
                      <span className="block text-[11px] font-bold text-ink leading-tight max-w-[130px] truncate">{p.name}</span>
                      <span className="block text-[10px] text-violet-500 font-bold num">{fmtRs(p.price, false)}</span>
                    </span>
                    {inCart > 0 && <span className="min-w-4.5 w-[18px] h-[18px] rounded-full bg-violet-600 text-white text-[9px] font-bold flex items-center justify-center num">{inCart}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <details className="group">
          <summary className="list-none cursor-pointer flex items-center justify-between gap-3 rounded-xl border border-line bg-raised/45 px-3.5 py-3 hover:border-violet-300 transition-colors">
            <span className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-violet-600/25">
                <Grid3X3 size={16} />
              </span>
              <span>
                <span className="block font-display font-extrabold text-ink text-[14px]">Product Catalog</span>
                <span className="block text-[10.5px] text-faint num">{filtered.length} of {products.length} items · optional browse mode</span>
              </span>
            </span>
            <ChevronDown size={17} className="text-faint transition-transform group-open:rotate-180" />
          </summary>

          <div className="pt-3">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {categories.map(c => (
                <button key={c} onClick={() => setCat(c)}
                  className={`px-3 py-1.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap transition-all border ${cat === c ? 'bg-violet-600 text-white border-violet-600 shadow-md shadow-violet-600/30' : 'bg-raised text-sub border-line hover:text-ink'}`}>
                  {c === 'all' ? 'All' : c}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <span className="w-14 h-14 rounded-2xl bg-raised flex items-center justify-center text-faint mb-3"><Boxes size={24} /></span>
                <p className="font-semibold text-ink text-sm">No products found</p>
                <p className="text-xs text-faint mt-1">Use the main item search above or choose another category</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-2.5 mt-3">
                {filtered.map(p => {
                  const Icon = CAT_ICON[p.category] || Package;
                  const tint = CAT_TINT[p.category] || 'from-violet-500 to-indigo-600';
                  const inCart = lines.find(l => l.productId === p.id)?.qty || 0;
                  const out = p.stock === 0;
                  const low = !out && p.stock <= p.reorderLevel;
                  return (
                    <motion.button key={p.id} layout whileTap={{ scale: 0.97 }} disabled={out || inCart >= p.stock} onClick={() => add(p.id)}
                      className={`relative text-left rounded-xl border p-3 transition-all group ${out ? 'bg-rose-500/[0.04] border-rose-300/60 opacity-70 cursor-not-allowed' : low ? 'bg-surface border-rose-300/80 dark:border-rose-500/40 hover:border-rose-400 hover:shadow-md cursor-pointer' : 'bg-surface border-line hover:border-violet-400 hover:shadow-lg hover:shadow-violet-500/10 cursor-pointer'}`}>
                      <div className="flex items-start justify-between gap-1.5">
                        <span className={`w-8 h-8 rounded-lg bg-gradient-to-br ${tint} text-white flex items-center justify-center shadow-sm shrink-0`}><Icon size={14} strokeWidth={2.1} /></span>
                        <Badge tone={out || low ? 'rose' : 'emerald'} className={`num !text-[9.5px] !px-1.5 !py-0.5 ${low ? 'blink' : ''}`}>{out ? 'OUT' : low ? `${p.stock} LOW` : p.stock}</Badge>
                      </div>
                      <div className={`mt-2.5 text-[12px] font-bold leading-snug line-clamp-2 min-h-[30px] ${out ? 'text-sub line-through' : 'text-ink'}`}>{p.name}</div>
                      <div className="text-[10px] text-faint mt-0.5 num">{p.sku}</div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="num text-[13.5px] font-extrabold text-violet-600 dark:text-violet-400">{fmtRs(p.price, false)}</span>
                        {inCart > 0 && <span className="min-w-5 px-1 h-5 rounded-full bg-violet-600 text-white text-[10px] font-bold flex items-center justify-center num">{inCart}</span>}
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        </details>
      </section>

      {lines.length > 0 && (
        <POSMobileCheckoutBar
          itemCount={itemCount}
          total={total}
          onReviewPay={() => billingRef.current?.scrollIntoView({ behavior: 'smooth' })}
        />
      )}

      <POSToastStack toasts={toasts} />

      {/* admin-approved bill reverse request */}
      <POSBillReversalModal
        open={reverseOpen}
        options={[...state.sales]
          .filter(sale => sale.status === 'completed')
          .sort((a, b) => +new Date(b.date) - +new Date(a.date))
          .slice(0, 20)
          .map(sale => ({ id: sale.id, label: `${sale.billNo} · ${sale.customerName} · ${fmtRs(sale.total)}` }))}
        selectedBill={reverseSale ? {
          id: reverseSale.id,
          billNo: reverseSale.billNo,
          totalLabel: fmtRs(reverseSale.total),
          itemsSummary: reverseSale.items.map(item => item.name + ' ×' + item.qty).join(' · '),
        } : null}
        reason={reverseReason}
        onSelect={id => setReverseSale(state.sales.find(sale => sale.id === id) || null)}
        onReasonChange={setReverseReason}
        onRequest={async () => {
          if (!reverseSale) return;
          const ok = await requestBillReverse(reverseSale.id, reverseReason);
          if (ok) { toast('Reverse request sent · ' + reverseSale.billNo, 'amber'); setReverseOpen(false); setReverseSale(null); setReverseReason(''); }
          else toast('A pending reverse request already exists or the bill is no longer reversible', 'rose');
        }}
        onClose={() => setReverseOpen(false)}
      />
      <POSCashDrawerModal
        open={drawerOpen}
        sub={`Today · ${user?.name}`}
        rows={[
          { label: 'Opening float', value: fmtRs(state.settings.openingFloat), tone: 'text-ink' },
          { label: 'My cash sales today', value: fmtRs(myCash), tone: 'text-emerald-500' },
          { label: 'Expected in drawer', value: fmtRs(expected), tone: 'text-violet-500' },
        ]}
        onClose={() => setDrawerOpen(false)}
      />

      <POSHeldSalesModal
        open={heldOpen}
        items={state.held.map(h => ({
          id: h.id,
          label: h.label,
          detail: `${timeAgo(h.heldAt)} · ${h.lines.length} lines${h.customerId ? ` · ${state.customers.find(c => c.id === h.customerId)?.name || ''}` : ''}`,
        }))}
        onResume={resume}
        onDelete={deleteHold}
        onClose={() => setHeldOpen(false)}
      />

      <POSQuickAddCustomerModal
        open={addCustOpen}
        customer={newCust}
        canAdd={!!newCust.name.trim() && !!newCust.phone.trim()}
        onNameChange={value => setNewCust(c => ({ ...c, name: value }))}
        onPhoneChange={value => setNewCust(c => ({ ...c, phone: value }))}
        onNicChange={value => setNewCust(c => ({ ...c, nic: value }))}
        onAddressChange={value => setNewCust(c => ({ ...c, address: value }))}
        onAdd={quickAddCustomer}
        onClose={() => setAddCustOpen(false)}
      />

      {/* admin gate: price override */}
      <POSPriceOverrideGate
        open={gateOpen}
        pin={gatePin}
        error={gateErr}
        busy={gateBusy}
        showPin={gateShow}
        onPinChange={value => { setGatePin(value); setGateErr(''); }}
        onEnter={tryGate}
        onToggleShow={() => setGateShow(show => !show)}
        onUnlock={tryGate}
        onClose={() => setGateOpen(false)}
      />

      <POSImeiUnitPicker
        open={!!unitPickProductId}
        productName={products.find(p => p.id === unitPickProductId)?.name}
        search={unitPickSearch}
        units={unitPickProductId ? (() => {
          const used = usedUnitIds();
          return (state.units || []).filter(u =>
            u.productId === unitPickProductId &&
            u.status === 'in_stock' &&
            !used.has(u.id) &&
            (!unitPickSearch.trim() ||
              (u.imei || '').includes(unitPickSearch.trim()) ||
              (u.serial || '').toLowerCase().includes(unitPickSearch.trim().toLowerCase())),
          );
        })() : []}
        onSearchChange={setUnitPickSearch}
        onSelect={unitId => { if (unitPickProductId) addUnitToCart(unitPickProductId, unitId); }}
        onClose={() => { setUnitPickProductId(null); setUnitPickSearch(''); }}
      />

      <POSReprintBillsModal
        open={reprintOpen}
        todayBillCount={todayBills.length}
        search={reprintSearch}
        shownCount={reprintBills.length}
        items={reprintBills.map(sale => {
          const customerPhone = sale.customerId ? state.customers.find(customer => customer.id === sale.customerId)?.phone || '' : '';
          const itemCount = sale.items.reduce((count, item) => count + item.qty, 0);
          return {
            id: sale.id,
            billNo: sale.billNo,
            ago: timeAgo(sale.date),
            customerName: sale.customerName,
            itemCount,
            totalLabel: fmtRs(sale.total),
            hasCustomerPhone: !!customerPhone,
          };
        })}
        onSearchChange={setReprintSearch}
        onPrint={id => {
          const sale = reprintBills.find(item => item.id === id);
          if (sale) openReprintSale(sale);
        }}
        onWhatsApp={id => {
          const sale = reprintBills.find(item => item.id === id);
          if (sale) sendReprintWhatsApp(sale);
        }}
        onClose={() => setReprintOpen(false)}
      />

      <POSReprintWhatsAppModal
        open={!!reprintWhatsAppSale}
        billNo={reprintWhatsAppSale?.billNo || ''}
        phone={reprintWhatsAppPhone}
        canSend={normalizeWhatsAppPhone(reprintWhatsAppPhone).length >= 9 && normalizeWhatsAppPhone(reprintWhatsAppPhone).length <= 15}
        onPhoneChange={setReprintWhatsAppPhone}
        onClose={() => { setReprintWhatsAppSale(null); setReprintWhatsAppPhone(''); }}
        onConfirm={confirmReprintWhatsApp}
      />

      <ReceiptModal sale={doneSale} preferredWhatsAppPhone={doneSaleWhatsApp} onClose={() => { setDoneSale(null); setDoneSaleWhatsApp(''); setTimeout(focusSearch, 120); }} />
    </div>
  );
}

/* ---------- calc row ---------- */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-[12.5px]">
      <span className="text-sub">{label}</span>
      <span className="num font-semibold text-ink">{value}</span>
    </div>
  );
}


