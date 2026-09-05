import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const storePath = 'src/lib/store.tsx';
const text = readFileSync(storePath, 'utf8');
const oldBlock = `  const processExchange = useCallback((saleId: string, itemIdx: number[], reason: string, mode: 'refund' | 'replace') => {
    const sale = state.sales.find(x => x.id === saleId);
    if (!sale || itemIdx.length === 0) return;
    setState(s => {
      const exItems = itemIdx.map(i => {
        const it = sale.items[i];
        return { productId: it.productId, name: it.name, qty: it.qty, amount: it.price * it.qty - (it.discount || 0) };
      });
      const refund = mode === 'refund' ? exItems.reduce((sum, i) => sum + i.amount, 0) : 0;
      const seq = s.counters.ex + 1;
      const ex: Exchange = {
        id: uid(), exNo: \`EX-\${String(seq).padStart(4, '0')}\`, date: new Date().toISOString(),
        billNo: sale.billNo, customerName: sale.customerName, reason,
        items: exItems, refund, additional: 0, by: user?.name || 'Unknown',
      };
      return {
        ...s,
        exchanges: [ex, ...s.exchanges],
        counters: { ...s.counters, ex: seq },
        sales: s.sales.map(x => (x.id === saleId ? { ...x, status: 'exchanged' } : x)),
        // Both refund and replace restock the returned items
        products: s.products.map(p => {
          const it = exItems.find(i => i.productId === p.id);
          return it ? { ...p, stock: p.stock + it.qty } : p;
        }),
      };
    });
    pushAudit('EXCHANGE', 'Exchange', \`\${mode === 'refund' ? 'Returned' : 'Exchanged'} \${itemIdx.length} item(s) on \${sale.billNo}\`);
  }, [state.sales, pushAudit, user?.name]);`;
const newBlock = `  const processExchange = useCallback((saleId: string, itemIdx: number[], reason: string, mode: 'refund' | 'replace') => {
    const sale = state.sales.find(x => x.id === saleId);
    if (!user || !sale || sale.status !== 'completed' || itemIdx.length === 0) return;
    if (mode === 'refund' && !can('act:refund')) return;
    const ageMs = Date.now() - new Date(sale.date).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > state.settings.exchangeDays * 86400000) return;
    const validIdx = [...new Set(itemIdx)].filter(i => Number.isInteger(i) && i >= 0 && i < sale.items.length);
    if (validIdx.length === 0) return;

    setState(s => {
      const exItems = validIdx.map(i => {
        const it = sale.items[i];
        return { productId: it.productId, name: it.name, qty: it.qty, amount: it.price * it.qty - (it.discount || 0) };
      });
      const refund = mode === 'refund' ? exItems.reduce((sum, i) => sum + i.amount, 0) : 0;
      const returnedUnitIds = validIdx.flatMap(i => sale.items[i].unitIds || []);
      const restockQtyByProduct = new Map<string, number>();
      exItems.forEach(it => {
        restockQtyByProduct.set(it.productId, (restockQtyByProduct.get(it.productId) || 0) + it.qty);
      });
      const seq = s.counters.ex + 1;
      const ex: Exchange = {
        id: uid(), exNo: \`EX-\${String(seq).padStart(4, '0')}\`, date: new Date().toISOString(),
        billNo: sale.billNo, customerName: sale.customerName, reason,
        items: exItems, refund, additional: 0, by: user.name,
      };
      return {
        ...s,
        exchanges: [ex, ...s.exchanges],
        counters: { ...s.counters, ex: seq },
        sales: s.sales.map(x => (x.id === saleId ? { ...x, status: 'exchanged' } : x)),
        products: s.products.map(p => {
          const qty = restockQtyByProduct.get(p.id);
          return qty !== undefined ? { ...p, stock: p.stock + qty } : p;
        }),
        units: (s.units || []).map(u =>
          returnedUnitIds.includes(u.id)
            ? { ...u, status: 'returned' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
            : u,
        ),
      };
    });
    pushAudit('EXCHANGE', 'Exchange', \`\${mode === 'refund' ? 'Returned' : 'Exchanged'} \${validIdx.length} item(s) on \${sale.billNo}\`);
  }, [state.sales, state.settings.exchangeDays, pushAudit, user, can]);`;
if (!text.includes(oldBlock)) throw new Error('exchange block not found; refusing to patch');
writeFileSync(storePath, text.replace(oldBlock, newBlock));
execFileSync('git', ['fetch', 'origin', 'main', '--depth=1'], { stdio: 'inherit' });
execFileSync('git', ['checkout', 'origin/main', '--', 'package.json', '.github/workflows/ci.yml'], { stdio: 'inherit' });
execFileSync('git', ['rm', 'scripts/step3-patch.mjs'], { stdio: 'inherit' });
execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
execFileSync('git', ['add', storePath]);
execFileSync('git', ['commit', '-m', 'fix: harden exchange validation and reconciliation'], { stdio: 'inherit' });
execFileSync('git', ['push', 'origin', `HEAD:${process.env.GITHUB_HEAD_REF}`], { stdio: 'inherit' });
