from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace_once(path, old, new):
    p = ROOT / path
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'pattern not found in {path}: {old[:80]!r}')
    p.write_text(s.replace(old, new, 1))

# Store API + durable supplier payments + central credit-limit enforcement.
replace_once('src/lib/store.tsx',
"  saveSupplier: (s: Supplier) => void;\n  deleteSupplier: (id: string) => void;",
"  saveSupplier: (s: Supplier) => void;\n  deleteSupplier: (id: string) => void;\n  saveSupplierPayment: (p: Omit<import('./supplierPayments').SupplierPayment, 'id' | 'date' | 'by'>) => import('./supplierPayments').SupplierPayment | null;\n  deleteSupplierPayment: (id: string) => void;")
replace_once('src/lib/store.tsx',
"    purchaseReturns: s.purchaseReturns || [],\n    settings:",
"    purchaseReturns: s.purchaseReturns || [],\n    supplierPayments: s.supplierPayments || [],\n    settings:")
replace_once('src/lib/store.tsx',
"  const deleteSupplier = useCallback((id: string) => {\n    const sp = state.suppliers.find(x => x.id === id);\n    setState(s => ({ ...s, suppliers: s.suppliers.filter(x => x.id !== id) }));\n    if (sp) pushAudit('DELETE', 'Supplier', `Deleted supplier ${sp.name}`);\n  }, [state.suppliers, pushAudit]);",
"  const deleteSupplier = useCallback((id: string) => {\n    const sp = state.suppliers.find(x => x.id === id);\n    setState(s => ({ ...s, suppliers: s.suppliers.filter(x => x.id !== id) }));\n    if (sp) pushAudit('DELETE', 'Supplier', `Deleted supplier ${sp.name}`);\n  }, [state.suppliers, pushAudit]);\n\n  const saveSupplierPayment = useCallback((p: Omit<import('./supplierPayments').SupplierPayment, 'id' | 'date' | 'by'>) => {\n    if (!user || !state.suppliers.some(s => s.id === p.supplierId)) return null;\n    if (!Number.isFinite(p.amount) || p.amount <= 0) return null;\n    const purchaseTotal = state.purchases.filter(x => x.supplierId === p.supplierId && x.status === 'received').reduce((sum, x) => sum + Math.max(0, x.total), 0);\n    const returnTotal = (state.purchaseReturns || []).filter(x => x.supplierId === p.supplierId).reduce((sum, x) => sum + Math.max(0, x.total), 0);\n    const paidTotal = (state.supplierPayments || []).filter(x => x.supplierId === p.supplierId).reduce((sum, x) => sum + Math.max(0, x.amount), 0);\n    const outstanding = Math.max(0, Math.round((purchaseTotal - returnTotal - paidTotal) * 100) / 100);\n    if (p.amount > outstanding) return null;\n    const payment: import('./supplierPayments').SupplierPayment = { ...p, amount: Math.round(p.amount * 100) / 100, id: uid(), date: new Date().toISOString(), by: user.name };\n    setState(s => ({ ...s, supplierPayments: [payment, ...(s.supplierPayments || [])] }));\n    pushAudit('CREATE', 'SupplierPayment', `Payment of Rs. ${payment.amount.toLocaleString()} to supplier ${state.suppliers.find(s => s.id === p.supplierId)?.name || p.supplierId}`);\n    return payment;\n  }, [state.suppliers, state.purchases, state.purchaseReturns, state.supplierPayments, user, pushAudit]);\n\n  const deleteSupplierPayment = useCallback((id: string) => {\n    if (!can('act:deleteRecords')) return;\n    const payment = (state.supplierPayments || []).find(x => x.id === id);\n    if (!payment) return;\n    setState(s => ({ ...s, supplierPayments: (s.supplierPayments || []).filter(x => x.id !== id) }));\n    pushAudit('DELETE', 'SupplierPayment', `Deleted supplier payment ${id}`);\n  }, [can, state.supplierPayments, pushAudit]);")
replace_once('src/lib/store.tsx',
"    const isCredit = legs.some(l => l.method === 'credit') || (!isSplit && input.payment === 'credit');\n    const amountPaid = isSplit",
"    const isCredit = legs.some(l => l.method === 'credit') || (!isSplit && input.payment === 'credit');\n    if (isCredit) {\n      if (!cust) return null;\n      const creditLimit = cust.creditLimit ?? 0;\n      const projectedBalance = cust.creditBalance + Math.max(0, total - (isSplit ? legs.filter(l => l.method !== 'credit').reduce((a, l) => a + l.amount, 0) : input.amountPaid));\n      if (creditLimit > 0 && projectedBalance > creditLimit) return null;\n    }\n    const amountPaid = isSplit")
replace_once('src/lib/store.tsx',
"    saveCustomer, deleteCustomer, saveSupplier, deleteSupplier,\n    completeSale",
"    saveCustomer, deleteCustomer, saveSupplier, deleteSupplier, saveSupplierPayment, deleteSupplierPayment,\n    completeSale")

