    setState(s => ({ ...s, held: s.held.filter(x => x.id !== id) }));
  }, [pushAudit, user, can]);

  /* ---------------- purchases ---------------- */
  const savePurchase = useCallback((p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => {
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase order creation without purchase access');
      return;
    }
    // Validate the complete purchase at creation time as well as at receive time.
    // This prevents malformed pending POs from entering local state and later
    // becoming unreconcilable GRNs.
    const validation: Purchase = {
      ...p,
      id: 'validation',
      poNo: 'PO-VALIDATION',
      date: new Date().toISOString(),
      status: 'pending',
    };
    if (!buildPurchaseReceivePlan(validation, state.products)) return;
    setState(s => {
      const seq = s.counters.po + 1;
      const po: Purchase = {
        ...p, id: uid(), poNo: `PO-${String(seq).padStart(4, '0')}`,
        date: new Date().toISOString(), status: 'pending',
      };
      return { ...s, purchases: [po, ...s.purchases], counters: { ...s.counters, po: seq } };
    });
    pushAudit('CREATE', 'Purchase', `Created PO for ${p.supplierName} · Rs. ${p.total.toLocaleString()}`);
  }, [state.products, pushAudit, user, can]);

  const receivePurchase = useCallback((id: string, processorName?: string) => {
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase receive without purchase access');
      return;
    }
    const po = state.purchases.find(x => x.id === id);
    if (!po || po.status !== 'pending') return;
    const plan = buildPurchaseReceivePlan(po, state.products);
    if (!plan) return;
    setStateWithInventoryLedger('PURCHASE_RECEIVE', s => {
      const currentPo = s.purchases.find(x => x.id === id);
      if (!currentPo || currentPo.status !== 'pending') return s;
      const currentPlan = buildPurchaseReceivePlan(currentPo, s.products);
      if (!currentPlan) return s;
      const now = new Date().toISOString();
      const newUnits: InventoryUnit[] = [];