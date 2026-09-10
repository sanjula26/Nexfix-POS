import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request') process.exit(0);
const branch = process.env.GITHUB_HEAD_REF;
if (!branch) throw new Error('GITHUB_HEAD_REF is missing');
const path = 'src/lib/store.tsx';
let s = fs.readFileSync(path, 'utf8');
if (!s.includes('const priorReturnedByLine = new Map<string, number>();')) {
  const old1 = `      const priorReturnedByProduct = new Map<string, number>();\n      s.exchanges.filter(x => x.billNo === sale.billNo).flatMap(x => x.items).forEach(item => {\n        priorReturnedByProduct.set(item.productId, (priorReturnedByProduct.get(item.productId) || 0) + item.qty);\n      });`;
  const new1 = `      const priorReturnedByLine = new Map<string, number>();\n      const priorReturnedByProduct = new Map<string, number>();\n      s.exchanges.filter(x => x.billNo === sale.billNo).flatMap(x => x.items).forEach(item => {\n        const lineKey = item.itemIdx !== undefined ? 'i:' + item.itemIdx : 'p:' + item.productId;\n        priorReturnedByLine.set(lineKey, (priorReturnedByLine.get(lineKey) || 0) + item.qty);\n        priorReturnedByProduct.set(item.productId, (priorReturnedByProduct.get(item.productId) || 0) + item.qty);\n      });`;
  if (!s.includes(old1)) throw new Error('exchange history block not found');
  s = s.replace(old1, new1);
}
const old2 = `        const it = sale.items[itemIdx];\n        const alreadyReturned = priorReturnedByProduct.get(it.productId) || 0;\n        const availableQty = Math.max(0, it.qty - alreadyReturned);`;
const new2 = `        const it = sale.items[itemIdx];\n        const lineKey = 'i:' + itemIdx;\n        const alreadyReturned = priorReturnedByLine.has(lineKey)\n          ? (priorReturnedByLine.get(lineKey) || 0)\n          : (priorReturnedByProduct.get(it.productId) || 0);\n        const availableQty = Math.max(0, it.qty - alreadyReturned);`;
if (!s.includes(new2) && !s.includes(old2)) throw new Error('exchange availability block not found');
if (s.includes(old2)) s = s.replace(old2, new2);
const old3 = `        exItems.push({ productId: it.productId, name: it.name, qty, amount });`;
const new3 = `        exItems.push({ itemIdx, productId: it.productId, name: it.name, qty, amount });`;
if (!s.includes(new3)) { if (!s.includes(old3)) throw new Error('exchange item push block not found'); s = s.replace(old3, new3); }
const old4 = `        priorReturnedByProduct.set(it.productId, alreadyReturned + qty);`;
const new4 = `        priorReturnedByLine.set(lineKey, alreadyReturned + qty);\n        priorReturnedByProduct.set(it.productId, (priorReturnedByProduct.get(it.productId) || 0) + qty);`;
if (!s.includes(new4)) { if (!s.includes(old4)) throw new Error('exchange return accumulator not found'); s = s.replace(old4, new4); }
const old5 = `      const allReturned = sale.items.every(it => (priorReturnedByProduct.get(it.productId) || 0) >= it.qty);`;
const new5 = `      const allReturned = sale.items.every((it, idx) => {\n        const returned = priorReturnedByLine.has('i:' + idx)\n          ? (priorReturnedByLine.get('i:' + idx) || 0)\n          : (priorReturnedByProduct.get(it.productId) || 0);\n        return returned >= it.qty;\n      });`;
if (!s.includes(new5)) { if (!s.includes(old5)) throw new Error('exchange all-returned check not found'); s = s.replace(old5, new5); }
fs.writeFileSync(path, s);
execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
execFileSync('git', ['add', path]);
try { execFileSync('git', ['diff', '--cached', '--quiet']); console.log('Exchange patch already present.'); }
catch { execFileSync('git', ['commit', '-m', 'fix: preserve duplicate exchange line identity'], {stdio:'inherit'}); execFileSync('git', ['push', 'origin', `HEAD:${branch}`], {stdio:'inherit'}); }