# Customer credit-limit field and visible list column.
replace_once('src/pages/Customers.tsx',
"                  <th className=\"th\">Credit</th><th className=\"th\">Since</th>",
"                  <th className=\"th\">Credit</th><th className=\"th\">Limit</th><th className=\"th\">Since</th>")
replace_once('src/pages/Customers.tsx',
"                    <td className=\"td\">\n                      {c.creditBalance > 0\n                        ? <Badge tone=\"amber\" className=\"num\">{fmtRs(c.creditBalance)}</Badge>\n                        : <span className=\"text-xs text-faint\">—</span>}\n                    </td>\n                    <td className=\"td text-[13px] text-sub\"",
"                    <td className=\"td\">\n                      {c.creditBalance > 0\n                        ? <Badge tone=\"amber\" className=\"num\">{fmtRs(c.creditBalance)}</Badge>\n                        : <span className=\"text-xs text-faint\">—</span>}\n                    </td>\n                    <td className=\"td num text-xs text-sub\">{c.creditLimit && c.creditLimit > 0 ? fmtRs(c.creditLimit) : 'Unlimited'}</td>\n                    <td className=\"td text-[13px] text-sub\"")
replace_once('src/pages/Customers.tsx',
"            <Field label=\"Loyalty points\" hint=\"Earned automatically: 1 pt per Rs. 1,000 · worth Rs. 20 each\">",
"            <Field label=\"Credit limit (Rs.)\" hint=\"0 = unlimited. Credit sales are blocked when the limit would be exceeded.\">\n              <input className=\"input num\" type=\"number\" min={0} step={0.01} value={editing.creditLimit ?? ''} onChange={e => { const n = Math.max(0, Number(e.target.value) || 0); setEditing({ ...editing, creditLimit: n > 0 ? n : undefined }); }} placeholder=\"0 (unlimited)\" />\n            </Field>\n            <Field label=\"Loyalty points\" hint=\"Earned automatically: 1 pt per Rs. 1,000 · worth Rs. 20 each\">")

# App route and sidebar entry.
replace_once('src/App.tsx',
"const Suppliers = lazy(() => import('./pages/Suppliers'));\nconst Purchases",
"const Suppliers = lazy(() => import('./pages/Suppliers'));\nconst SupplierPayments = lazy(() => import('./pages/SupplierPayments'));\nconst Purchases")
replace_once('src/App.tsx',
"<Route path=\"/suppliers\" element={<Guard perm=\"page:suppliers\"><Suppliers /></Guard>} />",
"<Route path=\"/suppliers\" element={<Guard perm=\"page:suppliers\"><Suppliers /></Guard>} /><Route path=\"/supplier-payments\" element={<Guard perm=\"page:suppliers\"><SupplierPayments /></Guard>} />")
replace_once('src/components/AppLayout.tsx',
"  { to: '/suppliers', label: 'Suppliers', icon: Truck, perm: 'page:suppliers', group: 'Operations' },",
"  { to: '/suppliers', label: 'Suppliers', icon: Truck, perm: 'page:suppliers', group: 'Operations' },\n  { to: '/supplier-payments', label: 'Supplier Payments', icon: Wallet, perm: 'page:suppliers', group: 'Operations' },")
replace_once('src/components/AppLayout.tsx',
"  [/^\\/customers/, 'Customers'], [/^\\/suppliers/, 'Suppliers'], [/^\\/purchases/, 'Purchases'],",
"  [/^\\/customers/, 'Customers'], [/^\\/suppliers/, 'Suppliers'], [/^\\/supplier-payments/, 'Supplier Payments'], [/^\\/purchases/, 'Purchases'],")

# Extend the pure supplier ledger helper to include debit notes when supplied.
p = ROOT / 'src/lib/supplierPayments.ts'
s = p.read_text()
s = s.replace("import type { Purchase, Supplier } from './types';", "import type { Purchase, PurchaseReturn, Supplier } from './types';", 1)
s = s.replace("  payments: readonly SupplierPayment[],\n): SupplierAccountLedgerRow[] {", "  payments: readonly SupplierPayment[],\n  purchaseReturns: readonly PurchaseReturn[] = [],\n): SupplierAccountLedgerRow[] {", 1)
s = s.replace("  for (const payment of payments) {", "  for (const purchaseReturn of purchaseReturns) {\n    if (purchaseReturn.supplierId !== supplier.id) continue;\n    if (!Number.isFinite(purchaseReturn.total) || purchaseReturn.total <= 0) continue;\n    rows.push({ date: purchaseReturn.date, type: 'payment', reference: purchaseReturn.dnNo, amount: -purchaseReturn.total });\n  }\n\n  for (const payment of payments) {", 1)
s = s.replace("  payments: readonly SupplierPayment[],\n): number {", "  payments: readonly SupplierPayment[],\n  purchaseReturns: readonly PurchaseReturn[] = [],\n): number {", 1)
s = s.replace("  const paid = payments", "  const returned = purchaseReturns\n    .filter(p => p.supplierId === supplierId && Number.isFinite(p.total) && p.total > 0)\n    .reduce((sum, p) => sum + p.total, 0);\n  const paid = payments", 1)
s = s.replace("  return Math.max(0, Math.round((purchased - paid) * 100) / 100);", "  return Math.max(0, Math.round((purchased - returned - paid) * 100) / 100);", 1)
p.write_text(s)

# Make the payment screen use debit notes in outstanding calculations.
p = ROOT / 'src/pages/SupplierPayments.tsx'
s = p.read_text()
s = s.replace("getSupplierOutstanding(supplier.id, state.purchases, payments)", "getSupplierOutstanding(supplier.id, state.purchases, payments, state.purchaseReturns || [])")
s = s.replace("getSupplierOutstanding(s.id, state.purchases, payments)", "getSupplierOutstanding(s.id, state.purchases, payments, state.purchaseReturns || [])")
p.write_text(s)

print('supplier/grn feature patch applied')
