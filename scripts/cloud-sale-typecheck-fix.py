from pathlib import Path
p = Path('src/lib/store.tsx')
text = p.read_text(encoding='utf-8')
needle = "    if (!cloud.ok || !cloud.saleId || !cloud.billNo || cloud.saleId !== saleId || !cloud.committed?.sale) return null;\n\n    const row = cloud.committed.sale;"
replacement = "    if (!cloud.ok || !cloud.saleId || !cloud.billNo || cloud.saleId !== saleId || !cloud.committed?.sale) return null;\n    const committed = cloud.committed;\n\n    const row = committed.sale;"
if needle not in text:
    raise SystemExit('type narrowing anchor not found')
text = text.replace(needle, replacement, 1)
start = text.index("  const completeSaleCloud = useCallback(async (input: NewSaleInput): Promise<Sale | null> => {")
end = text.index("\n\n  const refundSale = useCallback", start)
segment = text[start:end].replace('cloud.committed.', 'committed.')
text = text[:start] + segment + text[end:]
p.write_text(text, encoding='utf-8')
