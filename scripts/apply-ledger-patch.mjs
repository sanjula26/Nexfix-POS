import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request') process.exit(0);
const branch = process.env.GITHUB_HEAD_REF;
if (!branch) throw new Error('GITHUB_HEAD_REF is missing');

execFileSync('git', ['fetch', 'origin', branch], { stdio: 'inherit' });
execFileSync('git', ['checkout', '-B', branch, `origin/${branch}`], { stdio: 'inherit' });

const path = 'src/lib/store.tsx';
let s = fs.readFileSync(path, 'utf8');

if (!s.includes("from './inventoryLedger'")) {
  const anchor = "import { buildPurchaseReceivePlan, canDeletePurchase } from './purchaseReconciliation';";
  if (!s.includes(anchor)) throw new Error('ledger import anchor missing');
  s = s.replace(anchor, `${anchor}\nimport { appendInventoryTransaction, type InventoryTransaction } from './inventoryLedger';`);
}

if (!s.includes('function applyInventoryLedger(')) {
  const anchor = 'const Ctx = createContext<StoreCtx | null>(null);';
  if (!s.includes(anchor)) throw new Error('Ctx anchor missing');
  const helper = `

function applyInventoryLedger(
  prev: POSState,
  next: POSState,
  operation: 'SALE' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT',
  by?: string,
): POSState {
  const ledger = next.inventoryTransactions || prev.inventoryTransactions || [];
  const transactions: InventoryTransaction[] = [];
  const prevProducts = new Map(prev.products.map(p => [p.id, p]));
  const nextProducts = new Map(next.products.map(p => [p.id, p]));
  const now = new Date().toISOString();
  const add = (tx: Omit<InventoryTransaction, 'id' | 'occurredAt'> & { id: string }) => transactions.push({ ...tx, occurredAt: now, by });

  if (operation === 'SALE') {
    const ids = new Set(prev.sales.map(x => x.id));
    for (const sale of next.sales) if (!ids.has(sale.id)) for (const item of sale.items) if (item.qty > 0) {
      add({ id: 'inv:sale:' + sale.id + ':' + item.productId, type: 'SALE', productId: item.productId, quantity: -item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
    }
  }

  if (operation === 'REFUND') {
    for (const sale of next.sales) {
      const old = prev.sales.find(x => x.id === sale.id);
      if (!old || old.status === 'refunded' || sale.status !== 'refunded') continue;
      for (const item of sale.items) if (item.qty > 0) {
        add({ id: 'inv:refund:' + sale.id + ':' + item.productId, type: 'REFUND', productId: item.productId, quantity: item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
      }
    }
  }

  if (operation === 'PURCHASE_RECEIVE') {
    for (const purchase of next.purchases) {
      const old = prev.purchases.find(x => x.id === purchase.id);
      if (!old || old.status === 'received' || purchase.status !== 'received') continue;
      for (const item of purchase.items) if (item.qty > 0) {
        add({ id: 'inv:purchase:' + purchase.id + ':' + item.productId, type: 'PURCHASE_RECEIVE', productId: item.productId, quantity: item.qty, referenceId: purchase.id, referenceNo: purchase.poNo });
      }
    }
  }

  if (operation === 'EXCHANGE') {
    const ids = new Set(prev.exchanges.map(x => x.id));
    for (const ex of next.exchanges) if (!ids.has(ex.id)) {
      const returned = new Map<string, number>();
      for (const item of ex.items) if (item.qty > 0) {
        returned.set(item.productId, (returned.get(item.productId) || 0) + item.qty);
        add({ id: 'inv:exchange:' + ex.id + ':' + item.productId + ':return', type: 'EXCHANGE_RETURN', productId: item.productId, quantity: item.qty, referenceId: ex.id, referenceNo: ex.exNo, reason: ex.reason });
      }
      for (const [productId, qtyReturned] of returned) {
        const netDelta = (nextProducts.get(productId)?.stock || 0) - (prevProducts.get(productId)?.stock || 0);
        const outgoing = qtyReturned - netDelta;
        if (outgoing > 0) add({ id: 'inv:exchange:' + ex.id + ':' + productId + ':out', type: 'SALE', productId, quantity: -outgoing, referenceId: ex.id, referenceNo: ex.exNo, reason: ex.reason });
      }
    }
  }

  if (operation === 'STOCK_ADJUSTMENT') {
    for (const [productId, product] of nextProducts) {
      const before = prevProducts.get(productId)?.stock;
      if (before === undefined) continue;
      const delta = product.stock - before;
      if (delta) add({ id: 'inv:adjust:' + productId + ':' + product.stock + ':' + delta, type: 'STOCK_ADJUSTMENT', productId, quantity: delta, reason: 'Stock adjustment' });
    }
  }

  let updated = ledger;
  for (const tx of transactions) updated = appendInventoryTransaction(updated, tx);
  return updated === next.inventoryTransactions ? next : { ...next, inventoryTransactions: updated };
}
`;
  s = s.replace(anchor, anchor + helper);
}

if (!s.includes('setStateWithInventoryLedger')) {
  const anchor = "  const viewingAs: Role = user?.role || 'admin';\n";
  if (!s.includes(anchor)) throw new Error('viewingAs anchor missing');
  const wrapper = `  const setStateWithInventoryLedger = useCallback((operation: 'SALE' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT', updater: (prev: POSState) => POSState) => {\n    setState(prev => applyInventoryLedger(prev, updater(prev), operation, user?.email));\n  }, [user?.email]);\n\n`;
  s = s.replace(anchor, anchor + wrapper);
}

const ops = { adjustStock: 'STOCK_ADJUSTMENT', completeSale: 'SALE', refundSale: 'REFUND', receivePurchase: 'PURCHASE_RECEIVE', processExchange: 'EXCHANGE' };
for (const [fn, op] of Object.entries(ops)) {
  const marker = new RegExp(`\\n  const ${fn} = useCallback\\(`);
  const match = marker.exec(s);
  if (!match) throw new Error(`${fn} declaration missing`);
  const start = match.index;
  const nextMatch = /\n  const [A-Za-z0-9_]+ = useCallback\(/g;
  nextMatch.lastIndex = match.index + match[0].length;
  const next = nextMatch.exec(s);
  const end = next ? next.index : s.length;
  let chunk = s.slice(start, end);
  if (!chunk.includes(`setStateWithInventoryLedger('${op}'`)) {
    const idx = chunk.indexOf('setState(');
    if (idx < 0) throw new Error(`${fn} setState call missing`);
    chunk = chunk.slice(0, idx) + `setStateWithInventoryLedger('${op}', ` + chunk.slice(idx + 'setState('.length);
    s = s.slice(0, start) + chunk + s.slice(end);
  }
}

fs.writeFileSync(path, s);
execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
execFileSync('git', ['add', path]);
try {
  execFileSync('git', ['diff', '--cached', '--quiet']);
  console.log('Ledger patch already present; nothing to commit.');
} catch {
  execFileSync('git', ['commit', '-m', 'feat: safely integrate inventory ledger into POS mutations'], { stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' });
}
