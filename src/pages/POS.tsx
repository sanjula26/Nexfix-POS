import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Package, Plus, Minus, Trash2, PauseCircle, Landmark,
  CreditCard, Banknote, Smartphone, HandCoins, X, Boxes, History, Zap,
  UserRound, Coins, UserPlus, Search, CheckCircle2, Percent, Truck,
  Split, ReceiptText, ChevronDown, Tag, ShoppingBag, Keyboard, Grid3X3,
  AlertTriangle, Pencil, LockKeyhole, StickyNote, ArrowLeftRight, ShieldCheck,
  Loader2, Eye, EyeOff, Lock, Star, BadgeDollarSign, MessageCircle, Printer,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, Modal, Field } from '../components/ui';
import ReceiptModal, { buildWhatsAppText } from '../components/ReceiptModal';
import { fmtRs, dkey, timeAgo, uid, salePayments, waLink, normalizeWhatsAppPhone } from '../lib/utils';
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
  const [waReceipt, setWaReceipt] = useState(false);
  const [paid, setPaid] = useState('');
  const [paidAuto, setPaidAuto] = useState(false);
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
  const hasCredit = !splitOn && payment === 'credit';
  const change = hasCredit ? 0 : Math.max(0, paidNum - total);
  const shortage = Math.max(0, total - paidNum);
  const itemCount = detailed.reduce((s, l) => s + l.qty, 0);

  /* keep cashless tenders pinned to the total unless the cashier overrode it */
  useEffect(() => {
    if (!splitOn && payment !== 'cash' && payment !== 'credit' && paidAuto) {
      setPaid(total > 0 ? String(total) : '');
    }
  }, [total, payment, splitOn, paidAuto]);

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
      setLines(ls => ls.map(l => l.productId === productId
        ? { ...l, qty: l.qty + 1, unitIds: [...(l.unitIds || []), unitId] }
        : l));
    } else {
      setLines(ls => [...ls, { productId, qty: 1, discount: 0, unitIds: [unitId] }]);
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
      return ex ? ls.map(l => (l.productId === id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { productId: id, qty: 1, discount: 0 }];
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
    setRedeemOn(false); setPoints(''); setPayment('cash'); setPaid(''); setPaidAuto(false);
    setWaReceipt(false);
    setSplitOn(false); setLegs([{ method: 'cash', amount: 0 }]); setError('');
    setNote(''); setNoteOpen(false); setPriceUnlocked(false);
    setSalesmanId(user?.id || '');
  };

  /* ---------- finish ---------- */
  const finish = async () => {
    setError('');
    if (lines.length === 0) return setError('Add at least one item to the cart');
    if ((discCart > 0 || lineDisc > 0) && !can('act:discount')) return setError('Your role cannot apply discounts');
    if (tradeInOpen) {
      const tp = products.find(p => p.id === tradeIn.productId);
      if (!tp) return setError('Select the trade-in device/product');
      if (tradeInValue <= 0) return setError('Enter a valid trade-in value');
      if (tradeIn.addToInventory && (!tp.trackImei && !tp.trackSerial)) return setError('The selected product is not configured for IMEI/Serial inventory');
      if (tradeIn.addToInventory && tp.trackImei && !tradeIn.imei.trim()) return setError('Enter the trade-in IMEI');
      if (tradeIn.addToInventory && tp.trackSerial && !tradeIn.serial.trim()) return setError('Enter the trade-in serial number');
    }
    if (hasCredit && !customerId) return setError('Credit sales need a registered customer');
    if (hasCredit && !can('act:creditSale')) return setError('Your role cannot make credit sales');
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
      if (legs.some(l => l.amount <= 0)) return setError('Enter an amount for every split payment');
      if (legSum < total) return setError(`Split payments are short by ${fmtRs(total - legSum)}`);
    } else if (!hasCredit && paidNum < total) {
      return setError(`Still ${fmtRs(total - paidNum)} short of the total`);
    }
    /* Reserve the WhatsApp tab during the user click so popup blockers do not block it after the async sale completes. */
    const whatsappDigits = normalizeWhatsAppPhone(customer?.phone || billingWhatsApp || custQuery);
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
      customerId: customerId || undefined,
      discount: discCart + promoDiscount,
      tradeIn: tradeInOpen ? { productId: tradeIn.productId, value: tradeInValue, imei: tradeIn.imei.trim() || undefined, serial: tradeIn.serial.trim() || undefined, addToInventory: tradeIn.addToInventory } : undefined,
      taxPct: parseFloat(taxPct) || 0,
      shipping: shipAmt,
      pointsRedeemed: redeemedPts,
      payment,
      amountPaid: paidNum,
      payments: splitOn ? legs : undefined,
      note: note.trim() || undefined,
      salesmanId: salesmanId || undefined,
    });
    } catch {
      if (whatsappWindow) whatsappWindow.close();
      setError('Sale could not be completed. Please try again.');
      return;
    }
    if (sale) {
      setDoneSale(sale);
      /* WhatsApp receipt — navigate the user-approved tab after the sale is confirmed. */
      if (whatsappWindow && whatsappDigits.length >= 9) {
        whatsappWindow.location.href = waLink(whatsappDigits, buildWhatsAppText(sale, state.settings));
      }
      reset();
      setTimeout(focusSearch, 150);
    } else if (whatsappWindow) {
      whatsappWindow.close();
    }
  };

  /* ---------- hold ---------- */
  const hold = () => {
    if (lines.length === 0) return;
    holdSale({
      label: `Held · ${itemCount} item(s)`,
      lines: lines.map(l => ({ productId: l.productId, qty: l.qty })),
      customerId: customerId || undefined,
      discount: discCart, taxPct: parseFloat(taxPct) || 0,
    });
    toast('Sale parked — resume it from Held', 'amber');
    reset();
  };
  const resume = (id: string) => {
    const h = resumeHold(id);
    if (!h) return;
    setLines(h.lines.map(l => ({ ...l, discount: 0 })));
    setCustomerId(h.customerId || '');
    setDiscount(h.discount ? String(h.discount) : '');
    setTaxPct(h.taxPct ? String(h.taxPct) : '');
    setHeldOpen(false);
    billingRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  /* ---------- quick add customer ---------- */
  const quickAddCustomer = () => {
    const name = newCust.name.trim();
    const phone = newCust.phone.trim();
    if (!name || !phone) return;
    const normalized = normalizeWhatsAppPhone(phone);
    if (normalized.length < 9) {
      toast('Enter a valid WhatsApp phone number', 'rose');
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

  const lastCompletedSale = doneSale || state.sales.find(s => s.status === 'completed') || null;

  const payState: 'idle' | 'short' | 'exact' | 'change' | 'due' =
    total <= 0 ? 'idle'
      : hasCredit && shortage > 0.009 ? 'due'
      : !hasCredit && shortage > 0.009 ? 'short'
      : change > 0.009 ? 'change'
      : 'exact';

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
          <div className="flex items-center gap-2">
            <button className="btn !py-2 !px-3 bg-white text-violet-700 hover:bg-violet-50 !text-xs font-extrabold shadow-sm" onClick={hold} disabled={lines.length === 0} title="Hold sale (F5)">
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
                if (lastCompletedSale) setDoneSale(lastCompletedSale);
                else toast('No completed sale is available to reprint', 'rose');
              }}
              disabled={!lastCompletedSale}
              title="Reprint last completed sale"
            >
              <Printer size={14} /> REPRINT
            </button>
          </div>
        </div>

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

              {/* salesman + note row */}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider uppercase text-faint">
                  Salesman
                </span>
                <select
                  className="input !w-auto !py-1.5 !px-2.5 !text-[12px] font-semibold"
                  value={salesmanId}
                  onChange={e => setSalesmanId(e.target.value)}
                >
                  {activeStaff.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <button
                  className={`ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border transition-all ${
                    noteOpen || note ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-raised text-sub border-line hover:text-ink'
                  }`}
                  onClick={() => setNoteOpen(o => !o)}
                >
                  <StickyNote size={12} /> {note ? 'Note added' : 'Bill note'}
                </button>
              </div>
              <AnimatePresence>
                {noteOpen && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <textarea
                      className="input mt-2.5 !text-[12.5px] min-h-[56px] resize-none"
                      placeholder="e.g. Gift packing · Deliver tomorrow after 4 PM"
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      maxLength={160}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
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

            {/* keyboard hints */}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-5 sm:px-6 py-3 border-t border-line text-[10px] text-faint font-medium">
              <Keyboard size={11} className="text-faint" />
              <span><Kbd>F2</Kbd> Customer</span>
              <span><Kbd>F3</Kbd> Search</span>
              <span><Kbd>F4</Kbd> Discount</span>
              <span><Kbd>F5</Kbd> Hold</span>
              <span><Kbd>F6</Kbd> Complete</span>
              <span><Kbd>F8</Kbd> Clear</span>
            </div>
          </div>

          {/* ---- RIGHT: calculation & payment ---- */}
          <div className="min-w-0 p-5 sm:p-6 space-y-2 border-t lg:border-t-0 lg:border-l border-line bg-raised/30 lg:sticky lg:top-4 lg:self-start">
            <Row label={`Subtotal (${itemCount} items)`} value={fmtRs(baseAfterLines)} />

            {/* discount with Rs / % toggle */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-sub flex items-center gap-1.5">
                Discount
                <span className="flex rounded-lg bg-raised border border-line overflow-hidden">
                  {(['rs', 'pct'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setDiscMode(m)}
                      className={`px-2 py-[3px] text-[9.5px] font-extrabold transition-all ${discMode === m ? 'bg-violet-600 text-white' : 'text-faint hover:text-ink'}`}
                    >
                      {m === 'rs' ? 'Rs.' : <Percent size={9} />}
                    </button>
                  ))}
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  ref={discRef}
                  className={`input !w-24 !py-1.5 !px-2.5 num !text-[13px] text-right ${!can('act:discount') ? 'opacity-50 cursor-not-allowed' : ''}`}
                  value={discount}
                  onChange={e => setDiscount(e.target.value.replace(/[^\d.]/g, ''))}
                  placeholder="0" inputMode="decimal" disabled={!can('act:discount')}
                />
                <span className="w-24 text-right num text-[12.5px] font-semibold text-rose-500">{discCart > 0 ? `- ${fmtRs(discCart, false)}` : '—'}</span>
              </div>
            </div>
            {promoDiscount > 0 && <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-sub">Promotion <span className="text-emerald-600 dark:text-emerald-400 text-[10.5px]">(active)</span></span>
              <span className="w-24 text-right num text-[12.5px] font-semibold text-emerald-600 dark:text-emerald-400">- {fmtRs(promoDiscount, false)}</span>
            </div>}

            {/* tax */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-sub">Tax <span className="text-faint text-[10.5px]">(auto {state.settings.taxDefault}%)</span></span>
              <div className="flex items-center gap-1.5">
                <div className="relative">
                  <input
                    className="input !w-24 !py-1.5 !px-2.5 pr-6 num !text-[13px] text-right"
                    value={taxPct} onChange={e => setTaxPct(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="0" inputMode="decimal"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-faint">%</span>
                </div>
                <span className="w-24 text-right num text-[12.5px] font-semibold text-sub">{tax > 0 ? fmtRs(tax, false) : '—'}</span>
              </div>
            </div>

            {/* shipping / other */}
            {shipOpen ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] text-sub flex items-center gap-1.5">
                  <Truck size={12} className="text-faint" /> Delivery / other
                  <button className="text-faint hover:text-rose-500" onClick={() => { setShipOpen(false); setShipping(''); }}><X size={11} /></button>
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    className="input !w-24 !py-1.5 !px-2.5 num !text-[13px] text-right"
                    value={shipping} onChange={e => setShipping(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="0" inputMode="decimal"
                  />
                  <span className="w-24 text-right num text-[12.5px] font-semibold text-sub">{shipAmt > 0 ? fmtRs(shipAmt, false) : '—'}</span>
                </div>
              </div>
            ) : (
              <button className="text-[11.5px] font-semibold text-violet-500 hover:text-violet-600 flex items-center gap-1" onClick={() => setShipOpen(true)}>
                <Plus size={11} /> Add delivery / other charge
              </button>
            )}

            {tradeInOpen && tradeInValue > 0 && <div className="flex items-center justify-between gap-3 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/20 px-2.5 py-2">
              <span className="text-[12.5px] text-sub">Trade-in credit</span>
              <span className="num text-[12.5px] font-bold text-emerald-600 dark:text-emerald-400">- {fmtRs(tradeInValue, false)}</span>
            </div>}

            {/* loyalty redeem */}
            {customer && customer.loyaltyPoints > 0 && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-2.5">
                <div className="flex items-center justify-between">
                  <button className="flex items-center gap-2" onClick={() => { setRedeemOn(r => !r); if (redeemOn) setPoints(''); }}>
                    <span className={`w-[16px] h-[16px] rounded-[4px] border flex items-center justify-center transition-all ${redeemOn ? 'bg-amber-500 border-amber-500 text-white' : 'border-amber-400/50 bg-surface'}`}>
                      {redeemOn && <CheckCircle2 size={11} strokeWidth={3} />}
                    </span>
                    <span className="text-[12px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <Coins size={12} /> Redeem points · {customer.loyaltyPoints} available
                    </span>
                  </button>
                  {redeemOn && (
                    <div className="flex items-center gap-1.5">
                      <input
                        className="input !w-20 !py-1 !px-2 num !text-[12px] text-right"
                        value={points}
                        onChange={e => setPoints(e.target.value.replace(/\D/g, ''))}
                        placeholder={String(maxRedeem)} inputMode="numeric"
                      />
                      <button className="text-[10px] font-bold text-amber-600 dark:text-amber-400" onClick={() => setPoints(String(maxRedeem))}>MAX</button>
                    </div>
                  )}
                </div>
                {redeemOn && redeemedPts > 0 && (
                  <div className="text-right text-[11px] font-bold text-amber-600 dark:text-amber-400 num mt-1">
                    − {fmtRs(pointsVal)} ({redeemedPts} pts × Rs. {loyaltyPointValue})
                  </div>
                )}
              </div>
            )}

            {!tradeInOpen ? (
              <button className="text-[11.5px] font-semibold text-emerald-600 dark:text-emerald-400 hover:opacity-80 flex items-center gap-1" onClick={() => setTradeInOpen(true)}>
                <ArrowLeftRight size={11} /> Add trade-in
              </button>
            ) : (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-2.5 space-y-2">
                <div className="flex items-center justify-between"><span className="text-[12px] font-bold text-emerald-700 dark:text-emerald-400">Trade-in device</span><button className="text-faint hover:text-rose-500" onClick={() => { setTradeInOpen(false); setTradeIn({ productId: '', imei: '', serial: '', value: '', addToInventory: true }); }}><X size={11} /></button></div>
                <select className="input !py-1.5 !text-[12px]" value={tradeIn.productId} onChange={e => setTradeIn(v => ({ ...v, productId: e.target.value }))}>
                  <option value="">Select device/product</option>
                  {products.filter(p => p.trackImei || p.trackSerial).map(p => <option key={p.id} value={p.id}>{p.name} · {p.trackImei && p.trackSerial ? 'IMEI + Serial' : p.trackImei ? 'IMEI' : 'Serial'}</option>)}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input className="input !py-1.5 !text-[12px]" placeholder="IMEI" value={tradeIn.imei} onChange={e => setTradeIn(v => ({ ...v, imei: e.target.value }))} />
                  <input className="input !py-1.5 !text-[12px]" placeholder="Serial" value={tradeIn.serial} onChange={e => setTradeIn(v => ({ ...v, serial: e.target.value }))} />
                </div>
                <div className="flex items-center gap-2">
                  <input className="input !py-1.5 !text-[12px] num flex-1" placeholder="Trade-in value (Rs.)" value={tradeIn.value} onChange={e => setTradeIn(v => ({ ...v, value: e.target.value.replace(/[^\d.]/g, '') }))} inputMode="decimal" />
                  <label className="flex items-center gap-1.5 text-[10.5px] text-sub whitespace-nowrap"><input type="checkbox" checked={tradeIn.addToInventory} onChange={e => setTradeIn(v => ({ ...v, addToInventory: e.target.checked }))} /> Add to inventory</label>
                </div>
                <div className="text-[10px] text-faint">Trade-in value is deducted from this bill. When added to inventory, the device is recorded at the trade-in value.</div>
              </div>
            )}

            {/* grand total */}
            <div className="!mt-3.5 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-4 flex items-end justify-between shadow-lg shadow-violet-600/30">
              <div className="text-white">
                <div className="text-[10px] font-extrabold tracking-[0.16em] text-violet-200 uppercase">Grand Total</div>
                {pointsVal > 0 && <div className="text-[10px] text-amber-300 num font-semibold mt-0.5">points applied: −{fmtRs(pointsVal)}</div>}
                <div className="text-[10px] text-violet-200 mt-0.5">incl. tax &amp; charges</div>
              </div>
              <div className="num text-[32px] leading-none font-extrabold text-white drop-shadow-sm">{fmtRs(total)}</div>
            </div>

            {/* payment methods */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-bold tracking-wider uppercase text-faint">Payment method</span>
                <button
                  onClick={() => { setSplitOn(s => !s); if (!splitOn) setLegs([{ method: 'cash', amount: total }]); }}
                  className={`inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-1 rounded-lg border transition-all ${
                    splitOn ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-raised text-sub border-line hover:text-ink'
                  }`}
                >
                  <Split size={11} /> Split
                </button>
              </div>
              {!splitOn ? (
                <div className="grid grid-cols-5 gap-1.5">
                  {PAYMENTS.map(m => {
                    const disabled = m.key === 'credit' && !can('act:creditSale');
                    return (
                      <button
                        key={m.key}
                        disabled={disabled}
                        onClick={() => {
                          setPayment(m.key);
                          if (m.key === 'cash' || m.key === 'credit') { setPaidAuto(false); setPaid(''); }
                          else { setPaidAuto(true); setPaid(total > 0 ? String(total) : ''); }
                        }}
                        className={`flex flex-col items-center gap-1 rounded-xl py-2 border text-[9.5px] font-bold transition-all ${
                          payment === m.key
                            ? 'bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-500/30'
                            : disabled
                              ? 'bg-raised/50 border-line text-faint opacity-50 cursor-not-allowed'
                              : 'bg-surface border-line text-sub hover:text-ink hover:border-violet-300'
                        }`}
                      >
                        <m.icon size={15} />
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {legs.map((leg, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <select
                        className="input !w-28 !py-1.5 !px-2 !text-[12px]"
                        value={leg.method}
                        onChange={e => setLegs(ls => ls.map((x, xi) => xi === i ? { ...x, method: e.target.value as PaymentMethod } : x))}
                      >
                        {SPLIT_METHODS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                      </select>
                      <input
                        className="input flex-1 !py-1.5 !px-2.5 num !text-[12.5px] text-right"
                        value={leg.amount ? fmtMoneyInput(String(leg.amount)) : ''}
                        onChange={e => setLegs(ls => ls.map((x, xi) => xi === i ? { ...x, amount: parseFloat(e.target.value.replace(/[^\d.]/g, '')) || 0 } : x))}
                        placeholder="Amount" inputMode="decimal"
                      />
                      <button
                        className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500"
                        disabled={legs.length === 1}
                        onClick={() => setLegs(ls => ls.filter((_, xi) => xi !== i))}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <button className="text-[11px] font-bold text-indigo-500 hover:text-indigo-600 flex items-center gap-1" onClick={() => setLegs(ls => [...ls, { method: 'card', amount: Math.max(0, total - legSum) }])}>
                      <Plus size={11} /> Add payment
                    </button>
                    <span className={`text-[11px] font-bold num ${Math.abs(total - legSum) < 0.01 ? 'text-emerald-500' : legSum > total ? 'text-sky-500' : 'text-amber-500'}`}>
                      {Math.abs(total - legSum) < 0.01 ? 'Fully covered' : legSum > total ? `${fmtRs(legSum - total)} over (change)` : `${fmtRs(total - legSum)} remaining`}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* amount paid */}
            {!splitOn && (
              <div>
                <span className="block text-[10px] font-bold tracking-wider uppercase text-faint mb-1.5">
                  {hasCredit ? 'Advance paid (optional)' : 'Amount paid'}
                </span>
                <input
                  className="input num !text-xl !font-extrabold !py-2.5 text-right"
                  value={fmtMoneyInput(paid)}
                  onChange={e => { setPaid(e.target.value.replace(/[^\d.]/g, '')); setPaidAuto(false); }}
                  placeholder="0.00" inputMode="decimal"
                  onKeyDown={e => { if (e.key === 'Enter') finish(); }}
                />
                {payment === 'cash' && total > 0 && (
                  <div className="flex gap-1.5 mt-2">
                    {[500, 1000, 2000, 5000].map(v => (
                      <button
                        key={v}
                        className="btn btn-soft !px-2 !py-1 !text-[11px] flex-1 num"
                        onClick={() => { setPaid(String(total <= v ? v : Math.ceil(total / v) * v)); setPaidAuto(false); }}
                      >
                        {fmtRs(v, false)}
                      </button>
                    ))}
                    <button className="btn btn-soft !px-2 !py-1 !text-[11px] flex-1 text-violet-500 font-bold" onClick={() => { setPaid(String(total)); setPaidAuto(false); }}>Exact</button>
                  </div>
                )}
              </div>
            )}

            {/* billing WhatsApp number — available at checkout near the payment amount */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[10px] font-bold tracking-wider uppercase text-faint">WhatsApp number</span>
                {billingWhatsAppCustomer && (
                  <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    Customer matched
                  </span>
                )}
              </div>
              <input
                className="input num !py-2.5"
                value={billingWhatsApp}
                onChange={e => {
                  const value = e.target.value;
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
                placeholder="+94 77 000 0000"
                inputMode="tel"
                autoComplete="tel"
              />
              <div className="text-[10px] text-faint mt-1">
                Enter the customer's WhatsApp number here for the receipt. Existing customers are matched automatically.
              </div>
            </div>

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

            {/* WhatsApp receipt opt-in */}
            <AnimatePresence>
              {customer?.phone && !state.settings.whatsappReceipts && (
                <motion.button
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  onClick={() => setWaReceipt(w => !w)}
                  className={`w-full flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-all text-left ${
                    waReceipt
                      ? 'bg-emerald-500/10 border-emerald-500/35'
                      : 'bg-surface border-line hover:border-emerald-400/50'
                  }`}
                >
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                    waReceipt ? 'bg-gradient-to-br from-[#25d366] to-[#128c7e] text-white shadow-md' : 'bg-raised text-faint'
                  }`}>
                    <MessageCircle size={15} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-[12px] font-bold ${waReceipt ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink'}`}>
                      Send receipt on WhatsApp
                    </span>
                    <span className="block text-[10px] text-faint num">to {customer.phone} — only when the customer asks</span>
                  </span>
                  <span className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${waReceipt ? 'bg-emerald-500' : 'bg-line'}`}>
                    <span className={`absolute top-[2.5px] w-4 h-4 rounded-full bg-white shadow transition-all ${waReceipt ? 'left-[18px]' : 'left-[2px]'}`} />
                  </span>
                </motion.button>
              )}
            </AnimatePresence>

            {error && <p className="text-xs font-semibold text-rose-500">{error}</p>}

            {/* D. actions */}
            <div className="grid grid-cols-[auto_1fr] gap-2.5 pt-1.5">
              <button className="btn btn-soft !px-4" onClick={hold} disabled={lines.length === 0} title="Hold sale (F5)">
                <PauseCircle size={15} /> Hold Sale
              </button>
              <button
                className="btn btn-primary !py-4 !text-[16px] !rounded-xl !font-extrabold tracking-wide shadow-xl shadow-violet-600/40"
                onClick={finish}
                disabled={lines.length === 0}
                title="Complete sale (F6)"
              >
                <Zap size={17} /> Complete Sale · {fmtRs(total)}
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

      {/* mobile sticky checkout bar */}
      {lines.length > 0 && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/95 backdrop-blur border-t border-line px-4 py-3 flex items-center gap-3 no-print">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-bold tracking-wider uppercase text-faint num">{itemCount} items</div>
            <div className="num text-lg font-extrabold text-violet-600 dark:text-violet-400 leading-none">{fmtRs(total)}</div>
          </div>
          <button className="btn btn-primary !py-3" onClick={() => billingRef.current?.scrollIntoView({ behavior: 'smooth' })}>
            <Zap size={15} /> Review &amp; Pay
          </button>
        </div>
      )}

      {/* toasts */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] space-y-2 no-print">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 shadow-xl text-[12.5px] font-bold text-white ${
                t.tone === 'rose' ? 'bg-rose-500' : 'bg-amber-500'
              }`}
            >
              <AlertTriangle size={14} /> {t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* admin-approved bill reverse request */}
      <Modal open={reverseOpen} onClose={() => setReverseOpen(false)} title="Request bill reversal" sub="A cashier can request; only an admin can approve. The original sale stays in history.">
        <div className="space-y-4">
          <Field label="Recent completed bill">
            <select className="input" value={reverseSale?.id || ''} onChange={e => setReverseSale(state.sales.find(x => x.id === e.target.value) || null)}>
              <option value="">Select a recent bill...</option>
              {[...state.sales].filter(x => x.status === 'completed').sort((a,b) => +new Date(b.date) - +new Date(a.date)).slice(0, 20).map(sale => (
                <option key={sale.id} value={sale.id}>{sale.billNo} · {sale.customerName} · {fmtRs(sale.total)}</option>
              ))}
            </select>
          </Field>
          {reverseSale && (
            <div className="rounded-xl bg-amber-500/[0.07] border border-amber-500/25 p-3 text-sm">
              <div className="font-bold text-ink">{reverseSale.billNo} · {fmtRs(reverseSale.total)}</div>
              <div className="text-xs text-sub mt-1">{reverseSale.items.map(i => i.name + ' ×' + i.qty).join(' · ')}</div>
            </div>
          )}
          <Field label="Reason">
            <textarea className="input min-h-[82px] resize-none" value={reverseReason} onChange={e => setReverseReason(e.target.value)} placeholder="Enter the reason for reversing this bill..." maxLength={240} />
          </Field>
          <div className="rounded-xl bg-raised border border-line px-3 py-2.5 text-[11px] text-sub">Admin approval will restore stock and mark the bill as <b className="text-ink">REVERSED</b>. No sale history is deleted.</div>
          <div className="flex gap-2.5">
            <button className="btn btn-danger-soft flex-1" disabled={!reverseSale || !reverseReason.trim()} onClick={async () => {
              if (!reverseSale) return;
              const ok = await requestBillReverse(reverseSale.id, reverseReason);
              if (ok) { toast('Reverse request sent · ' + reverseSale.billNo, 'amber'); setReverseOpen(false); setReverseSale(null); setReverseReason(''); }
              else toast('A pending reverse request already exists or the bill is no longer reversible', 'rose');
            }}><ShieldCheck size={15} /> Request approval</button>
            <button className="btn btn-soft flex-1" onClick={() => setReverseOpen(false)}>Cancel</button>
          </div>
        </div>
      </Modal>
      {/* drawer modal */}
      <Modal open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Cash drawer" sub={`Today · ${user?.name}`}>
        <div className="space-y-3">
          {[
            ['Opening float', state.settings.openingFloat, 'text-ink'],
            ['My cash sales today', myCash, 'text-emerald-500'],
            ['Expected in drawer', expected, 'text-violet-500'],
          ].map(([l, v, c]) => (
            <div key={l as string} className="flex justify-between items-center rounded-xl bg-raised border border-line px-4 py-3">
              <span className="text-sm text-sub">{l}</span>
              <span className={`num font-bold ${c}`}>{fmtRs(v as number)}</span>
            </div>
          ))}
          <p className="text-[11px] text-faint">Drawer is settled at day end under Cashier Balances (admin only).</p>
          <button className="btn btn-soft w-full" onClick={() => setDrawerOpen(false)}><X size={15} /> Close</button>
        </div>
      </Modal>

      {/* held sales */}
      <Modal open={heldOpen} onClose={() => setHeldOpen(false)} title="Held sales" sub="Resume or discard parked carts">
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {state.held.map(h => (
              <motion.div
                key={h.id}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -18 }}
                className="flex items-center gap-3 rounded-xl bg-raised border border-line px-4 py-3"
              >
                <span className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0"><PauseCircle size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-ink truncate">{h.label}</div>
                  <div className="text-[11px] text-faint">{timeAgo(h.heldAt)} · {h.lines.length} lines{h.customerId ? ` · ${state.customers.find(c => c.id === h.customerId)?.name || ''}` : ''}</div>
                </div>
                <button className="btn btn-soft !py-1.5 !px-3 !text-xs text-emerald-500" onClick={() => resume(h.id)}><Zap size={13} /> Resume</button>
                <button className="btn btn-danger-soft !py-1.5 !px-3 !text-xs" onClick={() => deleteHold(h.id)}><Trash2 size={13} /></button>
              </motion.div>
            ))}
          </AnimatePresence>
          {state.held.length === 0 && <p className="text-sm text-sub text-center py-6">No held sales — press F5 to park the current bill</p>}
        </div>
      </Modal>

      {/* quick add customer */}
      <Modal open={addCustOpen} onClose={() => setAddCustOpen(false)} title="Add New Customer" sub="Saved to your customer book — selected instantly">
        <div className="space-y-4">
          <Field label="Full name">
            <input className="input" value={newCust.name} onChange={e => setNewCust(c => ({ ...c, name: e.target.value }))} placeholder="Customer name" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone / WhatsApp number">
              <input className="input num" value={newCust.phone} onChange={e => setNewCust(c => ({ ...c, phone: e.target.value }))} placeholder="+94 77 000 0000" inputMode="tel" autoComplete="tel" />
            </Field>
            <Field label="NIC (optional)">
              <input className="input num" value={newCust.nic} onChange={e => setNewCust(c => ({ ...c, nic: e.target.value }))} placeholder="ID / NIC" />
            </Field>
          </div>
          <Field label="Address (optional)">
            <textarea
              className="input min-h-[72px] resize-none"
              value={newCust.address}
              onChange={e => setNewCust(c => ({ ...c, address: e.target.value }))}
              placeholder="Customer address"
              maxLength={240}
            />
          </Field>
          <p className="text-[11px] text-faint">New members start with 0 loyalty points and earn 1 pt per Rs. 1,000 spent.</p>
          <div className="flex gap-2.5">
            <button className="btn btn-primary flex-1" onClick={quickAddCustomer} disabled={!newCust.name.trim() || !newCust.phone.trim()}>
              <UserPlus size={15} /> Add &amp; select
            </button>
            <button className="btn btn-soft" onClick={() => setAddCustOpen(false)}>Cancel</button>
          </div>
        </div>
      </Modal>

      {/* admin gate: price override */}
      <Modal open={gateOpen} onClose={() => setGateOpen(false)} title="Admin approval — price override" sub="Selling price changes need the admin password" locked>
        <div className="space-y-3.5">
          <div className="flex items-center gap-3 rounded-xl bg-amber-500/[0.08] border border-amber-500/25 px-3.5 py-3">
            <LockKeyhole size={16} className="text-amber-500 shrink-0" />
            <p className="text-[12px] text-sub">Enter the <b className="text-ink">admin password</b> to unlock price editing for this bill. Attempts are audit-logged.</p>
          </div>
          <div className="relative">
            <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              type={gateShow ? 'text' : 'password'}
              className={`input pl-9 pr-10 !py-2.5 font-mono tracking-widest ${gateErr ? '!border-rose-400' : ''}`}
              placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢"
              value={gatePin}
              autoFocus
              onChange={e => { setGatePin(e.target.value); setGateErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter') tryGate(); }}
            />
            <button type="button" onClick={() => setGateShow(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink">
              {gateShow ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {gateErr && <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-rose-500"><AlertTriangle size={13} /> {gateErr}</p>}
          <div className="flex gap-2.5">
            <button className="btn btn-primary flex-1" onClick={tryGate} disabled={!gatePin || gateBusy}>
              {gateBusy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Unlock price editing
            </button>
            <button className="btn btn-soft" onClick={() => setGateOpen(false)}>Cancel</button>
          </div>
        </div>
      </Modal>

      {/* IMEI / Serial unit picker for tracked products */}
      <Modal
        open={!!unitPickProductId}
        onClose={() => { setUnitPickProductId(null); setUnitPickSearch(''); }}
        title="Select unit (IMEI / Serial)"
        sub={products.find(p => p.id === unitPickProductId)?.name}
      >
        {unitPickProductId && (() => {
          const used = usedUnitIds();
          const available = (state.units || []).filter(u =>
            u.productId === unitPickProductId &&
            u.status === 'in_stock' &&
            !used.has(u.id) &&
            (!unitPickSearch.trim() ||
              (u.imei || '').includes(unitPickSearch.trim()) ||
              (u.serial || '').toLowerCase().includes(unitPickSearch.trim().toLowerCase())),
          );
          return (
            <div className="space-y-3">
              <input
                className="input"
                autoFocus
                placeholder="Scan or type IMEI / serialâ€¦"
                value={unitPickSearch}
                onChange={e => setUnitPickSearch(e.target.value)}
              />
              {available.length === 0 ? (
                <p className="text-sm text-faint py-4 text-center">
                  No available units. Add them under <b>IMEI / Serial</b> first.
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto space-y-1.5">
                  {available.map(u => (
                    <button
                      key={u.id}
                      type="button"
                      className="w-full text-left rounded-xl border border-line px-3 py-2.5 hover:bg-raised transition-colors"
                      onClick={() => addUnitToCart(unitPickProductId, u.id)}
                    >
                      <div className="font-semibold text-ink text-[13px] num">{u.imei || u.serial || u.id}</div>
                      <div className="text-[11px] text-faint">
                        {u.imei && u.serial ? `Serial: ${u.serial}` : ''}
                        {u.expiryDate ? ` · Exp ${u.expiryDate.slice(0, 10)}` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      <ReceiptModal sale={doneSale} onClose={() => { setDoneSale(null); setTimeout(focusSearch, 120); }} />
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

/* ---------- kbd hint ---------- */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-1.5 py-[2px] rounded-[5px] bg-raised border border-line border-b-2 text-[9px] font-extrabold text-sub font-mono">
      {children}
    </span>
  );
}

/* ---------- cart line ---------- */
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

        <div className="w-[86px] text-right shrink-0">
          {(line.discount > 0 || overridden) && <div className="text-[10px] text-faint line-through num">{fmtRs(line.product.price * line.qty, false)}</div>}
          <div className="text-[13px] font-extrabold num text-ink">{fmtRs(net, false)}</div>
        </div>

        {canDiscount && (
          <button
            className={`icon-btn !w-7 !h-7 shrink-0 ${discOpen || line.discount > 0 ? '!bg-violet-500/10 !text-violet-500 !border-violet-300/50' : ''}`}
            title="Item discount"
            onClick={() => setDiscOpen(o => !o)}
          >
            <Tag size={12} />
          </button>
        )}
        <button className="icon-btn !w-7 !h-7 shrink-0 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={onRemove} title="Remove">
          <X size={13} />
        </button>
      </div>

      <AnimatePresence>
        {discOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 mt-2 ml-1 rounded-lg bg-raised/70 border border-line px-2.5 py-2">
              <Tag size={11} className="text-violet-500 shrink-0" />
              <span className="text-[10.5px] font-bold text-sub">Item discount (Rs.)</span>
              <input
                className="input !w-24 !py-1 !px-2 num !text-[11.5px] text-right"
                value={line.discount || ''}
                placeholder="0"
                inputMode="decimal"
                onChange={e => onDisc(parseFloat(e.target.value.replace(/[^\d.]/g, '')) || 0)}
              />
              {line.discount > 0 && (
                <button className="text-[10px] font-bold text-rose-500" onClick={() => onDisc(0)}>Clear</button>
              )}
              <span className="ml-auto text-[10.5px] num font-semibold text-violet-500">− {fmtRs(line.discount || 0, false)}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
    }
