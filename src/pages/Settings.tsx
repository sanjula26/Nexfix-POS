import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Store, Database, Download, Upload, RotateCcw, Cloud, SlidersHorizontal, Copy,
  CheckCircle2, AlertTriangle, ReceiptText, ShieldCheck, Lock, Eye, EyeOff, MessageCircle,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Modal, Field, PageHeading, Badge, Toggle } from '../components/ui';
import {
  isGoogleSyncEnabled, getGoogleScriptUrl, fetchLatestGoogleBackup, getLocalShopId, getDriveShopId, setExistingDriveShopId as saveExistingDriveShopId, adoptBackupShopId,
} from '../lib/driveSync';
import { decryptBackupEnvelope, getBackupSecurityMessage, getRecoveryKey, hasRecoveryKey, isEncryptedBackupEnvelope, setRecoveryKey, sha256Hex } from '../lib/backupCrypto';
import { applyBackupRestore } from '../lib/restore';
import { downloadBackup } from '../lib/backup';
import { queueWrite } from '../lib/offline';
import { uid } from '../lib/utils';

export default function Settings() {
  const navigate = useNavigate();
  const {
    state, user, updateSettings, resetData, can, changeAdminPin, changeManagedPassword,
    connectivity, backupMeta, runManualBackup, setAutoBackupHours, flushOfflineQueue, pendingQueueCount,
  } = usePOS();
  const [backupMsg, setBackupMsg] = useState('');
  const [autoHours, setAutoHours] = useState(backupMeta.autoBackupHours ?? 6);
  const gEnabled = isGoogleSyncEnabled();
  const [gMsg, setGMsg] = useState('');
  const [gRestoreBusy, setGRestoreBusy] = useState(false);
  const [confirmGoogleRestore, setConfirmGoogleRestore] = useState<{
    state: unknown;
    backedUpAt?: string;
    kind?: string;
    shopId?: string;
    shopPartition?: string;
    shopName?: string;
  } | null>(null);
  const [driveShopId, setDriveShopId] = useState(() => getDriveShopId());
  const [existingDriveShopId, setExistingDriveShopId] = useState('');
  const [shopIdMsg, setShopIdMsg] = useState('');
  const [shopIdCopied, setShopIdCopied] = useState(false);
  const [form, setForm] = useState(() => {
    const { adminPinHash, ...rest } = state.settings;
    void adminPinHash;
    return {
      shopName: rest.shopName || '', tagline: rest.tagline || '', address: rest.address || '', phone: rest.phone || '', email: rest.email || '',
      receiptFooter: rest.receiptFooter || '', taxDefault: rest.taxDefault ?? 0, lowStockDefault: rest.lowStockDefault ?? 5,
      exchangeDays: rest.exchangeDays ?? 7, openingFloat: rest.openingFloat ?? 0, loyaltyPointsPerRs: rest.loyaltyPointsPerRs ?? 0.001, loyaltyPointValue: rest.loyaltyPointValue ?? 20, whatsappReceipts: rest.whatsappReceipts !== false,
      categories: rest.categories, brands: rest.brands, repairWarrantyDays: rest.repairWarrantyDays,
      invoiceTitle: rest.invoiceTitle || 'INVOICE', invoiceSubtitle: rest.invoiceSubtitle || rest.tagline || 'COMPUTER & PHONE SHOP',
      invoiceCurrency: rest.invoiceCurrency || 'Rs.', invoiceTaxLabel: rest.invoiceTaxLabel || 'Tax',
      invoiceTerms: rest.invoiceTerms || '', invoiceFooter: rest.invoiceFooter || rest.receiptFooter || 'Thank you for your purchase!',
      invoiceShowTax: rest.invoiceShowTax !== false, taxRegistrationNo: rest.taxRegistrationNo || '', invoicePlaceOfSupply: rest.invoicePlaceOfSupply || '', promotions: rest.promotions || [],
    };
  });
  const [pinCur, setPinCur] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [securityRole, setSecurityRole] = useState<'admin' | 'cashier'>('admin');
  const [securityUserId, setSecurityUserId] = useState('');
  const [accountNew, setAccountNew] = useState('');
  const [accountConfirm, setAccountConfirm] = useState('');
  const [accountMsg, setAccountMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [recoveryKeyMsg, setRecoveryKeyMsg] = useState('');
  const [recoveryKeyReady, setRecoveryKeyReady] = useState(() => hasRecoveryKey());
  const [recoveryKeyCopied, setRecoveryKeyCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');

  useEffect(() => { setAutoHours(backupMeta.autoBackupHours ?? 6); }, [backupMeta.autoBackupHours]);
  const securityAccounts = state.users.filter(u => (u.role === securityRole) && u.active);
  useEffect(() => {
    const first = securityAccounts[0]?.id || '';
    if (!securityAccounts.some(u => u.id === securityUserId)) setSecurityUserId(first);
  }, [securityRole, state.users, securityUserId]);
  useEffect(() => {
    const s = state.settings;
    if (!s) return;
    setForm(f => ({
      ...f, shopName: s.shopName || f.shopName, tagline: s.tagline || f.tagline, address: s.address || f.address,
      phone: s.phone || f.phone, email: s.email || f.email, receiptFooter: s.receiptFooter || f.receiptFooter,
      taxDefault: s.taxDefault ?? f.taxDefault, lowStockDefault: s.lowStockDefault ?? f.lowStockDefault,
      exchangeDays: s.exchangeDays ?? f.exchangeDays, openingFloat: s.openingFloat ?? f.openingFloat, loyaltyPointsPerRs: s.loyaltyPointsPerRs ?? f.loyaltyPointsPerRs, loyaltyPointValue: s.loyaltyPointValue ?? f.loyaltyPointValue,
      whatsappReceipts: s.whatsappReceipts !== false, invoiceTitle: s.invoiceTitle || f.invoiceTitle,
      invoiceSubtitle: s.invoiceSubtitle || f.invoiceSubtitle, invoiceCurrency: s.invoiceCurrency || f.invoiceCurrency,
      invoiceTaxLabel: s.invoiceTaxLabel || f.invoiceTaxLabel, invoiceTerms: s.invoiceTerms ?? f.invoiceTerms,
      invoiceFooter: s.invoiceFooter || f.invoiceFooter, invoiceShowTax: s.invoiceShowTax !== false,
      taxRegistrationNo: s.taxRegistrationNo ?? f.taxRegistrationNo, invoicePlaceOfSupply: s.invoicePlaceOfSupply ?? f.invoicePlaceOfSupply,
    }));
  }, [state.settings.shopName, state.settings.phone, state.settings.email, state.settings.invoiceTitle, state.settings.invoiceTerms]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) || 0 : e.target.value }));

  const save = () => {
    const taxDefault = Number(form.taxDefault);
    const lowStockDefault = Number(form.lowStockDefault);
    const exchangeDays = Number(form.exchangeDays);
    const openingFloat = Number(form.openingFloat);
    const loyaltyPointsPerRs = Number(form.loyaltyPointsPerRs);
    const loyaltyPointValue = Number(form.loyaltyPointValue);
    if (!Number.isFinite(taxDefault) || taxDefault < 0 || taxDefault > 100) return setBackupMsg('Default tax must be between 0% and 100%');
    if (!Number.isFinite(lowStockDefault) || !Number.isInteger(lowStockDefault) || lowStockDefault < 0) return setBackupMsg('Low-stock default must be a whole number of 0 or more');
    if (!Number.isFinite(exchangeDays) || !Number.isInteger(exchangeDays) || exchangeDays < 0) return setBackupMsg('Exchange window must be a whole number of 0 or more days');
    if (!Number.isFinite(openingFloat) || openingFloat < 0) return setBackupMsg('Opening float cannot be negative');
    if (!Number.isFinite(loyaltyPointsPerRs) || loyaltyPointsPerRs < 0 || loyaltyPointsPerRs > 10) return setBackupMsg('Loyalty points per Rs must be between 0 and 10');
    if (!Number.isFinite(loyaltyPointValue) || loyaltyPointValue < 0) return setBackupMsg('Loyalty point value cannot be negative');
    const promotions = (form.promotions || []).map(p => ({ ...p, name: p.name.trim(), category: p.category.trim(), discountPct: Number(p.discountPct) }));
    if (promotions.some(p => !p.name || !p.category || !Number.isFinite(p.discountPct) || p.discountPct <= 0 || p.discountPct > 100 || (p.startDate && p.endDate && p.endDate < p.startDate))) return setBackupMsg('Check promotion name, category, discount (1–100%) and dates');
    setBackupMsg('');
    updateSettings({ ...form, taxDefault, lowStockDefault, exchangeDays, openingFloat, loyaltyPointsPerRs, loyaltyPointValue, promotions }); setSaved(true); setTimeout(() => setSaved(false), 2000);
  };
  const num = (k: 'taxDefault' | 'lowStockDefault' | 'exchangeDays' | 'openingFloat' | 'loyaltyPointsPerRs' | 'loyaltyPointValue') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 }));

  const copyShopBackupId = async () => {
    const id = getLocalShopId();
    if (!id) return setShopIdMsg('Shop Backup ID is not available in this browser.');
    try {
      await navigator.clipboard.writeText(id);
      setDriveShopId(id);
      setShopIdCopied(true);
      setShopIdMsg('Shop Backup ID copied.');
      window.setTimeout(() => setShopIdCopied(false), 2000);
    } catch {
      setShopIdMsg('Copy failed. Select and copy the ID manually.');
    }
  };

  const useExistingShopBackupId = () => {
    const result = saveExistingDriveShopId(existingDriveShopId);
    if (!result.ok) {
      setShopIdMsg(result.error || 'Invalid Shop Backup ID');
      return;
    }
    const id = getLocalShopId();
    setDriveShopId(id);
    setExistingDriveShopId('');
    setShopIdMsg('Existing Shop Backup ID saved. This browser will use that shop partition for Google Drive backup and restore.');
  };

  const submitManagedPassword = async () => {
    setAccountMsg(null);
    if (!securityUserId) return setAccountMsg({ ok: false, text: 'No active ' + securityRole + ' account is available' });
    if (accountNew.length < 12) return setAccountMsg({ ok: false, text: 'Password must be at least 12 characters' });
    if (accountNew !== accountConfirm) return setAccountMsg({ ok: false, text: 'Passwords do not match' });
    const res = await changeManagedPassword(securityUserId, accountNew);
    if (!res.ok) return setAccountMsg({ ok: false, text: res.error || 'Failed to update login password' });
    setAccountMsg({ ok: true, text: (securityRole === 'admin' ? 'Admin' : 'Cashier') + ' login password updated' });
    setAccountNew(''); setAccountConfirm('');
  };
  const submitPin = () => {
    setPinMsg(null);
    if (pinNew !== pinConfirm) return setPinMsg({ ok: false, text: 'New passwords do not match' });
    const res = changeAdminPin(pinCur, pinNew);
    if (!res.ok) return setPinMsg({ ok: false, text: res.error || 'Failed to update password' });
    setPinMsg({ ok: true, text: 'Admin unlock PIN updated' });
    setPinCur(''); setPinNew(''); setPinConfirm('');
  };

  const onImport = (files: File[]) => {
    if (!user || user.role !== 'admin') {
      setImportMsg('Backup restore requires admin access');
      return;
    }
    if (!files.length) return;
    if (!window.confirm('Import this backup? Current local POS data will be replaced. A safety checkpoint will be created first.')) return;

    const readFile = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read backup file: ' + file.name));
      reader.readAsText(file);
    });

    const importBackupFiles = async () => {
      setImportMsg('Validating backup and creating safety checkpoint…');
      const texts = new Map<string, string>();
      for (const file of files) texts.set(file.name, await readFile(file));

      // A downloaded RECOVERY_KEY.txt can be selected together with the backup.
      // Do not replace the currently working local key until the backup has been
      // fully validated, decrypted, persisted, and the restore has succeeded.
      // Otherwise a failed/mismatched key file could strand this browser from
      // its existing automatic backups.
      const previousRecoveryKey = getRecoveryKey();
      let importedRecoveryKey: string | undefined;
      for (const [name, text] of texts) {
        if (!name.toLowerCase().includes('recovery_key') && !text.includes('NEXFIX POS - RECOVERY KEY')) continue;
        const match = text.match(/^Recovery Key:\s*([A-Za-z0-9_-]{43})\s*$/m);
        if (match) {
          importedRecoveryKey = match[1];
          break;
        }
      }
      if (importedRecoveryKey) {
        const result = setRecoveryKey(importedRecoveryKey);
        if (!result.ok) throw new Error(result.error || 'Invalid Recovery Key file.');
      }

      let parsed: unknown;
      const jsonCandidates = files
        .filter(file => file.name.toLowerCase().endsWith('.json'))
        .map(file => texts.get(file.name) || '')
        .filter(value => value.trim());
      const firstJson = jsonCandidates[0] || Array.from(texts.values()).find(value => value.trim());
      if (!firstJson) throw new Error('Backup file is empty.');
      try { parsed = JSON.parse(firstJson); } catch { throw new Error('Backup file is not valid JSON. Select the .json backup or multipart manifest together with its .part files.'); }

      let restoreInput: unknown = parsed;
      const candidate = parsed as Record<string, unknown> | null;
      const adoptImportedShop = (shopId: unknown) => {
        if (typeof shopId !== 'string' || !shopId.trim()) throw new Error('Backup does not contain a valid Shop Backup ID.');
        const result = adoptBackupShopId(shopId);
        if (!result.ok) throw new Error(result.error || 'Could not connect this PC to the backup shop.');
      };

      // Google Drive encrypted single-file backup: {_meta, payload: AES envelope}.
      if (candidate && typeof candidate === 'object' && candidate._meta && candidate.payload) {
        const meta = candidate._meta as Record<string, unknown>;
        if (meta.encrypted === true && isEncryptedBackupEnvelope(candidate.payload)) {
          const decrypted = await decryptBackupEnvelope(candidate.payload);
          restoreInput = { __nexfixCloudSafe: true, state: decrypted };
        }
      // Google Drive multipart backup: select the manifest plus all .partNNN files.
      } else if (candidate && typeof candidate === 'object' && candidate.encrypted === true && Array.isArray(candidate.partNames)) {
        const manifest = candidate as {
          encrypted: boolean; shopId?: string; shopPartition?: string; backupId?: string;
          totalBytes?: number; parts?: number; totalParts?: number; partNames: string[]; sha256?: string;
        };
        const expectedParts = Number(manifest.parts ?? manifest.totalParts);
        if (!manifest.backupId || !Number.isInteger(expectedParts) || expectedParts < 1
          || manifest.partNames.length !== expectedParts || !manifest.sha256) {
          throw new Error('Invalid multipart backup manifest.');
        }
        const chunks = manifest.partNames.map(name => texts.get(name));
        if (chunks.some(chunk => typeof chunk !== 'string')) throw new Error('Multipart restore requires the manifest and every listed .part file.');
        const rawPayload = chunks.join('');
        if (new TextEncoder().encode(rawPayload).byteLength !== Number(manifest.totalBytes)) throw new Error('Multipart backup size verification failed.');
        if (await sha256Hex(rawPayload) !== manifest.sha256) throw new Error('Multipart backup integrity check failed. Restore was cancelled.');
        let envelope: unknown;
        try { envelope = JSON.parse(rawPayload); } catch { throw new Error('Multipart encrypted payload is not valid JSON.'); }
        if (!isEncryptedBackupEnvelope(envelope)) throw new Error('Multipart encrypted backup envelope is invalid.');
        const decrypted = await decryptBackupEnvelope(envelope);
        restoreInput = { __nexfixCloudSafe: true, state: decrypted };
      } else if (isEncryptedBackupEnvelope(parsed)) {
        const decrypted = await decryptBackupEnvelope(parsed);
        restoreInput = { __nexfixCloudSafe: true, state: decrypted };
      }

      try {
        await applyBackupRestore(state, restoreInput);
      } catch (error) {
        // A failed restore must not leave a newly imported Recovery Key active.
        // Restore the key that was already working on this browser.
        if (importedRecoveryKey && importedRecoveryKey !== previousRecoveryKey) {
          if (previousRecoveryKey) setRecoveryKey(previousRecoveryKey);
          else {
            try { localStorage.removeItem('nexfix_backup_recovery_key_v1'); } catch { /* ignore */ }
          }
          setRecoveryKeyReady(Boolean(previousRecoveryKey));
        }
        throw error;
      }

      if (importedRecoveryKey) setRecoveryKeyReady(true);

      // Bind a recovered PC to the imported shop only after the restore has
      // been fully validated, decrypted, persisted, and checkpoint-cleared.
      if (isEncryptedBackupEnvelope(parsed)) {
        adoptImportedShop(parsed.shopId);
      } else if (candidate && typeof candidate === 'object' && candidate._meta && candidate.payload
        && (candidate._meta as Record<string, unknown>).encrypted === true
        && isEncryptedBackupEnvelope(candidate.payload)) {
        adoptImportedShop(candidate.payload.shopId);
      } else if (candidate && typeof candidate === 'object' && candidate.encrypted === true
        && Array.isArray(candidate.partNames)) {
        let importedEnvelope: unknown = null;
        try {
          const importedRaw = (candidate.partNames as string[]).map(name => texts.get(name) || '').join('');
          importedEnvelope = JSON.parse(importedRaw);
        } catch {
          importedEnvelope = null;
        }
        if (isEncryptedBackupEnvelope(importedEnvelope)) adoptImportedShop(importedEnvelope.shopId);
      }

      await queueWrite('backup_restore');
      setImportMsg('Backup restored safely. Reloading…');
      window.setTimeout(() => window.location.reload(), 450);
    };

    void importBackupFiles().catch(error => {
      const message = error instanceof Error ? error.message : 'Restore failed';
      setImportMsg(message);
      window.setTimeout(() => setImportMsg(''), 5000);
    });
  };

  const runGoogleBackupNow = async () => {
    if (!user || user.role !== 'admin') return setGMsg('Google backup test requires admin access');
    if (!gEnabled || !getGoogleScriptUrl()) return setGMsg('Central Google Drive backup is not available');
    if (connectivity !== 'online') return setGMsg('Google backup requires an online connection');
        setGRestoreBusy(true);
    setGMsg('Sending backup to Google Drive…');
    try {
      const result = await downloadBackup(state, 'manual', { download: false, cloud: true });
      if (result.cloud) {
        setRecoveryKeyReady(hasRecoveryKey());
        setGMsg('Google Drive backup completed successfully.');
      } else {
        setGMsg(result.error || 'Google Drive backup failed. No backup was uploaded.');
      }
    } catch (error) {
      setGMsg(error instanceof Error ? error.message : 'Google Drive backup failed');
    } finally {
      setGRestoreBusy(false);
    }
  };

  const requestGoogleRestore = async () => {
    if (!user || user.role !== 'admin') return setGMsg('Cloud restore requires admin access');
    if (!gEnabled) return setGMsg('Google Drive backup is not available in this build');
    if (connectivity !== 'online') return setGMsg('Google restore requires an online connection');
    if (!getGoogleScriptUrl()) return setGMsg('Central Google Drive backup is not configured');
    if (!hasRecoveryKey()) return setGMsg('Recovery Key is required for automatic encrypted restore. Paste the Recovery Key from RECOVERY_KEY.txt in the Shop Backup Identity section first.');
    const currentShopId = getLocalShopId();
    if (!currentShopId) return setGMsg('Shop Backup ID is missing. Set one before restoring Google Drive data.');
    setGRestoreBusy(true);
    setGMsg('Reading the latest Google backup…');
    try {
      const latest = await fetchLatestGoogleBackup();
      if (!latest || !latest.shopId || !latest.shopPartition) {
        setGMsg('No valid Google Drive backup was found for this shop, or the backup has no shop identity.');
        return;
      }
      if (latest.shopId !== currentShopId) {
        setGMsg('Restore refused: the Google backup belongs to a different shop identity.');
        return;
      }
      setConfirmGoogleRestore(latest);
      setGMsg('Latest cloud backup loaded. Confirm the restore before replacing local data.');
    } catch (error) {
      setGMsg(error instanceof Error ? error.message : 'Could not read the Google backup');
    } finally {
      setGRestoreBusy(false);
    }
  };

  const confirmGoogleRestoreNow = async () => {
    if (!user || user.role !== 'admin') {
      setGMsg('Cloud restore requires admin access');
      return;
    }
    if (!confirmGoogleRestore) return;
    const currentShopId = getLocalShopId();
    if (!currentShopId || confirmGoogleRestore.shopId !== currentShopId) {
      setConfirmGoogleRestore(null);
      setGMsg('Restore refused: the current Shop Backup ID no longer matches the selected backup.');
      return;
    }
    setGRestoreBusy(true);
    setGMsg('Validating cloud backup and creating safety checkpoint…');
    try {
      await applyBackupRestore(state, confirmGoogleRestore.state);
      await queueWrite('google_backup_restore');
      setConfirmGoogleRestore(null);
      setGMsg('Google backup restored safely. Reloading…');
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) {
      setGMsg(error instanceof Error ? error.message : 'Google restore failed');
      setConfirmGoogleRestore(null);
    } finally {
      setGRestoreBusy(false);
    }
  };

  return (
    <div>
      {user?.role === 'admin' && (
        <section className="mb-4 rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-black text-violet-900">Phone Sales Links</div>
              <p className="mt-1 text-xs leading-relaxed text-violet-700">View and copy the phone sales link for this POS machine. Other machine links are not shown here.</p>
            </div>
            <button type="button" onClick={() => navigate('/today-links')} className="min-h-11 rounded-xl bg-violet-600 px-4 text-xs font-bold text-white">Manage machine links</button>
          </div>
        </section>
      )}
      <PageHeading chip="System" chipTone="slate" title="Settings" sub={`${state.settings.shopName} · v3.2`} actions={<button className="btn btn-primary" onClick={save}><CheckCircle2 size={15} /> {saved ? 'Saved!' : 'Save changes'}</button>} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
        <div className="card p-6">
          <h3 className="font-bold text-ink flex items-center gap-2 mb-5"><span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><Store size={15} /></span>Shop Profile</h3>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4"><Field label="Shop name"><input className="input" value={form.shopName ?? ''} onChange={set('shopName')} /></Field><Field label="Tagline"><input className="input" value={form.tagline ?? ''} onChange={set('tagline')} /></Field></div>
            <Field label="Address"><input className="input" value={form.address ?? ''} onChange={set('address')} /></Field>
            <div className="grid sm:grid-cols-2 gap-4"><Field label="Phone"><input className="input" value={form.phone ?? ''} onChange={set('phone')} /></Field><Field label="Email"><input className="input" value={form.email ?? ''} onChange={set('email')} /></Field></div>
            <Field label="Receipt footer"><textarea className="input min-h-[70px] resize-none" value={form.receiptFooter ?? ''} onChange={set('receiptFooter')} /></Field>
          </div>
        </div>

        <div className="space-y-5">
          <div className="card p-6 border border-sky-500/20">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-600 flex items-center justify-center"><ReceiptText size={15} /></span>A4 Invoice Design</h3>
            <p className="text-xs text-faint mb-4">This controls the professional A4 invoice. Each shop can use its own business identity; no product photos are printed in the item table.</p>
            <div className="space-y-3.5">
              <div className="grid sm:grid-cols-2 gap-3.5"><Field label="Invoice title"><input className="input" value={form.invoiceTitle ?? ''} onChange={set('invoiceTitle')} placeholder="INVOICE / TAX INVOICE" /></Field><Field label="Invoice subtitle"><input className="input" value={form.invoiceSubtitle ?? ''} onChange={set('invoiceSubtitle')} placeholder="COMPUTER & PHONE SHOP" /></Field></div>
              <div className="grid sm:grid-cols-2 gap-3.5"><Field label="Currency label"><input className="input" value={form.invoiceCurrency ?? ''} onChange={set('invoiceCurrency')} placeholder="Rs." /></Field><Field label="Tax label"><input className="input" value={form.invoiceTaxLabel ?? ''} onChange={set('invoiceTaxLabel')} placeholder="VAT" /></Field></div>
              <div className="grid sm:grid-cols-2 gap-3.5"><Field label="Tax registration / TIN" hint="Leave blank when not applicable"><input className="input" value={form.taxRegistrationNo ?? ''} onChange={set('taxRegistrationNo')} /></Field><Field label="Place of supply"><input className="input" value={form.invoicePlaceOfSupply ?? ''} onChange={set('invoicePlaceOfSupply')} /></Field></div>
              <Field label="Invoice terms & conditions" hint="One line per condition"><textarea className="input min-h-[90px] resize-y" value={form.invoiceTerms ?? ''} onChange={set('invoiceTerms')} /></Field>
              <Field label="Invoice footer"><textarea className="input min-h-[65px] resize-y" value={form.invoiceFooter ?? ''} onChange={set('invoiceFooter')} /></Field>
              <label className="flex items-center justify-between gap-3 rounded-xl bg-raised border border-line px-4 py-3 cursor-pointer"><span className="text-sm font-medium text-ink">Show tax line on A4 invoice</span><Toggle checked={form.invoiceShowTax !== false} onChange={v => setForm(f => ({ ...f, invoiceShowTax: v }))} /></label>
            </div>
          </div>

          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-5"><span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><SlidersHorizontal size={15} /></span>POS Preferences</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Default tax %"><input type="number" min="0" max="100" step="0.01" className="input num" value={form.taxDefault || ''} onChange={num('taxDefault')} /></Field>
              <Field label="Low-stock default"><input type="number" min="0" step="1" className="input num" value={form.lowStockDefault || ''} onChange={num('lowStockDefault')} /></Field>
              <Field label="Exchange window (days)" hint="Bills older than this can't be exchanged"><input type="number" min="0" step="1" className="input num" value={form.exchangeDays || ''} onChange={num('exchangeDays')} /></Field>
              <Field label="Opening float (Rs.)" hint="Per cashier, per day"><input type="number" min="0" step="0.01" className="input num" value={form.openingFloat || ''} onChange={num('openingFloat')} /></Field>
              <Field label="Loyalty points per Rs. 1" hint="Example: 0.001 = 1 point per Rs. 1,000"><input type="number" min="0" max="10" step="0.001" className="input num" value={form.loyaltyPointsPerRs || ''} onChange={num('loyaltyPointsPerRs')} /></Field>
              <Field label="Value of 1 loyalty point (Rs.)" hint="Used when redeeming points at POS"><input type="number" min="0" step="0.01" className="input num" value={form.loyaltyPointValue || ''} onChange={num('loyaltyPointValue')} /></Field>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-xl bg-raised border border-line px-4 py-3 mt-4 cursor-pointer"><span className="flex items-center gap-2.5 text-sm font-medium text-ink"><MessageCircle size={15} className="text-emerald-500" /> WhatsApp auto-receipt <span className="text-[11px] text-faint font-normal">Auto-open after every checkout. Off = cashier chooses per bill</span></span><Toggle checked={form.whatsappReceipts !== false} onChange={v => setForm(f => ({ ...f, whatsappReceipts: v }))} /></label>
          </div>

          <div className="card p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div><h3 className="font-bold text-ink">Promotions</h3><p className="text-xs text-faint mt-1">Optional category percentage discounts. Active date range is applied automatically at POS.</p></div>
              <button type="button" className="btn btn-soft" onClick={() => setForm(f => ({ ...f, promotions: [...(f.promotions || []), { id: uid(), name: '', category: '', discountPct: 10, startDate: '', endDate: '', active: true }] }))}>Add promotion</button>
            </div>
            <div className="space-y-3">
              {(form.promotions || []).length === 0 && <div className="text-xs text-faint rounded-xl border border-dashed border-line p-4">No promotions configured.</div>}
              {(form.promotions || []).map((p, i) => <div key={p.id} className="rounded-xl border border-line p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Name"><input className="input" value={p.name} onChange={e => setForm(f => ({ ...f, promotions: (f.promotions || []).map((x, n) => n === i ? { ...x, name: e.target.value } : x) }))} placeholder="Weekend Accessories" /></Field>
                  <Field label="Category"><select className="input" value={p.category} onChange={e => setForm(f => ({ ...f, promotions: (f.promotions || []).map((x, n) => n === i ? { ...x, category: e.target.value } : x) }))}><option value="">Select category…</option>{(state.settings.categories || []).map(cat => <option key={cat} value={cat}>{cat}</option>)}</select></Field>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Field label="Discount %"><input type="number" min="1" max="100" step="0.01" className="input num" value={p.discountPct} onChange={e => setForm(f => ({ ...f, promotions: (f.promotions || []).map((x, n) => n === i ? { ...x, discountPct: Number(e.target.value) || 0 } : x) }))} /></Field>
                  <Field label="Start date"><input type="date" className="input" value={p.startDate || ''} onChange={e => setForm(f => ({ ...f, promotions: (f.promotions || []).map((x, n) => n === i ? { ...x, startDate: e.target.value || undefined } : x) }))} /></Field>
                  <Field label="End date"><input type="date" className="input" value={p.endDate || ''} onChange={e => setForm(f => ({ ...f, promotions: (f.promotions || []).map((x, n) => n === i ? { ...x, endDate: e.target.value || undefined } : x) }))} /></Field>
                  <div className="flex items-end gap-2"><label className="flex-1 flex items-center justify-between rounded-xl bg-raised border border-line px-3 py-2 text-xs font-semibold text-ink">Active <Toggle checked={p.active !== false} onChange={v => setForm(f => ({ ...f, promotions: (f.promotions || []).map((x, n) => n === i ? { ...x, active: v } : x) }))} /></label><button type="button" className="btn btn-danger-soft" onClick={() => setForm(f => ({ ...f, promotions: (f.promotions || []).filter((_, n) => n !== i) }))}>Remove</button></div>
                </div>
              </div>)}
            </div>
          </div>

          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><ShieldCheck size={15} /></span>Security</h3>
            <p className="text-xs text-faint mb-4">Manage the real login passwords for the <b>ADMIN</b> and <b>CASHIER</b> accounts from one place. The selected account's password is always stored as a PBKDF2 hash and is never shown.</p>

            <div className="rounded-xl border border-line bg-raised p-1.5 grid grid-cols-2 gap-1.5 mb-4">
              {(['admin', 'cashier'] as const).map(role => (
                <button key={role} type="button" onClick={() => { setSecurityRole(role); setAccountMsg(null); }} className={`rounded-lg py-2.5 text-xs font-bold uppercase tracking-wider transition ${securityRole === role ? (role === 'admin' ? 'bg-violet-600 text-white' : 'bg-emerald-600 text-white') : 'text-sub hover:text-ink'}`}>
                  {role}
                </button>
              ))}
            </div>

            <div className="space-y-3.5">
              {securityAccounts.length === 0 ? (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-3 text-xs text-sub">
                  No active {securityRole} account exists. Create the cashier account from <b>Users</b>, then return here.
                </div>
              ) : (
                <>
                  {securityAccounts.length > 1 && (
                    <Field label={securityRole === 'admin' ? 'Administrator account' : 'Cashier account'}>
                      <select className="input" value={securityUserId} onChange={e => { setSecurityUserId(e.target.value); setAccountMsg(null); }}>
                        {securityAccounts.map(u => <option key={u.id} value={u.id}>{u.name} — {u.email}</option>)}
                      </select>
                    </Field>
                  )}
                  <div className="rounded-xl border border-line bg-raised px-3.5 py-3 text-xs">
                    <div className="font-bold text-ink">{securityAccounts.find(u => u.id === securityUserId)?.name || 'Account'}</div>
                    <div className="text-faint mt-0.5">{securityAccounts.find(u => u.id === securityUserId)?.email || ''}</div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3.5">
                    <Field label="New login password"><input type="password" className="input" value={accountNew} onChange={e => { setAccountNew(e.target.value); setAccountMsg(null); }} placeholder="Minimum 12 characters" autoComplete="new-password" /></Field>
                    <Field label="Confirm login password"><input type="password" className="input" value={accountConfirm} onChange={e => { setAccountConfirm(e.target.value); setAccountMsg(null); }} placeholder="Repeat it" autoComplete="new-password" onKeyDown={e => { if (e.key === 'Enter') void submitManagedPassword(); }} /></Field>
                  </div>
                  {accountMsg && <p className={`flex items-center gap-1.5 text-[13px] font-semibold ${accountMsg.ok ? 'text-emerald-500' : 'text-rose-500'}`}>{accountMsg.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {accountMsg.text}</p>}
                  <button className="btn btn-primary" onClick={() => void submitManagedPassword()} disabled={!accountNew || !accountConfirm}><ShieldCheck size={15} /> Change {securityRole === 'admin' ? 'Admin' : 'Cashier'} login password</button>
                </>
              )}
            </div>

            <div className="mt-6 pt-5 border-t border-line">
              <p className="text-xs font-bold text-ink mb-1">Admin unlock password / PIN</p>
              <p className="text-[11px] text-faint mb-3">This is separate from the Admin login password. It remains available for the cashier → admin switch.</p>
              <div className="space-y-3.5">
                <Field label="Current admin unlock PIN" hint="No default PIN is shipped. Use the administrator password initially, then set a separate unlock PIN."><div className="relative"><Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" /><input type={showPins ? 'text' : 'password'} className="input pl-9 pr-10" value={pinCur} onChange={e => { setPinCur(e.target.value); setPinMsg(null); }} placeholder="Current admin unlock PIN" /><button type="button" onClick={() => setShowPins(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink">{showPins ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></Field>
                <div className="grid sm:grid-cols-2 gap-3.5"><Field label="New admin unlock PIN"><input type={showPins ? 'text' : 'password'} className="input" value={pinNew} onChange={e => { setPinNew(e.target.value); setPinMsg(null); }} placeholder="Min 4 characters" /></Field><Field label="Confirm new admin unlock PIN"><input type={showPins ? 'text' : 'password'} className="input" value={pinConfirm} onChange={e => { setPinConfirm(e.target.value); setPinMsg(null); }} placeholder="Repeat it" onKeyDown={e => { if (e.key === 'Enter') submitPin(); }} /></Field></div>
                {pinMsg && <p className={`flex items-center gap-1.5 text-[13px] font-semibold ${pinMsg.ok ? 'text-emerald-500' : 'text-rose-500'}`}>{pinMsg.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {pinMsg.text}</p>}
                <button className="btn btn-primary" onClick={submitPin} disabled={!pinCur || !pinNew || !pinConfirm}><ShieldCheck size={15} /> Update admin unlock PIN</button>
              </div>
            </div>
          </div>

          <div className="card p-6 border border-emerald-500/20">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><ShieldCheck size={15} /></span>Google Backup Encryption</h3>
            <p className="text-xs text-faint mb-4">{getBackupSecurityMessage()}</p>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3.5 py-3 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
              Encryption is automatic. You do not need to enter or unlock a passphrase for normal backups.
            </div>
            <Field label="Recovery Key" hint="Generated automatically on the first Google backup. Keep a private copy outside the PC.">
              <div className="flex gap-2">
                <input type="text" className="input flex-1 font-mono text-xs" value={getRecoveryKey()} readOnly placeholder="Will be generated automatically on first backup" />
                <button type="button" className="btn btn-soft shrink-0" disabled={!getRecoveryKey()} onClick={async () => {
                  const key = getRecoveryKey();
                  if (!key) return;
                  try {
                    await navigator.clipboard.writeText(key);
                    setRecoveryKeyCopied(true);
                    setRecoveryKeyMsg('Recovery Key copied. Keep it in a secure place.');
                    window.setTimeout(() => setRecoveryKeyCopied(false), 2500);
                  } catch {
                    setRecoveryKeyMsg('Copy failed. Select the Recovery Key and copy it manually.');
                  }
                }}><Copy size={15} /> {recoveryKeyCopied ? 'Copied' : 'Copy'}</button>
              </div>
            </Field>
            <div className="mt-4 pt-4 border-t border-line">
              <Field label="Use existing Recovery Key" hint="Use this after replacing/reinstalling Windows. Paste the key from RECOVERY_KEY.txt or your saved copy.">
                <div className="flex gap-2">
                  <input type="text" className="input flex-1 font-mono text-xs" value={recoveryKeyInput} onChange={e => { setRecoveryKeyInput(e.target.value.trim()); setRecoveryKeyMsg(''); }} placeholder="Paste the existing Recovery Key" maxLength={64} />
                  <button type="button" className="btn btn-primary shrink-0" disabled={!recoveryKeyInput} onClick={() => {
                    const result = setRecoveryKey(recoveryKeyInput);
                    if (!result.ok) { setRecoveryKeyMsg(result.error || 'Invalid Recovery Key'); return; }
                    setRecoveryKeyInput('');
                    setRecoveryKeyReady(true);
                    setRecoveryKeyMsg('Recovery Key saved. Automatic encryption and restore are ready.');
                  }}>Use Key</button>
                </div>
              </Field>
            </div>
            {recoveryKeyMsg && <p className="text-[12px] font-medium mt-3 text-emerald-500">{recoveryKeyMsg}</p>}
            <p className="text-[11px] text-faint mt-3">{recoveryKeyReady ? 'Automatic encrypted Google backup is ready on this browser.' : 'The Recovery Key will be generated automatically when the first encrypted Google backup is created.'}</p>
          </div>

          <div className="card p-6 border border-violet-500/20">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><Cloud size={15} /></span>Shop Backup Identity</h3>
            <p className="text-xs text-faint mb-4">This ID selects the isolated Google Drive backup partition for this shop. Keep it safe if the same shop needs to use another browser or PC.</p>
            <Field label="Current Shop Backup ID" hint="Read-only">
              <div className="flex gap-2">
                <input className="input flex-1 font-mono text-xs" value={driveShopId || getLocalShopId() || ''} readOnly />
                <button type="button" className="btn btn-soft shrink-0" onClick={copyShopBackupId} disabled={!getLocalShopId()}><Copy size={15} /> {shopIdCopied ? 'Copied' : 'Copy'}</button>
              </div>
            </Field>
            <div className="mt-4 pt-4 border-t border-line">
              <Field label="Use existing Shop Backup ID" hint="Use this when replacing/reinstalling a PC. It reconnects this POS to the same Google Drive shop partition.">
                <div className="flex gap-2">
                  <input className="input flex-1 font-mono text-xs" value={existingDriveShopId} onChange={e => { setExistingDriveShopId(e.target.value); setShopIdMsg(''); }} placeholder="Paste the existing Shop Backup ID" maxLength={100} />
                  <button type="button" className="btn btn-primary shrink-0" onClick={useExistingShopBackupId}>Use ID</button>
                </div>
              </Field>
            </div>
            {shopIdMsg && <p className="text-[12px] font-medium mt-3 text-emerald-500">{shopIdMsg}</p>}
          </div>

          <div className="card p-6">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-500 flex items-center justify-center"><Database size={15} /></span>Data &amp; Backup</h3>
            <p className="text-xs text-faint mb-3">Primary store: <b className="text-ink">IndexedDB</b> (large capacity). localStorage kept as fast cache. Works fully offline — auto-syncs when the network returns.</p>
            <div className="flex flex-wrap gap-2 mb-4 text-[11px] font-semibold"><span className={`badge ${connectivity === 'online' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-500'}`}>{connectivity === 'online' ? '● ONLINE' : '● OFFLINE'}</span>{pendingQueueCount > 0 && <span className="badge bg-amber-500/15 text-amber-600">{pendingQueueCount} queued write(s)</span>}{backupMeta.lastManualBackupAt && <span className="badge bg-sky-500/10 text-sky-600">Last manual: {new Date(backupMeta.lastManualBackupAt).toLocaleString()}</span>}{backupMeta.lastAutoBackupAt && <span className="badge bg-violet-500/10 text-violet-600">Last auto: {new Date(backupMeta.lastAutoBackupAt).toLocaleString()}</span>}{backupMeta.lastCloudBackupAt && <span className="badge bg-emerald-500/10 text-emerald-600">Last cloud: {new Date(backupMeta.lastCloudBackupAt).toLocaleString()}</span>}</div>
            <div className="rounded-xl border border-line bg-raised/40 p-3.5 mb-4"><div className="text-[12px] font-bold text-ink mb-2">Auto backup interval</div><div className="flex flex-wrap items-center gap-2">{[0, 0.25, 0.5, 1, 3, 6, 12, 24].map(h => <button key={h} type="button" className={`btn !py-1.5 !px-3 text-[12px] ${autoHours === h ? 'btn-primary' : 'btn-soft'}`} onClick={async () => { setAutoHours(h); await setAutoBackupHours(h); setBackupMsg(h === 0 ? 'Auto-backup disabled' : `Auto-backup every ${h}h`); }}>{h === 0 ? 'OFF' : h < 1 ? `${Math.round(h * 60)}m` : `${h}h`}</button>)}</div><p className="text-[11px] text-faint mt-2">When due, an encrypted backup snapshot is saved to the configured Google Drive shop backup folder automatically.</p></div>
            <div className="flex flex-wrap gap-2.5">{can('act:export') && <button className="btn btn-soft" onClick={async () => { await runManualBackup(); setBackupMsg('Manual backup downloaded'); }}><Download size={15} /> Export backup</button>}{user?.role === 'admin' && <button className="btn btn-soft" onClick={() => fileRef.current?.click()}><Upload size={15} /> Import backup</button>}<input ref={fileRef} type="file" accept=".json,.manifest.json,.part,application/json,text/plain,application/octet-stream" multiple className="hidden" onChange={e => { const files = Array.from(e.target.files || []); if (files.length) onImport(files); e.target.value = ''; }} />{pendingQueueCount > 0 && connectivity === 'online' && <button className="btn btn-emerald" onClick={async () => { const n = await flushOfflineQueue(); setBackupMsg(`Flushed ${n} queued write(s)`); }}>Sync now</button>}</div>
            {(importMsg || backupMsg) && <p className={`text-[13px] font-medium mt-3 ${(importMsg || backupMsg).includes('success') || (importMsg || backupMsg).includes('downloaded') || (importMsg || backupMsg).includes('Flushed') || (importMsg || backupMsg).includes('Auto') || (importMsg || backupMsg).includes('Google') || (importMsg || backupMsg).includes('Reloading') ? 'text-emerald-500' : 'text-rose-500'}`}>{importMsg || backupMsg}</p>}
          </div>

          {user?.role === 'admin' && <div className="card p-6 border border-rose-500/25"><h3 className="font-bold text-rose-600 dark:text-rose-400 flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center"><RotateCcw size={15} /></span>Danger Zone</h3><p className="text-xs text-faint mb-4">Clear the current local dataset and restore the demo dataset. This action replaces local POS records and cannot be undone.</p><button className="btn btn-danger-soft" onClick={() => setConfirmReset(true)}><RotateCcw size={15} /> Clear Demo Data</button></div>}

          <div className="card p-6"><h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center"><Cloud size={15} /></span>Google Drive Backup</h3><p className="text-xs text-faint mb-3">Automatic Google Drive backup is centrally managed. The POS sends each shop's backup to its own isolated folder; shop users do not need to configure a Google URL.</p><div className="flex items-center gap-2 text-[12px] font-semibold text-emerald-600 mb-3"><CheckCircle2 size={15} /> Automatic backup is enabled</div>{!recoveryKeyReady && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[12px] font-semibold text-amber-700 dark:text-amber-300 mb-3">The first encrypted Google backup will generate the Recovery Key automatically. On a replacement PC, paste the saved Recovery Key before restoring.</div>}<div className="flex flex-wrap gap-2 mt-3">{user?.role === 'admin' && <><button type="button" className="btn btn-primary" disabled={!gEnabled || connectivity !== 'online' || gRestoreBusy} onClick={runGoogleBackupNow}><Cloud size={15} /> {gRestoreBusy ? 'Backing up…' : 'Backup now to Google Drive'}</button><button type="button" className="btn btn-soft" disabled={!gEnabled || connectivity !== 'online' || gRestoreBusy} onClick={requestGoogleRestore}><RotateCcw size={15} /> {gRestoreBusy ? 'Working…' : 'Restore latest Google backup'}</button></>}</div>{gMsg && <p className={`text-[13px] font-medium mt-3 ${gMsg.includes('Failed') || gMsg.includes('failed') || gMsg.includes('disabled') || gMsg.includes('requires') || gMsg.includes('No valid') || gMsg.includes('Invalid') || gMsg.includes('Could not') || gMsg.includes('Set the Backup Passphrase') || gMsg.includes('No backup was uploaded') ? 'text-rose-500' : 'text-emerald-500'}`}>{gMsg}</p>}<p className="text-[11px] text-faint mt-3">If Windows is damaged or this POS is moved to a new PC, first use the existing Shop Backup ID above to reconnect to the same shop, then paste the Recovery Key from RECOVERY_KEY.txt and restore the latest encrypted backup.</p></div>

          <div className="card p-6"><h3 className="font-bold text-ink flex items-center gap-2 mb-3"><span className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center"><ReceiptText size={15} /></span>Receipt Identity</h3><div className="flex flex-wrap gap-2"><Badge tone="violet">{form.shopName}</Badge><Badge tone="slate">{form.phone}</Badge><Badge tone="slate">{form.email}</Badge><Badge tone="amber">{form.exchangeDays}-day exchange policy</Badge></div><p className="text-xs text-faint mt-3">These print on every bill and price tag sheet.</p></div>
        </div>
      </div>

      <Modal
        open={confirmGoogleRestore !== null}
        onClose={() => { if (!gRestoreBusy) setConfirmGoogleRestore(null); }}
        title="Restore latest Google backup?"
        sub="This will replace the current local POS data"
      >
        <div className="rounded-xl bg-amber-500/[0.08] border border-amber-500/25 px-4 py-3 flex items-start gap-2.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>This will restore THIS SHOP ONLY. The selected cloud snapshot is scoped to the displayed Shop Backup ID and partition. It will replace the current local dataset. A safety checkpoint is created first, and the restore is cancelled if the checkpoint cannot be saved.</span>
        </div>
        {confirmGoogleRestore && (
          <div className="rounded-xl bg-raised border border-line px-4 py-3 mt-4 text-xs text-faint">
            <div><b className="text-ink">Shop name:</b> {confirmGoogleRestore.shopName || state.settings.shopName || 'Shop'}</div>
            <div className="mt-1"><b className="text-ink">Shop partition:</b> <span className="font-mono">{confirmGoogleRestore.shopPartition}</span></div>
            <div className="mt-1"><b className="text-ink">Shop Backup ID:</b> <span className="font-mono break-all">{confirmGoogleRestore.shopId}</span></div>
            <div className="mt-1"><b className="text-ink">Backup type:</b> {confirmGoogleRestore.kind || 'unknown'}</div>
            {confirmGoogleRestore.backedUpAt && (
              <div className="mt-1"><b className="text-ink">Backed up:</b> {new Date(confirmGoogleRestore.backedUpAt).toLocaleString()}</div>
            )}
          </div>
        )}
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-primary flex-1" disabled={gRestoreBusy} onClick={confirmGoogleRestoreNow}>
            <Cloud size={15} /> {gRestoreBusy ? 'Restoring…' : 'Restore backup'}
          </button>
          <button className="btn btn-soft flex-1" disabled={gRestoreBusy} onClick={() => setConfirmGoogleRestore(null)}>Cancel</button>
        </div>
      </Modal>
      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Clear demo data?" sub="Restore the demo seed"><div className="rounded-xl bg-amber-500/[0.08] border border-amber-500/25 px-4 py-3 flex items-start gap-2.5 text-sm text-amber-600 dark:text-amber-400"><AlertTriangle size={16} className="shrink-0 mt-0.5" />Products, sales, customers, expenses and settings will be replaced with the demo dataset. Export a backup first if you need your records.</div><div className="flex gap-2.5 mt-5"><button className="btn btn-danger-soft flex-1" onClick={() => { resetData(); setConfirmReset(false); }}><RotateCcw size={15} /> Clear Demo Data</button><button className="btn btn-soft flex-1" onClick={() => setConfirmReset(false)}>Cancel</button></div></Modal>
    </div>
  );
}
