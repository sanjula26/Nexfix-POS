from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def rep(path, old, new):
    p=ROOT/path; s=p.read_text()
    if old not in s: raise SystemExit(f'missing pattern {path}: {old[:100]!r}')
    p.write_text(s.replace(old,new,1))

rep('src/lib/store.tsx',
"  savePurchase: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => void;\n  receivePurchase: (id: string) => void;",
"  savePurchase: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => void;\n  saveGRNDraft: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => Purchase | null;\n  updateGRNDraft: (id: string, patch: Partial<Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>>) => boolean;\n  receivePurchase: (id: string, processorName?: string) => void;\n  processGRN: (id: string, processorName: string) => void;")
rep('src/lib/store.tsx',
"      claim: (s.counters as { claim?: number })?.claim ?? 0,\n      dn:",
"      claim: (s.counters as { claim?: number })?.claim ?? 0,\n      grn: (s.counters as { grn?: number })?.grn ?? 0,\n      dn:")
rep('src/lib/store.tsx',
"  const receivePurchase = useCallback((id: string) => {",
"  const receivePurchase = useCallback((id: string, processorName?: string) => {")
rep('src/lib/store.tsx',
"        purchases: s.purchases.map(x => (x.id === id ? { ...x, status: 'received' as const } : x)),",
"        purchases: s.purchases.map(x => x.id === id ? { ...x, status: 'received' as const, ...(processorName ? { processedAt: now, processedBy: processorName } : {}) } : x),")
rep('src/lib/store.tsx',
"  }, [state.purchases, state.products, pushAudit]);\n\n  const deletePurchase = useCallback",
"  }, [state.purchases, state.products, pushAudit]);\n\n  const saveGRNDraft = useCallback((p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => {\n    if (!user || !p.supplierId || !p.items.length) return null;\n    const plan = buildPurchaseReceivePlan({ ...p, id: 'validation', poNo: 'GRN-VALIDATION', date: new Date().toISOString(), status: 'pending' }, state.products);\n    if (!plan) return null;\n    const created: Purchase = { ...p, id: uid(), poNo: `GRN-${String((state.counters.grn ?? 0) + 1).padStart(4, '0')}`, date: new Date().toISOString(), status: 'pending', total: p.items.reduce((sum, item) => sum + item.qty * item.cost, 0) };\n    setState(s => ({ ...s, purchases: [created, ...s.purchases], counters: { ...s.counters, grn: (s.counters.grn ?? 0) + 1 } }));\n    pushAudit('CREATE', 'GRN', `Draft ${created.poNo} for ${created.supplierName} · Rs. ${created.total.toLocaleString()}`);\n    return created;\n  }, [state.products, state.counters.grn, user, pushAudit]);\n\n  const updateGRNDraft = useCallback((id: string, patch: Partial<Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>>) => {\n    const current = state.purchases.find(x => x.id === id);\n    if (!current || current.status !== 'pending') return false;\n    const next = { ...current, ...patch, total: (patch.items || current.items).reduce((sum, item) => sum + item.qty * item.cost, 0) };\n    const plan = buildPurchaseReceivePlan(next, state.products);\n    if (!plan) return false;\n    setState(s => ({ ...s, purchases: s.purchases.map(x => x.id === id && x.status === 'pending' ? next : x) }));\n    pushAudit('EDIT', 'GRN', `Updated draft ${current.poNo}`);\n    return true;\n  }, [state.purchases, state.products, pushAudit]);\n\n  const processGRN = useCallback((id: string, processorName: string) => {\n    receivePurchase(id, processorName);\n  }, [receivePurchase]);\n\n  const deletePurchase = useCallback")
rep('src/lib/store.tsx',
"    savePurchase, receivePurchase, createPurchaseReturn, deletePurchase,",
"    savePurchase, saveGRNDraft, updateGRNDraft, receivePurchase, processGRN, createPurchaseReturn, deletePurchase,")
print('GRN patch applied')
