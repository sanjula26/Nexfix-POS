import { useRef, useState } from 'react';
import { Upload, Download, CheckCircle2, XCircle, AlertTriangle, FileText } from 'lucide-react';
import { usePOS } from '../lib/store';
import { PageHeading } from '../components/ui';
import { uid, downloadFile } from '../lib/utils';
import type { Product, Customer } from '../lib/types';

type ImportType = 'products' | 'customers';
interface ParseResult<T> { valid: T[]; errors: { row: number; msg: string }[] }

function parseProductsCSV(text: string, existing: Product[]): ParseResult<Product> {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { valid: [], errors: [{ row: 0, msg: 'File is empty or missing header' }] };
  const valid: Product[] = [];
  const errors: { row: number; msg: string }[] = [];
  const existingBarcodes = new Set(existing.map(p => p.barcode).filter(Boolean));
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const [name, category, brand, sku, barcode, cost, price, stock, reorderLevel] = cols;
    if (!name) { errors.push({ row: i + 1, msg: 'Name is required' }); continue; }
    if (!cost || isNaN(+cost)) { errors.push({ row: i + 1, msg: `Invalid cost: "${cost}"` }); continue; }
    if (!price || isNaN(+price)) { errors.push({ row: i + 1, msg: `Invalid price: "${price}"` }); continue; }
    if (barcode && existingBarcodes.has(barcode)) { errors.push({ row: i + 1, msg: `Duplicate barcode: ${barcode}` }); continue; }
    valid.push({
      id: uid(), name, category: category || 'General', brand: brand || '',
      sku: sku || '', barcode: barcode || '', cost: +cost, price: +price,
      stock: Math.max(0, +(stock || 0)), reorderLevel: Math.max(0, +(reorderLevel || 5)),
      trackImei: false, active: true, createdAt: new Date().toISOString(),
    });
    if (barcode) existingBarcodes.add(barcode);
  }
  return { valid, errors };
}

function parseCustomersCSV(text: string): ParseResult<Customer> {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { valid: [], errors: [{ row: 0, msg: 'File is empty or missing header' }] };
  const valid: Customer[] = [];
  const errors: { row: number; msg: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const [name, phone, email, address, nic] = cols;
    if (!name) { errors.push({ row: i + 1, msg: 'Name is required' }); continue; }
    if (!phone) { errors.push({ row: i + 1, msg: 'Phone is required' }); continue; }
    valid.push({
      id: uid(), name, phone, email: email || undefined, address: address || undefined,
      nic: nic || undefined, createdAt: new Date().toISOString(),
      creditBalance: 0, loyaltyPoints: 0,
    });
  }
  return { valid, errors };
}

