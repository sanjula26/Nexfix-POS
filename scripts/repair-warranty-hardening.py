from pathlib import Path
import re
sfile=Path('src/lib/store.tsx');s=sfile.read_text()
s=s.replace('InventoryUnit, RepairJob, RepairStatus, PurchaseReturn, PurchaseReturnItem,','InventoryUnit, RepairJob, RepairStatus, PurchaseReturn, PurchaseReturnItem, WarrantyClaim, ClaimStatus,')
s=s.replace('  deleteRepair: (id: string) => void;\n','  deleteRepair: (id: string) => void;\n  saveWarrantyClaim: (c: WarrantyClaim) => void;\n')
a=s.index('  const saveRepair = useCallback((r: RepairJob) => {');b=s.index('  const updateRepairStatus = useCallback',a)
fn='''  const saveRepair = useCallback((r: RepairJob) => {
    if (!user) return;
    const repairs=state.repairs||[],exists=repairs.some(x=>x.id===r.id),jobNo=(r.jobNo||'').trim();
    if(!r.customerName.trim()||!r.deviceType.trim()||!r.deviceModel.trim()||!r.fault.trim())return;
    if(!Number.isFinite(r.laborCost)||r.laborCost<0)return;
    if(r.advancePaid!=null&&(!Number.isFinite(r.advancePaid)||r.advancePaid<0))return;
    if(r.warrantyDays!=null&&(!Number.isFinite(r.warrantyDays)||r.warrantyDays<0))return;
    const parts=(r.parts||[]).map(pt=>({...pt,name:pt.name.trim(),qty:Number(pt.qty),cost:Number(pt.cost),productId:pt.productId?.trim()||undefined}));
    if(parts.some(pt=>!pt.name||!Number.isInteger(pt.qty)||pt.qty<=0||!Number.isFinite(pt.cost)||pt.cost<0))return;
    if(jobNo&&repairs.some(x=>x.id!==r.id&&x.jobNo.trim().toLowerCase()===jobNo.toLowerCase()))return;
    const old=repairs.find(x=>x.id===r.id),oldBy=new Map<string,number>(),newBy=new Map<string,number>();
    for(const pt of old?.parts||[])if(pt.productId)oldBy.set(pt.productId,(oldBy.get(pt.productId)||0)+pt.qty);
    for(const pt of parts)if(pt.productId)newBy.set(pt.productId,(newBy.get(pt.productId)||0)+pt.qty);
    for(const id of new Set([...oldBy.keys(),...newBy.keys()])){const d=(newBy.get(id)||0)-(oldBy.get(id)||0),p=state.products.find(x=>x.id===id);if(!p||p.stock-d<0)return;}
    setState(st=>{let job:RepairJob={...r,jobNo:jobNo||r.jobNo,parts,by:r.by||user.name};let counters=st.counters;if(!exists&&(!job.jobNo||job.jobNo.startsWith('JOB-TEMP'))){const seq=(st.counters.job||0)+1;job={...job,jobNo:`JOB-${String(seq).padStart(4,'0')}`};counters={...st.counters,job:seq};}const products=st.products.map(p=>{const d=(newBy.get(p.id)||0)-(oldBy.get(p.id)||0);return d?{...p,stock:p.stock-d}:p;});return {...st,products,counters,repairs:exists?(st.repairs||[]).map(x=>x.id===r.id?job:x):[job,...(st.repairs||[])]};});
    pushAudit(exists?'UPDATE':'CREATE','Repair',`${exists?'Updated':'Opened'} ${jobNo||'job'} · ${r.deviceBrand} ${r.deviceModel}`);
  }, [state.repairs,state.products,pushAudit,user]);

'''
s=s[:a]+fn+s[b:]
a=s.index('  const deleteRepair = useCallback((id: string) => {');b=s.index('  const saveCategory = useCallback',a)
fn='''  const deleteRepair = useCallback((id: string) => {
    if(!can('act:deleteRecords'))return;const repair=(state.repairs||[]).find(x=>x.id===id);if(!repair||!['cancelled','delivered'].includes(repair.status))return;
    setState(st=>{const used=new Map<string,number>();for(const pt of repair.parts||[])if(pt.productId)used.set(pt.productId,(used.get(pt.productId)||0)+pt.qty);const products=st.products.map(p=>{const q=used.get(p.id)||0;return q?{...p,stock:p.stock+q}:p;});return {...st,products,repairs:(st.repairs||[]).filter(x=>x.id!==id)};});pushAudit('DELETE','Repair',`Deleted ${repair.jobNo}`);
  }, [state.repairs,pushAudit,can]);

  const saveWarrantyClaim = useCallback((c: WarrantyClaim) => {
    if(!user)return;const claims=state.warrantyClaims||[],exists=claims.some(x=>x.id===c.id),no=(c.claimNo||'').trim();const valid:ClaimStatus[]=['open','approved','rejected','replaced','repaired','closed'];
    if(!c.productName.trim()||!c.issueDescription.trim()||!valid.includes(c.status))return;if(no&&claims.some(x=>x.id!==c.id&&x.claimNo.trim().toLowerCase()===no.toLowerCase()))return;
    setState(st=>{let claim:WarrantyClaim={...c,productName:c.productName.trim(),issueDescription:c.issueDescription.trim(),claimNo:no||c.claimNo,by:c.by||user.name};let counters=st.counters;if(!exists&&(!claim.claimNo||claim.claimNo==='CL-TEMP')){const seq=(st.counters.claim||0)+1;claim={...claim,claimNo:`CL-${String(seq).padStart(4,'0')}`};counters={...st.counters,claim:seq};}claim=claim.status==='closed'?{...claim,closedAt:claim.closedAt||new Date().toISOString()}:{...claim,closedAt:undefined};return {...st,counters,warrantyClaims:exists?(st.warrantyClaims||[]).map(x=>x.id===c.id?claim:x):[claim,...(st.warrantyClaims||[])]};});
    pushAudit(exists?'UPDATE':'CREATE','WarrantyClaim',`${exists?'Updated':'Created'} ${no||'claim'} · ${c.productName}`);
  }, [state.warrantyClaims,pushAudit,user]);

'''
s=s[:a]+fn+s[b:]
s=s.replace('    saveRepair, updateRepairStatus, deleteRepair,','    saveRepair, updateRepairStatus, deleteRepair, saveWarrantyClaim,')
sfile.write_text(s)
page=Path('src/pages/WarrantyClaims.tsx');p=page.read_text();p=p.replace("  const { state, user, logAudit } = usePOS();","  const { state, user, saveWarrantyClaim } = usePOS();");p=re.sub(r"\nfunction loadClaims\(\): WarrantyClaim\[\] \{.*?\n\}\n\nfunction persistClaims\(list: WarrantyClaim\[\], countersPatch\?: Record<string, number>\) \{.*?\n\}\n","\n",p,flags=re.S);p=p.replace("  const [claims, setClaims] = useState<WarrantyClaim[]>(() => state.warrantyClaims?.length ? state.warrantyClaims : loadClaims());","  const claims = state.warrantyClaims || [];");p=re.sub(r"    const next = isNew \? \[saved, \.\.\.claims\] : claims\.map\(x => x\.id === saved\.id \? saved : x\);\n    setClaims\(next\);\n    persistClaims\(next, isNew \? \{ claim: seq \} : undefined\);\n    logAudit\(isNew \? 'CREATE' : 'UPDATE', 'WarrantyClaim', `\$\{saved\.claimNo\} · \$\{saved\.productName\}`\);","    saveWarrantyClaim(saved);",p);p=p.replace("  }, [claims, isNew, state.counters, logAudit, user]);","  }, [claims, isNew, state.counters, saveWarrantyClaim, user]);");page.write_text(p)
