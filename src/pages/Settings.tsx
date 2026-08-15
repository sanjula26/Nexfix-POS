import { useEffect, useRef, useState } from 'react';
import {
  Store, SlidersHorizontal, Database, Download, Upload, RotateCcw,
  CheckCircle2, AlertTriangle, ReceiptText, ShieldCheck, Lock, Eye, EyeOff, MessageCircle,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Modal, Field, PageHeading, Badge, Toggle } from '../components/ui';

export default function Settings() {
  const {
    state, updateSettings, importData, resetData, can, changeAdminPin,
    connectivity, backupMeta, runManualBackup, setAutoBackupHours, flushOfflineQueue, pendingQueueCount,
  } = usePOS();
  const [backupMsg, setBackupMsg] = useState('');
  const [autoHours, setAutoHours] = useState(backupMeta.autoBackupHours);
  useEffect(() => { setAutoHours(backupMeta.autoBackupHours); }, [backupMeta.autoBackupHours]);
  const [form, setForm] = useState(() => {
    const { adminPinHash, ...rest } = state.settings;
    void adminPinHash;
    return rest;
  });
  /* security — admin switch password */
  const [pinCur, setPinCur] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) || 0 : e.target.value }));

  const save = () => {
    updateSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const num = (k: 'taxDefault' | 'lowStockDefault' | 'exchangeDays' | 'openingFloat') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 }));
  void set;

  const submitPin = () => {
    setPinMsg(null);
    if (pinNew !== pinConfirm) return setPinMsg({ ok: false, text: 'New passwords do not match' });
    const res = changeAdminPin(pinCur, pinNew);
    if (!res.ok) return setPinMsg({ ok: false, text: res.error || 'Failed to update password' });
    setPinMsg({ ok: true, text: 'Admin switch password updated' });
    setPinCur(''); setPinNew(''); setPinConfirm('');
  };

  const onImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const ok = importData(String(reader.result));
      setImportMsg(ok ? 'Backup restored successfully' : 'Invalid backup file');
      setTimeout(() => setImportMsg(''), 3000);
    };
    reader.readAsText(file);
  };

  return (
    <div>
      <PageHeading
        chip="System" chipTone="slate"
        title="Settings"
        sub={`${state.settings.shopName} · v3.1`}
        actions={
          <button className="btn btn-primary" onClick={save}>
            <CheckCircle2 size={15} /> {saved ? 'Saved!' : 'Save changes'}
          </button>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
        {/* shop profile */}
        <div className="card p-6">
          <h3 className="font-bold text-ink flex items-center gap-2 mb-5">
            <span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><Store size={15} /></span>
            Shop Profile
          </h3>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Shop name">
                <input className="input" value={form.shopName} onChange={set('shopName')} />
              </Field>
              <Field label="Tagline">
                <input className="input" value={form.tagline} onChange={set('tagline')} />
              </Field>
            </div>
            <Field label="Address">
              <input className="input" value={form.address} onChange={set('address')} />
            </Field>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Phone">
                <input className="input" value={form.phone} onChange={set('phone')} />
              </Field>
              <Field label="Email">
                <input className="input" value={form.email} onChange={set('email')} />
              </Field>
            </div>
            <Field label="Receipt footer">
              <textarea
                className="input min-h-[70px] resize-none"
                value={form.receiptFooter}
                onChange={set('receiptFooter')}
              />
            </Field>
          </div>
        </div>

        <div className="space-y-5">
          {/* pos prefs */}
          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-5">
              <span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><SlidersHorizontal size={15} /></span>
              POS Preferences
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Default tax %">
                <input className="input num" value={form.taxDefault || ''} onChange={num('taxDefault')} />
              </Field>
              <Field label="Low-stock default">
                <input className="input num" value={form.lowStockDefault || ''} onChange={num('lowStockDefault')} />
              </Field>
              <Field label="Exchange window (days)" hint="Bills older than this can't be exchanged">
                <input className="input num" value={form.exchangeDays || ''} onChange={num('exchangeDays')} />
              </Field>
              <Field label="Opening float (Rs.)" hint="Per cashier, per day">
                <input className="input num" value={form.openingFloat || ''} onChange={num('openingFloat')} />
              </Field>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-xl bg-raised border border-line px-4 py-3 mt-4 cursor-pointer">
              <span className="flex items-center gap-2.5 text-sm font-medium text-ink">
                <MessageCircle size={15} className="text-emerald-500" />
                WhatsApp auto-receipt
                <span className="text-[11px] text-faint font-normal">Auto-open after every checkout. Off = cashier chooses per bill ("kamathi nam" toggle)</span>
              </span>
              <Toggle
                checked={form.whatsappReceipts !== false}
                onChange={v => setForm(f => ({ ...f, whatsappReceipts: v }))}
              />
            </label>
          </div>

          {/* security */}
          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2">
              <span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><ShieldCheck size={15} /></span>
              Security
            </h3>
            <p className="text-xs text-faint mb-4">
              Required whenever someone switches the sidebar role from <Badge tone="emerald" className="!text-[9px]">CASHIER</Badge> to <Badge tone="violet" className="!text-[9px]">ADMIN</Badge>.
              Stored as a hash, never in plain text.
            </p>
            <div className="space-y-3.5">
              <Field label="Current password" hint="Demo default: admin123">
                <div className="relative">
                  <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                  <input
                    type={showPins ? 'text' : 'password'}
                    className="input pl-9 pr-10"
                    value={pinCur}
                    onChange={e => { setPinCur(e.target.value); setPinMsg(null); }}
                    placeholder="Current admin switch password"
                  />
                  <button type="button" onClick={() => setShowPins(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink">
                    {showPins ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>
              <div className="grid sm:grid-cols-2 gap-3.5">
                <Field label="New password">
                  <input
                    type={showPins ? 'text' : 'password'}
                    className="input"
                    value={pinNew}
                    onChange={e => { setPinNew(e.target.value); setPinMsg(null); }}
                    placeholder="Min 4 characters"
                  />
                </Field>
                <Field label="Confirm new password">
                  <input
                    type={showPins ? 'text' : 'password'}
                    className="input"
                    value={pinConfirm}
                    onChange={e => { setPinConfirm(e.target.value); setPinMsg(null); }}
                    placeholder="Repeat it"
                    onKeyDown={e => { if (e.key === 'Enter') submitPin(); }}
                  />
                </Field>
              </div>
              {pinMsg && (
                <p className={`flex items-center gap-1.5 text-[13px] font-semibold ${pinMsg.ok ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {pinMsg.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {pinMsg.text}
                </p>
              )}
              <button
                className="btn btn-primary"
                onClick={submitPin}
                disabled={!pinCur || !pinNew || !pinConfirm}
              >
                <ShieldCheck size={15} /> Update switch password
              </button>
            </div>
          </div>

          {/* data */}
          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2">
              <span className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-500 flex items-center justify-center"><Database size={15} /></span>
              Data &amp; Backup
            </h3>
            <p className="text-xs text-faint mb-3">
              Primary store: <b className="text-ink">IndexedDB</b> (large capacity). localStorage kept as fast cache.
              Works fully offline — auto-syncs when the network returns.
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-[11px] font-semibold">
              <span className={`badge ${connectivity === 'online' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-500'}`}>
                {connectivity === 'online' ? '● ONLINE' : '● OFFLINE'}
              </span>
              {pendingQueueCount > 0 && (
                <span className="badge bg-amber-500/15 text-amber-600">{pendingQueueCount} queued write(s)</span>
              )}
              {backupMeta.lastManualBackupAt && (
                <span className="badge bg-sky-500/10 text-sky-600">Last manual: {new Date(backupMeta.lastManualBackupAt).toLocaleString()}</span>
              )}
              {backupMeta.lastAutoBackupAt && (
                <span className="badge bg-violet-500/10 text-violet-600">Last auto: {new Date(backupMeta.lastAutoBackupAt).toLocaleString()}</span>
              )}
            </div>

            <div className="rounded-xl border border-line bg-raised/40 p-3.5 mb-4">
              <div className="text-[12px] font-bold text-ink mb-2">Auto backup interval</div>
              <div className="flex flex-wrap items-center gap-2">
                {[0, 1, 3, 6, 12, 24].map(h => (
                  <button
                    key={h}
                    type="button"
                    className={`btn !py-1.5 !px-3 text-[12px] ${autoHours === h ? 'btn-primary' : 'btn-soft'}`}
                    onClick={async () => {
                      setAutoHours(h);
                      await setAutoBackupHours(h);
                      setBackupMsg(h === 0 ? 'Auto-backup disabled' : `Auto-backup every ${h}h`);
                    }}
                  >
                    {h === 0 ? 'OFF' : `${h}h`}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-faint mt-2">When due, a JSON snapshot is downloaded automatically. Change browser download settings if you want silent saves.</p>
            </div>

            <div className="flex flex-wrap gap-2.5">
              {can('act:export') && (
                <button
                  className="btn btn-soft"
                  onClick={async () => {
                    await runManualBackup();
                    setBackupMsg('Manual backup downloaded');
                  }}
                >
                  <Download size={15} /> Export backup
                </button>
              )}
              <button className="btn btn-soft" onClick={() => fileRef.current?.click()}>
                <Upload size={15} /> Import backup
              </button>
              <input
                ref={fileRef} type="file" accept="application/json" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
              />
              {pendingQueueCount > 0 && connectivity === 'online' && (
                <button
                  className="btn btn-emerald"
                  onClick={async () => {
                    const n = await flushOfflineQueue();
                    setBackupMsg(`Flushed ${n} queued write(s)`);
                  }}
                >
                  Sync now
                </button>
              )}
              <button className="btn btn-danger-soft" onClick={() => setConfirmReset(true)}>
                <RotateCcw size={15} /> Reset demo data
              </button>
            </div>
            {(importMsg || backupMsg) && (
              <p className={`text-[13px] font-medium mt-3 ${(importMsg || backupMsg).includes('success') || (importMsg || backupMsg).includes('downloaded') || (importMsg || backupMsg).includes('Flushed') || (importMsg || backupMsg).includes('Auto') ? 'text-emerald-500' : 'text-rose-500'}`}>
                {importMsg || backupMsg}
              </p>
            )}
          </div>

          {/* receipt preview meta */}
          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-3">
              <span className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center"><ReceiptText size={15} /></span>
              Receipt Identity
            </h3>
            <div className="flex flex-wrap gap-2">
              <Badge tone="violet">{form.shopName}</Badge>
              <Badge tone="slate">{form.phone}</Badge>
              <Badge tone="slate">{form.email}</Badge>
              <Badge tone="amber">{form.exchangeDays}-day exchange policy</Badge>
            </div>
            <p className="text-xs text-faint mt-3">These print on every bill and price tag sheet.</p>
          </div>
        </div>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset all data?" sub="Back to the original demo seed">
        <div className="rounded-xl bg-amber-500/[0.08] border border-amber-500/25 px-4 py-3 flex items-start gap-2.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          Products, sales, customers, expenses and settings will be replaced with the demo dataset. Export a backup first if you need your records.
        </div>
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { resetData(); setConfirmReset(false); }}>
            <RotateCcw size={15} /> Reset everything
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setConfirmReset(false)}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}
