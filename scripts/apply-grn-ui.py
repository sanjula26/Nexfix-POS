from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def rep(path,old,new):
 p=ROOT/path; s=p.read_text()
 if old not in s: raise SystemExit(f'missing pattern {path}: {old[:100]!r}')
 p.write_text(s.replace(old,new,1))
rep('src/App.tsx',"const Suppliers = lazy(() => import('./pages/Suppliers'));\nconst Purchases", "const Suppliers = lazy(() => import('./pages/Suppliers'));\nconst GRN = lazy(() => import('./pages/GRN'));\nconst Purchases")
rep('src/App.tsx',"<Route path=\"/purchases\" element={<Guard perm=\"page:purchases\"><Purchases /></Guard>} />", "<Route path=\"/purchases\" element={<Guard perm=\"page:purchases\"><Purchases /></Guard>} /><Route path=\"/grn\" element={<Guard perm=\"page:purchases\"><GRN /></Guard>} />")
rep('src/components/AppLayout.tsx',"  { to: '/purchases', label: 'Purchases', icon: ClipboardList, perm: 'page:purchases', group: 'Operations' },", "  { to: '/purchases', label: 'Purchases', icon: ClipboardList, perm: 'page:purchases', group: 'Operations' },\n  { to: '/grn', label: 'Goods Received Notes', icon: ClipboardList, perm: 'page:purchases', group: 'Operations' },")
rep('src/components/AppLayout.tsx',"  [/^\\/customers/, 'Customers'], [/^\\/suppliers/, 'Suppliers'], [/^\\/purchases/, 'Purchases'],", "  [/^\\/customers/, 'Customers'], [/^\\/suppliers/, 'Suppliers'], [/^\\/grn/, 'Goods Received Notes'], [/^\\/purchases/, 'Purchases'],")
print('GRN UI patch applied')
