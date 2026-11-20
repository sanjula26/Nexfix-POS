import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, FileBarChart } from 'lucide-react';
import { usePOS } from '../lib/store';
import { EmptyState, PageHeading, SearchInput } from '../components/ui';
import { dkey, downloadFile, fmtDate, fmtRs } from '../lib/utils';
import ReportPrintButton from '../components/ReportPrintButton';

type Cell = string | number;
type ReportRow = { id: string; values: Cell[] };
type Dataset = { title: string; description: string; columns: string[]; rows: ReportRow[]; note?: string };
const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const money = (value: number) => fmtRs(Number.isFinite(value) ? value : 0);
const dateText = (value: string) => value ? fmtDate(value) : '—';
const inDateRange = (value: string, from: string, to: string) => {
  const day = dkey(value);
  return (!from || day >= from) && (!to || day <= to);
};

export default function ReportView() {
  const { reportType = '' } = useParams();
  const { state } = usePOS();
  const today = dkey(new Date());
  const [from, setFrom] = useState(dkey(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState('');

  const dataset = useMemo<Dataset>(() => {
    const sales = state.sales.filter(sale => sale.status === 'completed' && inDateRange(sale.date, from, to));
    const purchases = state.purchases.filter(purchase => purchase.status === 'received' && inDateRange(purchase.processedAt || purchase.date, from, to));
    const groupedItems = () => {
      const map = new Map<string, { name: string; qty: number; revenue: number; cost: number; profit: number }>();
      sales.forEach(sale => sale.items.forEach(item => {
        const key = item.productId || item.name;
        const current = map.get(key) || { name: item.name, qty: 0, revenue: 0, cost: 0, profit: 0 };
        const revenue = item.qty * item.price - (item.discount || 0);
        const cost = item.qty * item.cost;
        current.qty += item.qty; current.revenue += revenue; current.cost += cost; current.profit += revenue - cost;
        map.set(key, current);
      }));
      return [...map.entries()].map(([id, value]) => ({ id, ...value }));
    };

    switch (reportType) {
      case 'date-wise-sales': {
        const map = new Map<string, { bills: number; units: number; sales: number; profit: number }>();
        sales.forEach(sale => {
          const day = dkey(sale.date); const row = map.get(day) || { bills: 0, units: 0, sales: 0, profit: 0 };
          row.bills += 1; row.units += sale.items.reduce((sum, item) => sum + item.qty, 0);
          row.sales += sale.total - (sale.refunds || []).reduce((sum, refund) => sum + refund.amount, 0); row.profit += sale.profit;
          map.set(day, row);
        });
        return { title: 'Date Wise Sales Report', description: 'Daily sales totals from completed bills in the selected date range.', columns: ['Date','Bills','Units Sold','Net Sales','Recorded Profit'], rows: [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([day,v])=>({id:day,values:[dateText(day),v.bills,v.units,money(v.sales),money(v.profit)]})) };
      }
      case 'item-wise-sales':
      case 'item-sales-date-range':
      case 'item-wise-profits': {
        const items = groupedItems().sort((a,b)=>reportType==='item-wise-profits'?b.profit-a.profit:b.revenue-a.revenue);
        return { title: reportType === 'item-wise-profits' ? 'Item Wise Profit Report' : reportType === 'item-sales-date-range' ? 'Item Sales — Date Range Report' : 'Item Wise Sales Report', description: 'Product-level totals calculated from completed sale lines. Discounts recorded on each line are deducted from sales value.', columns: ['Item','Quantity Sold','Sales Value','Cost Value','Gross Profit'], rows: items.map(item=>({id:item.id,values:[item.name,item.qty,money(item.revenue),money(item.cost),money(item.profit)]})) };
      }
      case 'cashier-wise-sales': {
        const map = new Map<string, { name: string; bills: number; units: number; sales: number; profit: number }>();
        sales.forEach(sale => {
          const key = sale.cashierId || sale.cashierName || 'unknown';
          const row = map.get(key) || { name: sale.cashierName || 'Unassigned cashier', bills: 0, units: 0, sales: 0, profit: 0 };
          row.bills += 1;
          row.units += sale.items.reduce((sum, item) => sum + item.qty, 0);
          row.sales += sale.total;
          row.profit += sale.profit;
          map.set(key, row);
        });
        return { title: 'Cashier Performance Report', description: 'Completed sales grouped by the cashier recorded on each bill.', columns: ['Cashier', 'Bills', 'Units Sold', 'Sales Value', 'Recorded Profit'], rows: [...map.entries()].sort((a,b)=>b[1].sales-a[1].sales).map(([id,v])=>({id,values:[v.name,v.bills,v.units,money(v.sales),money(v.profit)]})) };
      }
      case 'payment-breakdown': {
        const map = new Map<string, { transactions: number; amount: number }>();
        sales.forEach(sale => {
          const legs = sale.payments?.length ? sale.payments : [{ method: sale.payment, amount: sale.total }];
          legs.forEach(leg => {
            const row = map.get(leg.method) || { transactions: 0, amount: 0 };
            row.transactions += 1;
            row.amount += Number(leg.amount) || 0;
            map.set(leg.method, row);
          });
        });
        return { title: 'Payment Method Breakdown', description: 'Recorded tender amounts from completed bills. Split payments are separated by payment leg.', columns: ['Payment Method', 'Payment Legs', 'Recorded Amount'], rows: [...map.entries()].sort((a,b)=>b[1].amount-a[1].amount).map(([method,v])=>({id:method,values:[method.toUpperCase(),v.transactions,money(v.amount)]})) };
      }
      case 'sales-by-hour': {
        const map = new Map<number, { bills: number; sales: number; units: number }>();
        sales.forEach(sale => {
          const hour = new Date(sale.date).getHours();
          const row = map.get(hour) || { bills: 0, sales: 0, units: 0 };
          row.bills += 1; row.sales += sale.total;
          row.units += sale.items.reduce((sum,item)=>sum+item.qty,0);
          map.set(hour,row);
        });
        return { title: 'Sales by Hour Report', description: 'Completed sales grouped by the local hour recorded on each bill.', columns: ['Hour', 'Bills', 'Units Sold', 'Sales Value'], rows: [...map.entries()].sort((a,b)=>a[0]-b[0]).map(([hour,v])=>({id:String(hour),values:[String(hour).padStart(2,'0')+':00 – '+String((hour+1)%24).padStart(2,'0')+':00',v.bills,v.units,money(v.sales)]})) };
      }
      case 'date-wise-profits': {
        const map = new Map<string,{sales:number;profit:number;bills:number}>();
        sales.forEach(sale=>{const day=dkey(sale.date);const v=map.get(day)||{sales:0,profit:0,bills:0};v.sales+=sale.total;v.profit+=sale.profit;v.bills+=1;map.set(day,v);});
        return { title:'Date Wise Profit Report',description:'Recorded sale profit grouped by bill date. Only completed bills are included.',columns:['Date','Bills','Sales Value','Recorded Profit'],rows:[...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([day,v])=>({id:day,values:[dateText(day),v.bills,money(v.sales),money(v.profit)]})) };
      }
      case 'member-wise-sales': {
        const map=new Map<string,{name:string;bills:number;units:number;sales:number}>();
        sales.forEach(sale=>{const key=sale.customerId||sale.customerName||'walk-in';const v=map.get(key)||{name:sale.customerName||'Walk-in customer',bills:0,units:0,sales:0};v.bills+=1;v.units+=sale.items.reduce((sum,item)=>sum+item.qty,0);v.sales+=sale.total;map.set(key,v);});
        return {title:'Member Wise Sales Report',description:'Sales grouped by the customer/member recorded on each completed bill.',columns:['Customer / Member','Bills','Units','Sales Value'],rows:[...map.entries()].sort((a,b)=>b[1].sales-a[1].sales).map(([id,v])=>({id,values:[v.name,v.bills,v.units,money(v.sales)]}))};
      }
      case 'category-wise-sales': {
        const map=new Map<string,{qty:number;sales:number;profit:number}>();
        sales.forEach(sale=>sale.items.forEach(item=>{const category=state.products.find(p=>p.id===item.productId)?.category||'Uncategorised';const v=map.get(category)||{qty:0,sales:0,profit:0};v.qty+=item.qty;v.sales+=item.qty*item.price-(item.discount||0);v.profit+=item.qty*(item.price-item.cost)-(item.discount||0);map.set(category,v);}));
        return {title:'Category Wise Sales Report',description:'Completed sale lines grouped by the current product category.',columns:['Category','Units Sold','Sales Value','Gross Profit'],rows:[...map.entries()].sort((a,b)=>b[1].sales-a[1].sales).map(([id,v])=>({id,values:[id,v.qty,money(v.sales),money(v.profit)]}))};
      }
      case 'supplier-wise-sales': {
        const map=new Map<string,{qty:number;sales:number;profit:number}>();
        sales.forEach(sale=>sale.items.forEach(item=>{const product=state.products.find(p=>p.id===item.productId);const supplier=state.suppliers.find(s=>s.id===product?.supplierId)?.name||'Unassigned supplier';const v=map.get(supplier)||{qty:0,sales:0,profit:0};v.qty+=item.qty;v.sales+=item.qty*item.price-(item.discount||0);v.profit+=item.qty*(item.price-item.cost)-(item.discount||0);map.set(supplier,v);}));
        return {title:'Supplier Wise Sales Report',description:'Sales grouped by each product’s assigned supplier. This is sales value of those products, not supplier payment history.',columns:['Supplier','Units Sold','Sales Value','Gross Profit'],rows:[...map.entries()].sort((a,b)=>b[1].sales-a[1].sales).map(([id,v])=>({id,values:[id,v.qty,money(v.sales),money(v.profit)]}))};
      }
      case 'item-wise-stock': {
        const products=state.products.filter(p=>p.active&&!p.isService).sort((a,b)=>a.name.localeCompare(b.name));
        return {title:'Item Wise Stock Report',description:'Current stock by product. Values use the product’s current recorded cost and selling price.',columns:['Item','SKU','Category','On Hand','Unit Cost','Stock Cost Value','Selling Price','Stock Retail Value'],rows:products.map(p=>({id:p.id,values:[p.name,p.sku,p.category,p.stock,money(p.cost),money(p.stock*p.cost),money(p.price),money(p.stock*p.price)]}))};
      }
      case 'expired-items': {
        const expired=(state.units||[]).filter(unit=>unit.status==='in_stock'&&unit.expiryDate&&dkey(unit.expiryDate)<today).sort((a,b)=>(a.expiryDate||'').localeCompare(b.expiryDate||''));
        return {title:'Expired Items Report',description:'Tracked individual units currently in stock whose recorded expiry date has passed. Untracked batch expiry is not included.',columns:['Product','IMEI / Serial','Expiry Date','Current Status','Cost'],rows:expired.map(unit=>({id:unit.id,values:[state.products.find(p=>p.id===unit.productId)?.name||'Unknown product',[unit.imei,unit.serial].filter(Boolean).join(' / ')||unit.id,dateText(unit.expiryDate||''),unit.status,money(unit.cost||0)]}))};
      }
      case 'grn-selling': {
        const map=new Map<string,{name:string;received:number;purchaseCost:number;sold:number;salesValue:number;stock:number}>();
        purchases.forEach(purchase=>purchase.items.forEach(item=>{const v=map.get(item.productId)||{name:item.name,received:0,purchaseCost:0,sold:0,salesValue:0,stock:state.products.find(p=>p.id===item.productId)?.stock||0};v.received+=item.qty;v.purchaseCost+=item.qty*item.cost;map.set(item.productId,v);}));
        sales.forEach(sale=>sale.items.forEach(item=>{const v=map.get(item.productId)||{name:item.name,received:0,purchaseCost:0,sold:0,salesValue:0,stock:state.products.find(p=>p.id===item.productId)?.stock||0};v.sold+=item.qty;v.salesValue+=item.qty*item.price-(item.discount||0);map.set(item.productId,v);}));
        return {title:'GRN And Selling Report',description:'Compares received purchase quantities and completed sale quantities for the selected period, alongside current stock.',columns:['Item','Received Qty','Purchase Cost','Sold Qty','Sales Value','Current Stock'],rows:[...map.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([id,v])=>({id,values:[v.name,v.received,money(v.purchaseCost),v.sold,money(v.salesValue),v.stock]}))};
      }
      case 'inventory-movements': {
        const movements = (state.inventoryTransactions || []).filter(tx => inDateRange(tx.occurredAt, from, to)).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));
        return { title: 'Inventory Movement History', description: 'Recorded stock receipts, sales, returns, adjustments and other inventory movements. Quantities are signed: positive adds stock and negative removes stock.', columns: ['Date & Time','Product','Movement','Quantity','Reference','Processed By','Reason'], rows: movements.map(tx=>({id:tx.id,values:[dateText(tx.occurredAt)+' '+new Date(tx.occurredAt).toLocaleTimeString(),state.products.find(p=>p.id===tx.productId)?.name||'Unknown product',tx.type,tx.quantity,tx.referenceNo||tx.referenceId||'—',tx.by||'—',tx.reason||'—']})) };
      }
      case 'supplier-purchase-history': {
        const map = new Map<string,{name:string;grns:number;units:number;value:number;payments:number}>();
        purchases.forEach(purchase=>{
          const key=purchase.supplierId||purchase.supplierName;
          const row=map.get(key)||{name:purchase.supplierName,grns:0,units:0,value:0,payments:0};
          row.grns+=1; row.units+=purchase.items.reduce((sum,item)=>sum+item.qty,0); row.value+=purchase.total; map.set(key,row);
        });
        (state.supplierPayments||[]).filter(payment=>inDateRange(payment.date,from,to)).forEach(payment=>{
          const row=map.get(payment.supplierId);
          if(row) row.payments+=payment.amount;
        });
        return { title:'Supplier Purchase Summary', description:'Received GRNs and supplier payments recorded within the selected period. Payment totals are not automatically allocated to individual invoices.', columns:['Supplier','Received GRNs','Units Received','Purchase Value','Payments Recorded'], rows:[...map.entries()].sort((a,b)=>b[1].value-a[1].value).map(([id,v])=>({id,values:[v.name,v.grns,v.units,money(v.value),money(v.payments)]})) };
      }
      case 'balance-overview': {
        const stockValue=state.products.filter(p=>p.active&&!p.isService).reduce((sum,p)=>sum+p.stock*p.cost,0);
        const receivables=state.customers.reduce((sum,c)=>sum+Math.max(0,c.creditBalance),0);
        const receivedPurchases=state.purchases.filter(p=>p.status==='received').reduce((sum,p)=>sum+p.total,0);
        const supplierPayments=(state.supplierPayments||[]).reduce((sum,p)=>sum+p.amount,0);
        const payables=Math.max(0,receivedPurchases-supplierPayments);
        return {title:'Balance Overview',description:'Limited operational snapshot from recorded POS data; this is not a complete statutory balance sheet.',note:'This view excludes cash and bank balances, fixed assets, loans, taxes, opening balances and other accounting adjustments. Do not use it as a formal financial statement.',columns:['Balance Component','Recorded Amount','Basis'],rows:[{id:'stock',values:['Inventory at cost',money(stockValue),'Current product stock × current unit cost']},{id:'receivables',values:['Customer credit balances',money(receivables),'Sum of positive customer credit balances']},{id:'payables',values:['Estimated supplier payable',money(payables),'Received purchases less all recorded supplier payments; may need opening-balance reconciliation']}]};
      }
      default:
        return {title:'Report not found',description:'Choose a report from the Report Center.',columns:['Status'],rows:[]};
    }
  }, [from,to,reportType,state.customers,state.inventoryTransactions,state.products,state.purchases,state.sales,state.supplierPayments,state.suppliers,state.units,today]);

  const filtered = useMemo(() => {
    const q=search.trim().toLowerCase();
    return dataset.rows.filter(row=>!q||row.values.some(value=>String(value).toLowerCase().includes(q)));
  },[dataset.rows,search]);
  const exportCsv=()=>downloadFile(`NexFix-${reportType}-${from}-to-${to}.csv`,[dataset.columns.map(csv).join(','),...filtered.map(row=>row.values.map(csv).join(','))].join('\n'),'text/csv;charset=utf-8');

  return (
    <div className="report-print">
      <PageHeading chip="Reports" chipTone="violet" title={dataset.title} sub={dataset.description} actions={<div className="flex flex-wrap gap-2"><ReportPrintButton/><button className="btn btn-outline" onClick={exportCsv} disabled={!filtered.length}><Download size={14}/> Export CSV</button></div>}/>
      <div className="card p-4 mb-5 flex flex-wrap items-end gap-3 no-print">
        <label className="text-xs font-semibold text-sub">From date<input type="date" className="input mt-1" value={from} max={to} onChange={event=>setFrom(event.target.value)}/></label>
        <label className="text-xs font-semibold text-sub">To date<input type="date" className="input mt-1" value={to} min={from} onChange={event=>setTo(event.target.value)}/></label>
        <div className="flex-1 min-w-[220px]"><SearchInput value={search} onChange={setSearch} placeholder="Search this report..."/></div>
      </div>
      {dataset.note && <div className="card p-4 mb-5 border-amber-400/40 text-sm text-amber-800">{dataset.note}</div>}
      <div className="card overflow-hidden">
        {filtered.length===0?<div className="p-6"><EmptyState icon={<FileBarChart size={25}/>} title="No report rows found" sub="Try another date range or search term."/></div>:<div className="overflow-x-auto"><table className="w-full min-w-[760px]"><thead><tr>{dataset.columns.map(column=><th className="th" key={column}>{column}</th>)}</tr></thead><tbody>{filtered.map(row=><tr key={row.id}>{row.values.map((value,index)=><td className={index===0?'td font-semibold':'td'} key={index}>{value}</td>)}</tr>)}</tbody></table></div>}
      </div>
      <p className="mt-3 text-xs text-sub">Showing {filtered.length} of {dataset.rows.length} rows · Based on the currently stored POS records.</p>
    </div>
  );
}