export default function CSVImport() {
  const { state, saveProduct, saveCustomer } = usePOS();
  const [type, setType] = useState<ImportType>('products');
  const [preview, setPreview] = useState<ParseResult<Product | Customer> | null>(null);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const downloadTemplate = (t: ImportType) => {
    if (t === 'products') {
      downloadFile('products-template.csv',
        'Name,Category,Brand,SKU,Barcode,Cost,Price,Stock,ReorderLevel\n"iPhone 15","Phones","Apple","IPH15","123456789",185000,210000,5,2',
        'text/csv'
      );
    } else {
      downloadFile('customers-template.csv',
        'Name,Phone,Email,Address,NIC\n"John Doe","0771234567","john@email.com","Colombo","123456789V"',
        'text/csv'
      );
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDone(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (type === 'products') {
        setPreview(parseProductsCSV(text, state.products) as ParseResult<Product | Customer>);
      } else {
        setPreview(parseCustomersCSV(text) as ParseResult<Product | Customer>);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = () => {
    if (!preview || preview.valid.length === 0) return;
    setImporting(true);
    let count = 0;
    try {
      if (type === 'products') {
        (preview.valid as Product[]).forEach(p => { saveProduct(p); count++; });
      } else {
        (preview.valid as Customer[]).forEach(c => { saveCustomer(c); count++; });
      }
      setDone(count);
      setPreview(null);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <PageHeading chip="Tools" chipTone="sky" title="CSV Import"
        sub="Bulk import products or customers from a spreadsheet"
      />

      <div className="p-4 space-y-4">
        <div className="card p-4">
          <p className="text-xs font-semibold text-sub uppercase tracking-wider mb-3">What to import?</p>
          <div className="flex gap-2">
            {(['products', 'customers'] as const).map(t => (
              <button key={t} onClick={() => { setType(t); setPreview(null); setDone(null); }}
                className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${type === t ? 'bg-violet-600 text-white border-violet-600' : 'bg-surface border-line text-sub hover:border-violet-400'}`}>
                {t === 'products' ? '📦 Products' : '👤 Customers'}
              </button>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-sub uppercase tracking-wider">
              {type === 'products' ? 'Product CSV Format' : 'Customer CSV Format'}
            </p>
            <button className="btn btn-soft !py-1 !px-3 !text-xs" onClick={() => downloadTemplate(type)}>
              <Download size={12}/> Download Template
            </button>
          </div>
          <div className="bg-raised rounded-lg p-3 font-mono text-xs text-sub overflow-x-auto">
            {type === 'products'
              ? 'Name, Category, Brand, SKU, Barcode, Cost, Price, Stock, ReorderLevel'
              : 'Name, Phone, Email (optional), Address (optional), NIC (optional)'
            }
          </div>
          <ul className="mt-3 space-y-1 text-xs text-sub">
            <li>• First row must be the header (download template to see exact format)</li>
            <li>• Name {type === 'products' ? ', Cost, Price' : ', Phone'} are required fields</li>
            {type === 'products' && <li>• Duplicate barcodes will be skipped with an error</li>}
            <li>• Save your spreadsheet as CSV (UTF-8) before uploading</li>
          </ul>
        </div>

        {done !== null ? (
          <div className="card p-6 text-center">
            <CheckCircle2 size={36} className="text-emerald-500 mx-auto mb-2"/>
            <p className="font-bold text-lg text-emerald-600">Import successful!</p>
            <p className="text-sub text-sm">{done} {type} imported successfully.</p>
            <button className="btn btn-primary mt-4" onClick={() => { setDone(null); setPreview(null); }}>
              Import another file
            </button>
          </div>
        ) : (
          <div
            className="card border-2 border-dashed border-line hover:border-violet-400 transition-colors p-8 text-center cursor-pointer"
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile}/>
            <Upload size={28} className="text-violet-400 mx-auto mb-2"/>
            <p className="font-semibold text-ink">Click to upload CSV file</p>
            <p className="text-xs text-sub mt-1">Only .csv files supported</p>
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="card p-3 text-center">
                <p className="text-2xl font-bold text-emerald-600">{preview.valid.length}</p>
                <p className="text-xs text-sub">Ready to import</p>
              </div>
              <div className="card p-3 text-center">
                <p className={`text-2xl font-bold ${preview.errors.length > 0 ? 'text-rose-500' : 'text-sub'}`}>{preview.errors.length}</p>
                <p className="text-xs text-sub">Errors / skipped</p>
              </div>
            </div>

            {preview.errors.length > 0 && (
              <div className="card overflow-hidden">
                <div className="p-3 border-b border-line bg-rose-50 dark:bg-rose-900/10">
                  <p className="text-xs font-semibold text-rose-600 flex items-center gap-1.5"><XCircle size={13}/> Errors (these rows will be skipped)</p>
                </div>
                <div className="max-h-40 overflow-y-auto">
                  {preview.errors.map((e, i) => (
                    <div key={i} className="px-3 py-2 text-xs border-b border-line flex gap-2">
                      <span className="text-sub">Row {e.row}:</span>
                      <span className="text-rose-500">{e.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.valid.length > 0 && (
              <div className="card overflow-hidden">
                <div className="p-3 border-b border-line bg-emerald-50 dark:bg-emerald-900/10 flex items-center justify-between">
                  <p className="text-xs font-semibold text-emerald-600 flex items-center gap-1.5">
                    <CheckCircle2 size={13}/> {preview.valid.length} rows ready to import
                  </p>
                  <button className="btn btn-primary !py-1.5 !px-4 !text-sm" onClick={handleImport} disabled={importing}>
                    <FileText size={13}/> {importing ? 'Importing...' : `Import ${preview.valid.length} ${type}`}
                  </button>
                </div>
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full min-w-[400px] text-xs">
                    <thead>
                      <tr className="bg-raised/60">
                        {type === 'products'
                          ? <><th className="th">Name</th><th className="th">Category</th><th className="th text-right">Cost</th><th className="th text-right">Price</th><th className="th text-right">Stock</th></>
                          : <><th className="th">Name</th><th className="th">Phone</th><th className="th">Email</th></>
                        }
                      </tr>
                    </thead>
                    <tbody>
                      {(preview.valid as (Product | Customer)[]).slice(0, 50).map((row, i) => (
                        <tr key={i} className="border-b border-line hover:bg-raised/30">
                          {type === 'products' ? (() => {
                            const p = row as Product;
                            return <><td className="td">{p.name}</td><td className="td">{p.category}</td><td className="td text-right">{p.cost.toLocaleString()}</td><td className="td text-right">{p.price.toLocaleString()}</td><td className="td text-right">{p.stock}</td></>;
                          })() : (() => {
                            const c = row as Customer;
                            return <><td className="td">{c.name}</td><td className="td">{c.phone}</td><td className="td text-sub">{c.email || '—'}</td></>;
                          })()}
                        </tr>
                      ))}
                      {preview.valid.length > 50 && <tr><td className="td text-sub text-center" colSpan={5}>... and {preview.valid.length - 50} more rows</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {preview.valid.length === 0 && (
              <div className="card p-6 text-center">
                <AlertTriangle size={28} className="text-amber-500 mx-auto mb-2"/>
                <p className="font-semibold text-amber-600">No valid rows to import</p>
                <p className="text-xs text-sub mt-1">Fix the errors above and try again</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
