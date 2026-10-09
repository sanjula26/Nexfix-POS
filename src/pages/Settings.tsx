import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Store, Database, Download, Upload, RotateCcw, Cloud, SlidersHorizontal, Copy, ExternalLink,
  CheckCircle2, AlertTriangle, ReceiptText, ShieldCheck, Lock, Eye, EyeOff, MessageCircle,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Modal, Field, PageHeading, Badge, Toggle } from '../components/ui';
import {
  isGoogleSyncEnabled, getGoogleScriptUrl, fetchLatestGoogleBackup, getLocalShopId, getDriveShopId, setExistingDriveShopId as saveExistingDriveShopId, adoptBackupShopId, syncShopMetadataToGoogleDrive,
} from '../lib/driveSync';
import { clearRecoveryKey, decryptBackupEnvelope, getBackupSecurityMessage, getRecoveryKey, hasRecoveryKey, isEncryptedBackupEnvelope, setRecoveryKey, sha256Hex } from '../lib/backupCrypto';
import { applyBackupRestore } from '../lib/restore';
import { downloadBackup } from '../lib/backup';
import { queueWrite } from '../lib/offline';
import { getCloudShopId } from '../lib/cloudSync';
import { provisionCloudUpdaterAccount, refreshDesktopUpdaterCredentials } from '../lib/cloudAuth';
import { authorizeLegacyCloudPassword, completeLegacyCloudEmailMagicLink } from '../lib/cloudLegacyAuth';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { getMachineIdentity } from '../lib/machine';
import { buildPhoneSalesLink, copyText, openExternalUrl } from '../lib/publicApp';
import { uid } from '../lib/utils';

export default function Settings() {
  const navigate = useNavigate();
  const {
    state, user, updateSettings, resetData, can, changeAdminPin, changeManagedPassword, confirmSensitiveAdmin,
    connectivity, backupMeta, runManualBackup, refreshBackupMeta, setAutoBackupHours, flushOfflineQueue, pendingQueueCount,
  } = usePOS();
  const [backupMsg, setBackupMsg] = useState('');
  const [phoneLinkMsg, setPhoneLinkMsg] = useState('');
  const [autoHours, setAutoHours] = useState(backupMeta.autoBackupHours ?? 6);
  const gEnabled = isGoogleSyncEnabled();
  const recoveryScope = getDriveShopId() || getCloudShopId() || '';
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
  const phoneSalesMachine = getMachineIdentity();
  const phoneSalesShopId = getCloudShopId();
  type BranchOption = { id: string; name: string; code: string; is_default: boolean; active: boolean };
  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState(() => state.settings.branchId && state.settings.branchId !== 'local-main' ? state.settings.branchId : '');
  const [branchMsg, setBranchMsg] = useState('Checking branch configuration…');
  const bindBranchToDevice = useCallback(async (branchId: string, shopId = getCloudShopId()) => {
    if (!shopId || !supabaseConfigured || !supabase || typeof navigator !== 'undefined' && !navigator.onLine) return false;
    if (user?.role !== 'admin' && user?.role !== 'manager') return false;
    const { data, error } = await supabase.rpc('set_pos_device_branch', {
      p_shop_id: shopId, p_device_id: phoneSalesMachine.id, p_branch_id: branchId,
    });
    if (error || !data?.ok) {
      setBranchMsg(error?.message || data?.error || 'Could not bind this POS device to the selected branch.');
      return false;
    }
    setBranchMsg('Selected branch saved and this POS device is bound to it.');
    return true;
  }, [user?.role, phoneSalesMachine.id]);
  useEffect(() => {
    let cancelled = false;
    const shopId = getCloudShopId();
    const cacheKey = shopId ? `nexfix_branches_v1:${shopId}` : '';
    let hasCachedOptions = false;
    const applyOptions = (rows: BranchOption[], fromCache = false) => {
      if (cancelled) return;
      setBranchOptions(rows);
      const saved = state.settings.branchId || '';
      const match = rows.find(branch => branch.id === saved && branch.active);
      if (match) {
        setSelectedBranchId(match.id);
        if (user?.role === 'admin' || user?.role === 'manager') void bindBranchToDevice(match.id, shopId);
      } else if (rows.length === 1) {
        setSelectedBranchId(rows[0].id);
        if ((user?.role === 'admin' || user?.role === 'manager') && saved !== rows[0].id) updateSettings({ branchId: rows[0].id });
        if (user?.role === 'admin' || user?.role === 'manager') void bindBranchToDevice(rows[0].id, shopId);
      } else setSelectedBranchId('');
      setBranchMsg(fromCache ? 'Offline mode: using saved branch list.' : rows.length === 1
        ? 'Main branch is selected automatically.'
        : rows.length > 1 ? 'Select the branch assigned to this POS device.' : 'No active branch was returned for this shop.');
    };
    if (cacheKey) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]') as BranchOption[];
        if (Array.isArray(cached) && cached.length) { hasCachedOptions = true; applyOptions(cached, true); }
      } catch { /* use live branch list below */ }
    }
    if (!shopId || !supabaseConfigured || !supabase || typeof navigator !== 'undefined' && !navigator.onLine) {
      if (!state.settings.branchId) setBranchMsg('Connect the POS online once to assign this device to a branch. Local sales remain available offline.');
      return () => { cancelled = true; };
    }
    void (async () => {
      try {
        const { data, error } = await supabase.from('branches')
          .select('id,name,code,is_default,active')
          .eq('shop_id', shopId).eq('active', true).order('is_default', { ascending: false }).order('name');
        if (error) throw error;
        const rows = (data || []) as BranchOption[];
        if (cacheKey) { try { localStorage.setItem(cacheKey, JSON.stringify(rows)); } catch { /* cache is optional */ } }
        applyOptions(rows, false);
      } catch (error) {
        if (!cancelled && !hasCachedOptions) setBranchMsg(error instanceof Error ? error.message : 'Could not load branches. Connect online and retry.');
      }
    })();
    return () => { cancelled = true; };
  }, [phoneSalesShopId, state.settings.branchId, user?.role, updateSettings, phoneSalesMachine.id, bindBranchToDevice]);
  const phoneSalesTimeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const [phoneSalesToken, setPhoneSalesToken] = useState('');
  const [phoneSalesLink, setPhoneSalesLink] = useState('');
  useEffect(() => {
    let cancelled = false;
    const loadPhoneSalesToken = async () => {
      if (!phoneSalesShopId || !phoneSalesMachine.id || !supabaseConfigured || !supabase) {
        if (!cancelled) { setPhoneSalesToken(''); setPhoneSalesLink(''); }
        return;
      }
      const key = 'nexfix_phone_sales_token_v1';
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null') as { shopId?: string; deviceId?: string; token?: string } | null;
        if (saved?.shopId === phoneSalesShopId && saved?.deviceId === phoneSalesMachine.id && saved.token) {
          if (!cancelled) { setPhoneSalesToken(saved.token); setPhoneSalesLink(buildPhoneSalesLink(saved.token, phoneSalesTimeZone)); }
          return;
        }
      } catch { /* regenerate below */ }

      for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData.session) {
          const { data, error } = await supabase.functions.invoke('phone-sales', {
            body: { shopId: phoneSalesShopId, deviceId: phoneSalesMachine.id, label: 'Phone Sales' },
          });
          if (!error && data?.ok && typeof data.token === 'string' && data.token.length >= 32) {
            const token = data.token.trim();
            try { localStorage.setItem(key, JSON.stringify({ shopId: phoneSalesShopId, deviceId: phoneSalesMachine.id, token })); } catch { /* link remains usable for this session */ }
            if (!cancelled) { setPhoneSalesToken(token); setPhoneSalesLink(buildPhoneSalesLink(token, phoneSalesTimeZone)); }
            return;
          }
        }
        await new Promise(resolve => window.setTimeout(resolve, 500));
      }
      if (!cancelled) setPhoneLinkMsg('Phone sales link could not be authorized yet. Keep the POS online and try again.');
    };
    void loadPhoneSalesToken();
    return () => { cancelled = true; };
  }, [phoneSalesShopId, phoneSalesMachine.id, phoneSalesTimeZone]);
  const copyPhoneSalesLink = async () => {
    if (!phoneSalesLink || !phoneSalesToken) return;
    const copied = await copyText(phoneSalesLink);
    setPhoneLinkMsg(copied ? 'Phone sales link copied.' : 'Copy failed. Use the link field below to select and copy.');
    if (copied) window.setTimeout(() => setPhoneLinkMsg(''), 1800);
  };
  const openPhoneSalesLink = async () => {
    if (!phoneSalesLink || !phoneSalesToken) return;
    const opened = await openExternalUrl(phoneSalesLink);
    if (!opened) setPhoneLinkMsg('Could not open the phone sales page. Copy the link and open it in Chrome.');
  };

  const regeneratePhoneSalesLink = async () => {
    if (!supabase || !supabaseConfigured || !phoneSalesShopId || !phoneSalesMachine.id) return;
    setPhoneLinkMsg('Generating a new secure link…');
    try {
      const { data, error } = await supabase.functions.invoke('phone-sales', {
        body: { shopId: phoneSalesShopId, deviceId: phoneSalesMachine.id, label: 'Phone Sales', oldToken: phoneSalesToken },
      });
      if (error || !data?.ok || typeof data.token !== 'string') throw new Error(data?.error || error?.message || 'Could not regenerate the phone sales link.');
      const token = data.token.trim();
      localStorage.setItem('nexfix_phone_sales_token_v1', JSON.stringify({ shopId: phoneSalesShopId, deviceId: phoneSalesMachine.id, token }));
      setPhoneSalesToken(token);
      setPhoneSalesLink(buildPhoneSalesLink(token, phoneSalesTimeZone));
      setPhoneLinkMsg('New secure phone sales link generated. The previous link has been revoked.');
    } catch (error) {
      setPhoneLinkMsg(error instanceof Error ? error.message : 'Could not regenerate the phone sales link.');
    }
  };

  const [form, setForm] = useState(() => {
    const { adminPinHash, ...rest } = state.settings;
    void adminPinHash;
    return {
      shopName: rest.shopName || '', tagline: rest.tagline || '', address: rest.address || '', phone: rest.phone || '', email: rest.email || '',
      receiptFooter: rest.receiptFooter || '', taxDefault: rest.taxDefault ?? 0, lowStockDefault: rest.lowStockDefault ?? 5,
      exchangeDays: rest.exchangeDays ?? 7, openingFloat: rest.openingFloat ?? 0, loyaltyPointsPerRs: rest.loyaltyPointsPerRs ?? 0.001, loyaltyPointValue: rest.loyaltyPointValue ?? 20, whatsappReceipts: rest.whatsappReceipts !== false,
      categories: rest.categories, brands: rest.brands, repairWarrantyDays: rest.repairWarrantyDays,
      securityIdleMinutes: rest.securityIdleMinutes ?? 10,
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
  const [recoveryKeyReady, setRecoveryKeyReady] = useState(() => hasRecoveryKey(recoveryScope));
  const [recoveryKeyCopied, setRecoveryKeyCopied] = useState(false);
  const recoveryKeyFileRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');
  const [appVersion, setAppVersion] = useState(() => String(import.meta.env.VITE_APP_VERSION || ''));
  const [updateState, setUpdateState] = useState<{status:'idle'|'checking'|'available'|'downloading'|'downloaded'|'not-available'|'error';version?:string;percent?:number;message?:string}>({status:'idle'});
  const [cloudSetupEmail, setCloudSetupEmail] = useState(() => {
    try { return localStorage.getItem('nexfix_cloud_updater_email')?.trim() || ''; } catch { return ''; }
  });
  const [cloudSetupPassword, setCloudSetupPassword] = useState('');
  const [cloudSetupBusy, setCloudSetupBusy] = useState(false);
  const [cloudSetupMsg, setCloudSetupMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [legacyOtpBusy, setLegacyOtpBusy] = useState(false);
  const [legacyOtpMsg, setLegacyOtpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const desktopApi=(window as Window & {nexfixDesktop?:{isPackaged?:boolean;isPortable?:boolean;getUpdateStatus?:()=>Promise<{supported?:boolean;authorized?:boolean;available?:boolean;version?:string|null;downloading?:boolean}>;getVersion?:()=>Promise<string>;copyText?:(text:string)=>Promise<boolean>;openExternal?:(url:string)=>Promise<boolean>;checkForUpdates?:()=>Promise<{supported?:boolean;available?:boolean;version?:string|null;error?:string}>;downloadAndInstallUpdate?:()=>Promise<{supported?:boolean;started?:boolean;error?:string}>;clearUpdateCredentials?:()=>Promise<unknown>;clearCloudUpdaterDeviceToken?:()=>Promise<{ok?:boolean;error?:string}>;onUpdateEvent?:(listener:(event:{type:string;version?:string;percent?:number;message?:string})=>void)=>(()=>void);onAuthCallback?:(listener:(event:{code:string;flowId?:string})=>void)=>(()=>void)}}).nexfixDesktop;

  useEffect(() => { setAutoHours(backupMeta.autoBackupHours ?? 6); }, [backupMeta.autoBackupHours]);
  useEffect(() => {
    if (!desktopApi) return;
    void desktopApi.getVersion?.().then(v=>{if(v)setAppVersion(v);}).catch(()=>{});
    const unsubscribe=desktopApi.onUpdateEvent?.((event)=>{
      if(event.type==='checking')setUpdateState({status:'checking'});
      else if(event.type==='available')setUpdateState({status:'available',version:event.version});
      else if(event.type==='not-available')setUpdateState({status:'not-available'});
      else if(event.type==='progress')setUpdateState({status:'downloading',percent:Math.max(0,Math.min(100,Number(event.percent||0)))});
      else if(event.type==='downloaded')setUpdateState({status:'downloaded',version:event.version});
      else if(event.type==='error')setUpdateState({status:'error',message:event.message||'The update service could not be reached.'});
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!desktopApi?.onAuthCallback) return;
    const unsubscribe = desktopApi.onAuthCallback(async ({ code, flowId }) => {
      setLegacyOtpBusy(true);
      setLegacyOtpMsg(null);
      try {
        const result = await completeLegacyCloudEmailMagicLink(code, flowId);
        if (!result.ok) {
          setLegacyOtpMsg({ ok: false, text: result.error || 'Cloud Admin sign-in link could not be completed.' });
          return;
        }
        try { localStorage.setItem('nexfix_cloud_updater_email', cloudSetupEmail.trim().toLowerCase()); } catch { /* optional convenience only */ }
        setLegacyOtpMsg({ ok: true, text: 'Cloud Admin sign-in confirmed. This Windows machine is now authorized for private updates.' });
        setUpdateState({ status: 'idle' });
      } catch (error) {
        setLegacyOtpMsg({ ok: false, text: error instanceof Error ? error.message : 'Cloud Admin sign-in link could not be completed.' });
      } finally {
        setLegacyOtpBusy(false);
      }
    });
    return unsubscribe;
  }, [cloudSetupEmail, desktopApi]);
  const isUpdaterAuthorizationError=(message:string)=>/\\b401\\b|not authorized for private updates|invalid updater device credential|POS device is registered to a different cloud account/i.test(message);
  const reauthorizeUpdater=async()=>{
    // A stale device token can happen after an older/duplicate installation
    // re-authorizes the same terminal. Drop only the updater token, not the
    // cloud recovery credential or local POS session, then issue one fresh token.
    await desktopApi?.clearUpdateCredentials?.();
    await desktopApi?.clearCloudUpdaterDeviceToken?.();
    return refreshDesktopUpdaterCredentials();
  };
  const runUpdateCheck=async()=>{
    const first=await Promise.race([desktopApi?.checkForUpdates?.(),new Promise<{supported?:boolean;available?:boolean;version?:string|null;error?:string}>((_,reject)=>window.setTimeout(()=>reject(new Error('Update check timed out after 35 seconds. Please check your internet connection and try again.')),35000))]);
    if (!first?.error || !isUpdaterAuthorizationError(first.error)) return first;
    const recovered=await reauthorizeUpdater();
    if (!recovered) return first;
    return Promise.race([desktopApi?.checkForUpdates?.(),new Promise<{supported?:boolean;available?:boolean;version?:string|null;error?:string}>((_,reject)=>window.setTimeout(()=>reject(new Error('Update check timed out after 35 seconds. Please check your internet connection and try again.')),35000))]);
  };
  const ensureUpdaterReady=async()=>{
    // The native Windows updater keeps a durable per-device credential in
    // OS-protected storage. Once that credential is present, a normal POS
    // restart/login must not require another cloud Admin authorization.
    const nativeStatus=await desktopApi?.getUpdateStatus?.();
    if(nativeStatus?.authorized) return true;
    return refreshDesktopUpdaterCredentials();
  };
  const checkForAppUpdates=async()=>{if(!desktopApi?.isPackaged){setUpdateState({status:'error',message:'App updates are available in the installed POS only.'});return;}setUpdateState({status:'checking'});const authorized=await ensureUpdaterReady();if(!authorized){setUpdateState({status:'error',message:'Cloud update authorization is not ready. Keep the POS online and sign in with the provisioned Admin account, then try again.'});return;}try{const result=await runUpdateCheck();if(result?.error)setUpdateState({status:'error',message:result.error});else if(result?.available&&result.version)setUpdateState({status:'available',version:result.version});else if(result?.supported===false)setUpdateState({status:'error',message:'App updates are not available in this edition.'});else setUpdateState({status:'not-available'});}catch(error){setUpdateState({status:'error',message:error instanceof Error?error.message:'The update check could not be completed.'});}};
  const provisionCloudUpdater = async () => {    if (cloudSetupBusy) return;
    setCloudSetupBusy(true);
    setCloudSetupMsg(null);
    try {
      const result = await provisionCloudUpdaterAccount(cloudSetupEmail, cloudSetupPassword, form.shopName || state.settings.shopName || 'Nexfix Shop');
      if (!result.ok) {
        setCloudSetupMsg({ ok: false, text: result.error || 'Cloud updater setup could not be completed.' });
        return;
      }
      try { localStorage.setItem('nexfix_cloud_updater_email', cloudSetupEmail.trim().toLowerCase()); } catch { /* optional convenience only */ }
      setCloudSetupPassword('');
      setCloudSetupMsg({ ok: true, text: 'Cloud updater authorization is ready on this machine. You can now check for updates.' });
      setUpdateState({ status: 'idle' });
    } catch (error) {
      setCloudSetupMsg({ ok: false, text: error instanceof Error ? error.message : 'Cloud updater setup failed.' });
    } finally {
      setCloudSetupBusy(false);
    }
  };
  const migrateLegacyUpdater = async () => {
    if (legacyOtpBusy) return;
    if (!desktopApi?.isPackaged) {
      setLegacyOtpMsg({ ok: false, text: 'Legacy updater migration is available only in the installed Windows POS.' });
      return;
    }
    const email = cloudSetupEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setLegacyOtpMsg({ ok: false, text: 'Enter the provisioned cloud Admin email first.' });
      return;
    }
    setLegacyOtpBusy(true);
    setLegacyOtpMsg(null);
    try {
      const result = await authorizeLegacyCloudPassword(email, cloudSetupPassword);
      if (!result.ok) {
        setLegacyOtpMsg({ ok: false, text: result.error || 'Cloud Admin authorization failed.' });
        return;
      }
      try { localStorage.setItem('nexfix_cloud_updater_email', email); } catch { /* optional convenience only */ }
      setCloudSetupPassword('');
      setLegacyOtpMsg({ ok: true, text: 'Windows PC authorized successfully. Future private updates can now use secure saved credentials without email links.' });
    } catch (error) {
      setLegacyOtpMsg({ ok: false, text: error instanceof Error ? error.message : 'Cloud Admin authorization failed.' });
    } finally {
      setLegacyOtpBusy(false);
    }
  };
  const revokeCurrentUpdaterDevice = async () => {
    if (!(await confirmSensitiveAdmin('revoke this Windows PC updater access'))) { setUpdateState({ status: 'idle', message: 'Administrator confirmation cancelled.' }); return; }
    if (!desktopApi?.isPackaged) {
      setUpdateState({ status: 'error', message: 'Device revocation is available in the installed Windows POS only.' });
      return;
    }
    const shopId = getCloudShopId();
    const deviceId = phoneSalesMachine.id;
    if (!supabase || !supabaseConfigured || !shopId || !deviceId) {
      await desktopApi.clearUpdateCredentials?.();
      await desktopApi.clearCloudUpdaterDeviceToken?.();
      setUpdateState({ status: 'error', message: 'Local updater credentials cleared. Server-side device revocation could not be completed because cloud device identity is unavailable.' });
      return;
    }
    try {
      const { error } = await supabase.rpc('revoke_pos_device', { p_shop_id: shopId, p_device_id: deviceId });
      if (error) throw new Error(error.message || 'Server-side device revocation failed.');
      await desktopApi.clearUpdateCredentials?.();
      await desktopApi.clearCloudUpdaterDeviceToken?.();
      setUpdateState({ status: 'idle', message: 'This Windows PC is revoked for private updates. POS login and Google Drive backup remain unchanged.' });
    } catch (error) {
      setUpdateState({ status: 'error', message: error instanceof Error ? error.message : 'Server-side device revocation failed. No updater credentials were intentionally retained.' });
      await desktopApi.clearUpdateCredentials?.();
      await desktopApi.clearCloudUpdaterDeviceToken?.();
    }
  };
  const updateNow=async()=>{if(desktopApi?.isPortable){setUpdateState({status:'error',message:'Portable edition updates require the installed Setup edition.'});return;}const authorized=await ensureUpdaterReady();if(!authorized){setUpdateState({status:'error',message:'Cloud update authorization is not ready. Keep the POS online and sign in with the provisioned Admin account, then try again.'});return;}setUpdateState({status:'downloading',percent:0});let result=await desktopApi?.downloadAndInstallUpdate?.();if(result?.error&&isUpdaterAuthorizationError(result.error)){const recovered=await reauthorizeUpdater();if(recovered){setUpdateState({status:'downloading',percent:0});result=await desktopApi?.downloadAndInstallUpdate?.();}}if(result?.error)setUpdateState({status:'error',message:result.error});};
  const securityAccounts = state.users.filter(u => u.role === securityRole && u.active);
  useEffect(() => {
    const accounts = state.users.filter(u => u.role === securityRole && u.active);
    const first = accounts[0]?.id || '';
    if (!accounts.some(u => u.id === securityUserId)) setSecurityUserId(first);
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
      taxRegistrationNo: s.taxRegistrationNo ?? f.taxRegistrationNo, invoicePlaceOfSupply: s.invoicePlaceOfSupply ?? f.invoicePlaceOfSupply, securityIdleMinutes: s.securityIdleMinutes ?? f.securityIdleMinutes,
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
    const securityIdleMinutes = Number(form.securityIdleMinutes);
    if (!Number.isFinite(taxDefault) || taxDefault < 0 || taxDefault > 100) return setBackupMsg('Default tax must be between 0% and 100%');
    if (!Number.isFinite(lowStockDefault) || !Number.isInteger(lowStockDefault) || lowStockDefault < 0) return setBackupMsg('Low-stock default must be a whole number of 0 or more');
    if (!Number.isFinite(exchangeDays) || !Number.isInteger(exchangeDays) || exchangeDays < 0) return setBackupMsg('Exchange window must be a whole number of 0 or more days');
    if (!Number.isFinite(openingFloat) || openingFloat < 0) return setBackupMsg('Opening float cannot be negative');
    if (!Number.isFinite(loyaltyPointsPerRs) || loyaltyPointsPerRs < 0 || loyaltyPointsPerRs > 10) return setBackupMsg('Loyalty points per Rs must be between 0 and 10');
    if (!Number.isFinite(loyaltyPointValue) || loyaltyPointValue < 0) return setBackupMsg('Loyalty point value cannot be negative');
    if (!Number.isFinite(securityIdleMinutes) || !Number.isInteger(securityIdleMinutes) || securityIdleMinutes < 1 || securityIdleMinutes > 120) return setBackupMsg('Idle lock must be between 1 and 120 minutes');
    const promotions = (form.promotions || []).map(p => ({ ...p, name: p.name.trim(), category: p.category.trim(), discountPct: Number(p.discountPct) }));
    if (promotions.some(p => !p.name || !p.category || !Number.isFinite(p.discountPct) || p.discountPct <= 0 || p.discountPct > 100 || (p.startDate && p.endDate && p.endDate < p.startDate))) return setBackupMsg('Check promotion name, category, discount (1–100%) and dates');
    setBackupMsg('');
    const nextSettings = { ...form, taxDefault, lowStockDefault, exchangeDays, openingFloat, loyaltyPointsPerRs, loyaltyPointValue, securityIdleMinutes, promotions };
    // updateSettings() owns the authenticated Drive metadata sync. Do not
    // call syncShopMetadataToGoogleDrive(nextSettings) here: nextSettings is
    // the Settings object itself, not { settings: nextSettings }, and sending
    // that shape would make the metadata sync fall back to "Shop" / blank
    // values and overwrite the real Drive shop details.
    updateSettings(nextSettings);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };
  const num = (k: 'taxDefault' | 'lowStockDefault' | 'exchangeDays' | 'openingFloat' | 'loyaltyPointsPerRs' | 'loyaltyPointValue' | 'securityIdleMinutes') => (e: React.ChangeEvent<HTMLInputElement>) =>
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

  const useExistingShopBackupId = async () => {
    if (!(await confirmSensitiveAdmin('Shop Backup ID reconnect'))) { setShopIdMsg('Administrator confirmation cancelled.'); return; }
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
    if (!(await confirmSensitiveAdmin('managed account password change'))) return;
    if (!securityUserId) return setAccountMsg({ ok: false, text: 'No active ' + securityRole + ' account is available' });
    if (accountNew.length < 12) return setAccountMsg({ ok: false, text: 'Password must be at least 12 characters' });
    if (accountNew !== accountConfirm) return setAccountMsg({ ok: false, text: 'Passwords do not match' });
    const res = await changeManagedPassword(securityUserId, accountNew);
    if (!res.ok) return setAccountMsg({ ok: false, text: res.error || 'Failed to update login password' });
    setAccountMsg({ ok: true, text: (securityRole === 'admin' ? 'Admin' : 'Cashier') + ' login password updated' });
    setAccountNew(''); setAccountConfirm('');
  };
  const submitPin = async () => {
    setPinMsg(null);
    if (!(await confirmSensitiveAdmin('admin unlock password change'))) { setPinMsg({ ok: false, text: 'Administrator confirmation cancelled.' }); return; }
    if (pinNew !== pinConfirm) return setPinMsg({ ok: false, text: 'New passwords do not match' });
    const res = changeAdminPin(pinCur, pinNew);
    if (!res.ok) return setPinMsg({ ok: false, text: res.error || 'Failed to update password' });
    setPinMsg({ ok: true, text: 'Admin unlock PIN updated' });
    setPinCur(''); setPinNew(''); setPinConfirm('');
  };

  const onImport = async (files: File[]) => {
    if (!user || user.role !== 'admin') {
      setImportMsg('Backup restore requires admin access');
      return;
    }
    if (!files.length) return;
    if (!(await confirmSensitiveAdmin('local backup restore'))) { setImportMsg('Administrator confirmation cancelled.'); return; }
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
      const previousRecoveryKey = getRecoveryKey(recoveryScope);
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
        const result = setRecoveryKey(importedRecoveryKey, recoveryScope);
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
        const meta = candidate._meta as Record<string, unknown>;        if (meta.encrypted === true && isEncryptedBackupEnvelope(candidate.payload)) {
          const decrypted = await decryptBackupEnvelope(candidate.payload);          restoreInput = { __nexfixCloudSafe: true, state: decrypted };
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
          if (previousRecoveryKey) setRecoveryKey(previousRecoveryKey, recoveryScope);
          else {
            clearRecoveryKey(recoveryScope);
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

  const importRecoveryKeyFile = async (file?: File) => {
    if (!file) return;
    if (!(await confirmSensitiveAdmin('Recovery Key import / shop reconnect'))) return;
    try {
      const text = await file.text();
      const keyMatch = text.match(/^Recovery Key:\\s*([A-Za-z0-9_-]{43})\\s*$/m);
      if (!keyMatch) throw new Error('This file does not contain a valid Nexfix Recovery Key.');

      // RECOVERY_KEY.txt is the one-time disaster/new-PC reconnect artifact.
      // If it contains the Shop Backup ID, adopt both values together so the
      // key is stored under the correct scoped Drive identity automatically.
      const idMatch = text.match(/^Shop Backup ID Copy:\\s*([A-Za-z0-9._:-]{1,100})\\s*$/m);
      let scope = recoveryScope;
      if (idMatch?.[1]) {
        const idResult = saveExistingDriveShopId(idMatch[1]);
        if (!idResult.ok) throw new Error(idResult.error || 'Invalid Shop Backup ID in RECOVERY_KEY.txt.');
        scope = idMatch[1].trim();
        setDriveShopId(scope);
      }

      const result = setRecoveryKey(keyMatch[1], scope);
      if (!result.ok) throw new Error(result.error || 'Invalid Recovery Key.');
      setRecoveryKeyReady(true);
      setRecoveryKeyMsg(
        idMatch?.[1]
          ? 'Shop Backup ID + Recovery Key imported once. Future automatic and manual Google backups will reuse them without another paste.'
          : 'Existing Recovery Key imported for this shop. Future automatic and manual Google backups will reuse it without another paste.',
      );
      setGMsg('');
    } catch (error) {
      setRecoveryKeyMsg(error instanceof Error ? error.message : 'Could not import the Recovery Key.');
    } finally {
      if (recoveryKeyFileRef.current) recoveryKeyFileRef.current.value = '';
    }
  };

  const runGoogleBackupNow = async () => {
    if (!user || user.role !== 'admin') return setGMsg('Google backup test requires admin access');
    if (!(await confirmSensitiveAdmin('manual Google Drive backup'))) { setGMsg('Administrator confirmation cancelled.'); return; }
    if (!gEnabled || !getGoogleScriptUrl()) return setGMsg('Central Google Drive backup is not available');
    if (connectivity !== 'online') return setGMsg('Google backup requires an online connection');
        setGRestoreBusy(true);
    setGMsg('Uploading / confirming Google Drive backup…');
    try {
      const result = await downloadBackup(state, 'manual', { download: false, cloud: true });
      // downloadBackup() persists lastCloudBackupAt/lastCloudBackupError.
      // Refresh the in-memory Settings metadata immediately so a successful
      // Drive artifact cannot leave the UI showing an old/sticky status.
      await refreshBackupMeta();
      if (result.cloud) {
        setRecoveryKeyReady(hasRecoveryKey(recoveryScope));
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
    if (!hasRecoveryKey(recoveryScope)) return setGMsg('Recovery Key is required for automatic encrypted restore. Paste the Recovery Key from RECOVERY_KEY.txt in the Shop Backup Identity section first.');
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
    if (!(await confirmSensitiveAdmin('Google Drive restore'))) { setGMsg('Administrator confirmation cancelled.'); return; }
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
        <section className="mb-5 rounded-2xl border border-violet-500/20 bg-violet-500/[0.06] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-black text-ink">Phone Sales Link</div>
              <p className="mt-1 text-xs leading-relaxed text-sub">This is a secure, token-based read-only sales link. Only someone with the link token can read this shop's sales. The link can be revoked from the authorized POS.</p>
              <input aria-label="Phone sales link" readOnly value={phoneSalesLink} onFocus={e => e.currentTarget.select()} className="mt-3 w-full rounded-xl border border-line bg-raised px-3 py-2.5 text-[11px] font-mono text-ink outline-none focus:border-violet-500" />
              {phoneLinkMsg && <p className="mt-2 text-[12px] font-semibold text-emerald-600">{phoneLinkMsg}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="button" onClick={() => void copyPhoneSalesLink()} disabled={!phoneSalesLink} className="btn btn-primary min-h-11"><Copy size={15} /> Copy link</button>{phoneSalesLink&&<button type="button" onClick={() => void regeneratePhoneSalesLink()} className="btn btn-soft min-h-11">Regenerate link</button>}
              {phoneSalesLink && <button type="button" onClick={() => void openPhoneSalesLink()} className="btn btn-soft min-h-11"><ExternalLink size={15} /> Open in browser</button>}
              <button type="button" onClick={() => navigate('/today-links')} className="btn btn-soft min-h-11">Machine details</button>
            </div>
          </div>
        </section>
      )}
      <PageHeading chip="System" chipTone="slate" title="Settings" sub={`${state.settings.shopName} · v${appVersion}`} actions={<button className="btn btn-primary" onClick={save}><CheckCircle2 size={15} /> {saved ? 'Saved!' : 'Save changes'}</button>} />
      <div className="card p-6 border border-indigo-500/20">
        <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center"><Store size={15} /></span>POS branch / Stock location</h3>
        <p className="text-xs text-sub mb-3">Each device sells from one branch. A shop with only Main branch selects it automatically. This setting is local to this POS; cloud stock and IMEI checks enforce branch ownership.</p>
        <div className="max-w-xl">
          <label className="block text-xs font-semibold text-sub mb-1.5" htmlFor="pos-branch-select">Selected branch</label>
          <select id="pos-branch-select" className="input" value={selectedBranchId} disabled={user?.role !== 'admin' || branchOptions.length === 0 || branchOptions.length === 1}
            onChange={e => { const value = e.target.value; setSelectedBranchId(value); updateSettings({ branchId: value || undefined }); if (value) void bindBranchToDevice(value); else setBranchMsg('Select an active branch before cloud sales or GRN receive.'); }}>
            <option value="">Select a branch…</option>
            {branchOptions.map(branch => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code}){branch.is_default ? ' — Main' : ''}</option>)}
          </select>
          <p className={`mt-2 text-xs ${selectedBranchId ? 'text-emerald-600' : 'text-amber-600'}`}>{branchMsg}</p>
          {branchOptions.length > 1 && !selectedBranchId && <p className="mt-2 text-xs font-semibold text-amber-600">Branch selection is required before this device can sync a sale or receive stock.</p>}
        </div>
      </div>
      {user?.role === 'admin' && (
        <div className="card p-6 border border-sky-500/20">
          <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-500 flex items-center justify-center"><Download size={15} /></span>App updates</h3>
          <p className="text-xs text-faint mb-4">Update inside the app without leaving the POS.</p>
          <div className="flex flex-wrap items-center gap-2"><span className="badge bg-raised text-ink">Current version: {appVersion}</span>{updateState.status==='available'&&<span className="badge bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">New version: {updateState.version}</span>}</div>
          {desktopApi?.isPortable&&<p className="text-[11px] text-amber-600 dark:text-amber-400 mt-3">Portable edition detected. Automatic updates require the installed Setup edition.</p>}
          {updateState.status==='downloading'&&<div className="mt-4"><div className="flex justify-between text-[11px] font-semibold text-sub mb-1.5"><span>Downloading update…</span><span>{Math.round(updateState.percent||0)}%</span></div><div className="h-2 rounded-full bg-raised overflow-hidden"><div className="h-full rounded-full bg-sky-500 transition-all" style={{width:(Math.max(0,Math.min(100,updateState.percent||0)))+'%'}} /></div></div>}
          {updateState.status==='downloaded'&&<p className="text-[12px] font-semibold text-emerald-600 dark:text-emerald-400 mt-3">Update downloaded. Restarting…</p>}
          {updateState.status==='error'&&<p className="text-[12px] font-medium text-rose-500 mt-3">Update check failed: {updateState.message}</p>}
          {updateState.status==='idle'&&updateState.message&&<p className="text-[12px] font-semibold text-emerald-600 dark:text-emerald-400 mt-3">{updateState.message}</p>}
          {updateState.status==='not-available'&&<p className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400 mt-3">You are already using the latest version.</p>}
          <div className="flex flex-wrap gap-2 mt-4"><button type="button" className="btn btn-soft" onClick={()=>void checkForAppUpdates()} disabled={updateState.status==='checking'||updateState.status==='downloading'}><CheckCircle2 size={15} /> {updateState.status==='checking'?'Checking…':'Check for updates'}</button>{updateState.status==='available'&&<button type="button" className="btn btn-primary" onClick={()=>void updateNow()} disabled={Boolean(desktopApi?.isPortable)}><Download size={15} /> Update now</button>}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" className="btn btn-danger-soft" onClick={() => void revokeCurrentUpdaterDevice()} disabled={!desktopApi?.isPackaged}><Lock size={14} /> Revoke this PC's update access</button><span className="text-[10px] text-faint">Does not sign out POS or affect Google Drive backup.</span></div>
          {desktopApi?.isPackaged && <div className="mt-3 rounded-xl border border-line bg-raised/40 px-3.5 py-3 text-[11px] text-faint"><span className="font-bold text-ink">Registered updater device:</span> <span className="font-mono">{phoneSalesMachine.id}</span><span className="mx-2 text-line">·</span>Server-side revocation removes the persistent updater token without affecting POS login or Google Drive backup.</div>}
          {updateState.status==='available'&&<p className="mt-3 text-[11px] font-semibold text-sub">Version {updateState.version} is ready. Update now downloads it securely, closes the POS, installs it silently, and reopens the updated POS automatically.</p>}
        </div>
      )}


      {user?.role === 'admin' && (
        <div className="card p-6 border border-emerald-500/20 mt-5">
          <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><ShieldCheck size={15} /></span>Cloud update authorization</h3>
          <p className="text-xs text-faint mb-4">One-time setup for the private Windows updater. This creates the cloud account and first shop only when you explicitly start this setup; normal local POS login remains unchanged.</p>
          <div className="grid sm:grid-cols-2 gap-3.5">
            <Field label="Cloud account email" hint="Use the Supabase Auth Admin email; it may be different from the local POS login email."><input type="email" className="input" value={cloudSetupEmail} onChange={e => { setCloudSetupEmail(e.target.value); setCloudSetupMsg(null); }} placeholder="cloud-admin@example.com" autoComplete="email" /></Field>
            <Field label="Cloud account password" hint="Minimum 12 characters"><input type="password" className="input" value={cloudSetupPassword} onChange={e => { setCloudSetupPassword(e.target.value); setCloudSetupMsg(null); }} placeholder="Choose a separate cloud password" autoComplete="new-password" onKeyDown={e => { if (e.key === 'Enter') void provisionCloudUpdater(); }} /></Field>          </div>
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button type="button" className="btn btn-primary" onClick={() => void provisionCloudUpdater()} disabled={cloudSetupBusy || legacyOtpBusy || !cloudSetupEmail.trim() || cloudSetupPassword.length < 12}>{cloudSetupBusy ? 'Setting up cloud authorization…' : 'Initialize cloud updater'}</button>            <span className="text-[11px] text-faint">Shop: <b className="text-ink">{form.shopName || state.settings.shopName || 'Nexfix Shop'}</b></span>
          </div>
          {cloudSetupMsg && <p className={`mt-3 text-[12px] font-semibold ${cloudSetupMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>{cloudSetupMsg.text}</p>}
          <p className="text-[11px] text-faint mt-3">If Supabase requires email confirmation, confirm the message sent to the cloud account and then sign in again before retrying this setup.</p>
          <div className="mt-5 rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-4">
            <div className="flex items-start gap-3">
              <Lock size={16} className="mt-0.5 shrink-0 text-sky-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink">Legacy installation migration — no local password reset</p>
                <p className="mt-1 text-[11px] leading-5 text-faint">For existing shops that already have local Admin/Cashier accounts, use the provisioned cloud Admin email to authorize this machine. Your existing local passwords stay exactly as they are.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary" onClick={() => void migrateLegacyUpdater()} disabled={cloudSetupBusy || legacyOtpBusy || !desktopApi?.isPackaged || cloudSetupPassword.length < 12}>{legacyOtpBusy ? 'Authorizing…' : 'Authorize this Windows PC'}</button>
                </div>
                {legacyOtpMsg && <p className={`mt-2 text-[11px] font-semibold ${legacyOtpMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>{legacyOtpMsg.text}</p>}
                <p className="mt-2 text-[10px] text-faint">Uses the existing Cloud Admin email + password above. No email, rate-limit, deep-link, or 6-digit code is needed. Your local POS Admin/Cashier passwords are not changed.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-stretch content-start">
        <div className="card p-6">
          <h3 className="font-bold text-ink flex items-center gap-2 mb-5"><span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><Store size={15} /></span>Shop Profile</h3>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4"><Field label="Shop name"><input className="input" value={form.shopName ?? ''} onChange={set('shopName')} /></Field><Field label="Tagline"><input className="input" value={form.tagline ?? ''} onChange={set('tagline')} /></Field></div>
            <Field label="Address"><input className="input" value={form.address ?? ''} onChange={set('address')} /></Field>
            <div className="grid sm:grid-cols-2 gap-4"><Field label="Phone"><input className="input" value={form.phone ?? ''} onChange={set('phone')} /></Field><Field label="Email"><input className="input" value={form.email ?? ''} onChange={set('email')} /></Field></div>
            <Field label="Receipt footer"><textarea className="input min-h-[70px] resize-none" value={form.receiptFooter ?? ''} onChange={set('receiptFooter')} /></Field>
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
            <label className="flex items-center justify-between gap-3 rounded-xl bg-raised border border-line px-4 py-3 mt-4 cursor-pointer"><span className="flex items-center gap-2.5 text-sm font-medium text-ink"><MessageCircle size={15} className="text-emerald-500" /> WhatsApp auto-receipt <span className="text-[11px] text-faint font-normal">Auto-open after every checkout. Off = cashier chooses per bill</span></span><Toggle checked={form.whatsappReceipts !== false} onChange={v => {
              setForm(f => ({ ...f, whatsappReceipts: v }));
              updateSettings({ whatsappReceipts: v });
            }} /></label>
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
                <Field label="Current admin unlock PIN" hint={state.settings.adminPinHash ? 'Enter the current admin unlock PIN. If you have never set one, use your administrator login password.' : 'No unlock PIN is set yet. Enter your current administrator login password here, then choose a new PIN.'}><div className="relative"><Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" /><input type={showPins ? 'text' : 'password'} className="input pl-9 pr-10" value={pinCur} onChange={e => { setPinCur(e.target.value); setPinMsg(null); }} placeholder={state.settings.adminPinHash ? 'Current admin unlock PIN' : 'Current administrator login password'} /><button type="button" onClick={() => setShowPins(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink">{showPins ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></Field>
                <div className="grid sm:grid-cols-2 gap-3.5"><Field label="New admin unlock PIN"><input type={showPins ? 'text' : 'password'} className="input" value={pinNew} onChange={e => { setPinNew(e.target.value); setPinMsg(null); }} placeholder="Min 4 characters" /></Field><Field label="Confirm new admin unlock PIN"><input type={showPins ? 'text' : 'password'} className="input" value={pinConfirm} onChange={e => { setPinConfirm(e.target.value); setPinMsg(null); }} placeholder="Repeat it" onKeyDown={e => { if (e.key === 'Enter') submitPin(); }} /></Field></div>
                {pinMsg && <p className={`flex items-center gap-1.5 text-[13px] font-semibold ${pinMsg.ok ? 'text-emerald-500' : 'text-rose-500'}`}>{pinMsg.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {pinMsg.text}</p>}
                <button className="btn btn-primary" onClick={() => void submitPin()} disabled={!pinNew || !pinConfirm || !pinCur}><ShieldCheck size={15} /> Update admin unlock PIN</button>
              </div>
            </div>
          </div>

          <div className="card p-6 border border-sky-500/20">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-500 flex items-center justify-center"><Lock size={15} /></span>Session Security</h3>
            <p className="text-xs text-faint mb-4">Automatically lock the POS after inactivity. The current cart and offline data remain in memory; unlocking requires the current user's password, or the admin unlock password for an administrator.</p>
            <Field label="Idle lock (minutes)" hint="1–120 minutes. Default is 10 minutes.">
              <input type="number" min={1} max={120} className="input max-w-[180px]" value={form.securityIdleMinutes} onChange={num('securityIdleMinutes')} />
            </Field>
          </div>

          <div className="card p-6 border border-emerald-500/20">
            <h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center"><ShieldCheck size={15} /></span>Google Backup Encryption</h3>
            <p className="text-xs text-faint mb-4">{getBackupSecurityMessage()}</p>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3.5 py-3 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
              Encryption is automatic. You do not need to enter or unlock a passphrase for normal backups.
            </div>
            <Field label="Recovery Key" hint="Generated automatically on the first Google backup. Keep a private copy outside the PC.">
              <div className="flex gap-2">
                <input type="text" className="input flex-1 font-mono text-xs" value={getRecoveryKey(recoveryScope)} readOnly placeholder="Will be generated automatically on first backup" />
                <button type="button" className="btn btn-soft shrink-0" disabled={!getRecoveryKey(recoveryScope)} onClick={async () => {
                  const key = getRecoveryKey(recoveryScope);
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
                  <button type="button" className="btn btn-primary shrink-0" disabled={!recoveryKeyInput} onClick={async () => {
                    if (!(await confirmSensitiveAdmin('Recovery Key reconnect'))) { setRecoveryKeyMsg('Administrator confirmation cancelled.'); return; }
                    const result = setRecoveryKey(recoveryKeyInput, recoveryScope);
                    if (!result.ok) { setRecoveryKeyMsg(result.error || 'Invalid Recovery Key'); return; }
                    setRecoveryKeyInput('');
                    setRecoveryKeyReady(true);
                    setRecoveryKeyMsg('Recovery Key saved. Automatic encryption and restore are ready.');
                  }}>Use Key</button>
                </div>
              </Field>
              <input ref={recoveryKeyFileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={e => { void importRecoveryKeyFile(e.target.files?.[0]); }} />
              <button type="button" className="btn btn-soft mt-2" onClick={() => recoveryKeyFileRef.current?.click()}><Upload size={14} /> Import RECOVERY_KEY.txt</button>
              <p className="text-[11px] text-faint mt-2">If Backup now says “Recovery Key mismatch”, import the original RECOVERY_KEY.txt from this shop instead of generating a new key.</p>
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
            <div className="flex flex-wrap gap-2 mb-4 text-[11px] font-semibold"><span className={`badge ${connectivity === 'online' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-500'}`}>{connectivity === 'online' ? '● ONLINE' : '● OFFLINE'}</span>{pendingQueueCount > 0 && <span className="badge bg-amber-500/15 text-amber-600">{pendingQueueCount} queued write(s)</span>}{backupMeta.lastManualBackupAt && <span className="badge bg-sky-500/10 text-sky-600">Last manual: {new Date(backupMeta.lastManualBackupAt).toLocaleString()}</span>}{backupMeta.lastAutoBackupAt && <span className="badge bg-violet-500/10 text-violet-600">Last auto: {new Date(backupMeta.lastAutoBackupAt).toLocaleString()}</span>}{backupMeta.lastCloudBackupAt && <span className="badge bg-emerald-500/10 text-emerald-600">Last cloud: {new Date(backupMeta.lastCloudBackupAt).toLocaleString()}</span>}{backupMeta.lastCloudBackupError && <span className="badge bg-rose-500/10 text-rose-600" title={backupMeta.lastCloudBackupError}>Last cloud error: {backupMeta.lastCloudBackupError}</span>}</div>
            <div className="rounded-xl border border-line bg-raised/40 p-3.5 mb-4"><div className="text-[12px] font-bold text-ink mb-2">Auto backup interval</div><div className="flex flex-wrap items-center gap-2">{[0, 1 / 60, 5 / 60, 0.25, 0.5, 1, 3, 6, 12, 24].map(h => <button key={h} type="button" className={`btn !py-1.5 !px-3 text-[12px] ${autoHours === h ? 'btn-primary' : 'btn-soft'}`} onClick={async () => { setAutoHours(h); await setAutoBackupHours(h); setBackupMsg(h === 0 ? 'Auto-backup disabled' : `Auto-backup every ${h < 1 ? Math.round(h * 60) + 'm' : h + 'h'}`); }}>{h === 0 ? 'OFF' : h < 1 ? `${Math.round(h * 60)}m` : `${h}h`}</button>)}</div><p className="text-[11px] text-faint mt-2">When due, an encrypted backup snapshot is saved to the configured Google Drive shop backup folder automatically. A best-effort cloud backup is also attempted when closing the POS while online.</p></div>
            <div className="flex flex-wrap gap-2.5">
              {can('act:export') && (
                <button
                  className="btn btn-soft"
                  onClick={async () => {
                    setBackupMsg('Preparing secure backup…');
                    const result = await runManualBackup();
                    setBackupMsg(result.ok ? 'Manual backup downloaded successfully.' : (result.error || 'Backup download failed.'));
                  }}
                >
                  <Download size={15} /> Export backup
                </button>
              )}
              {user?.role === 'admin' && (
                <button className="btn btn-soft" onClick={() => fileRef.current?.click()}>
                  <Upload size={15} /> Import backup
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".json,.manifest.json,.part,application/json,text/plain,application/octet-stream"
                multiple
                className="hidden"
                onChange={e => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) onImport(files);
                  e.target.value = '';
                }}
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
            </div>
            {(importMsg || backupMsg) && <p className={`text-[13px] font-medium mt-3 ${(importMsg || backupMsg).includes('success') || (importMsg || backupMsg).includes('downloaded') || (importMsg || backupMsg).includes('Flushed') || (importMsg || backupMsg).includes('Auto') || (importMsg || backupMsg).includes('Google') || (importMsg || backupMsg).includes('Reloading') ? 'text-emerald-500' : 'text-rose-500'}`}>{importMsg || backupMsg}</p>}
          </div>

          {user?.role === 'admin' && <div className="card p-6 border border-rose-500/25"><h3 className="font-bold text-rose-600 dark:text-rose-400 flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center"><RotateCcw size={15} /></span>Danger Zone</h3><p className="text-xs text-faint mb-4">Clear the current local dataset and restore the demo dataset. This action replaces local POS records and cannot be undone.</p><button className="btn btn-danger-soft" onClick={() => setConfirmReset(true)}><RotateCcw size={15} /> Clear Demo Data</button></div>}

          <div className="card p-6"><h3 className="font-bold text-ink flex items-center gap-2 mb-2"><span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center"><Cloud size={15} /></span>Google Drive Backup</h3><p className="text-xs text-faint mb-3">Automatic Google Drive backup is centrally managed. The POS sends each shop's backup to its own isolated folder; shop users do not need to configure a Google URL.</p><div className={`flex items-center gap-2 text-[12px] font-semibold mb-3 ${autoHours > 0 ? 'text-emerald-600' : 'text-slate-500 dark:text-slate-400'}`}>{autoHours > 0 ? <><CheckCircle2 size={15} /> Automatic backup is enabled</> : <>Automatic backup is disabled</>}</div>{!recoveryKeyReady && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[12px] font-semibold text-amber-700 dark:text-amber-300 mb-3">The first encrypted Google backup will generate the Recovery Key automatically. On a replacement PC, paste the saved Recovery Key before restoring.</div>}<div className="flex flex-wrap gap-2 mt-3">{user?.role === 'admin' && <><button type="button" className="btn btn-primary" disabled={!gEnabled || connectivity !== 'online' || gRestoreBusy} onClick={runGoogleBackupNow}><Cloud size={15} /> {gRestoreBusy ? 'Uploading / confirming…' : 'Backup now to Google Drive'}</button><button type="button" className="btn btn-soft" disabled={!gEnabled || connectivity !== 'online' || gRestoreBusy} onClick={requestGoogleRestore}><RotateCcw size={15} /> {gRestoreBusy ? 'Working…' : 'Restore latest Google backup'}</button></>}</div>{gMsg && <p className={`text-[13px] font-medium mt-3 ${/failed|unauthorized|outdated|invalid|missing|requires|could not|timed out|error|mismatch|not configured|not found|access|retry/i.test(gMsg) ? 'text-rose-500' : 'text-emerald-500'}`}>{gMsg}</p>}<p className="text-[11px] text-faint mt-3">If Windows is damaged or this POS is moved to a new PC, first use the existing Shop Backup ID above to reconnect to the same shop, then paste the Recovery Key from RECOVERY_KEY.txt and restore the latest encrypted backup.</p></div>
          <div className="card p-6"><h3 className="font-bold text-ink flex items-center gap-2 mb-3"><span className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center"><ReceiptText size={15} /></span>Receipt Identity</h3><div className="flex flex-wrap gap-2"><Badge tone="violet">{form.shopName}</Badge><Badge tone="slate">{form.phone}</Badge><Badge tone="slate">{form.email}</Badge><Badge tone="amber">{form.exchangeDays}-day exchange policy</Badge></div><p className="text-xs text-faint mt-3">These print on every bill and price tag sheet.</p></div>
      </div>

      <Modal        open={confirmGoogleRestore !== null}
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
      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Clear demo data?" sub="Restore the demo seed"><div className="rounded-xl bg-amber-500/[0.08] border border-amber-500/25 px-4 py-3 flex items-start gap-2.5 text-sm text-amber-600 dark:text-amber-400"><AlertTriangle size={16} className="shrink-0 mt-0.5" />Products, sales, customers, expenses and settings will be replaced with the demo dataset. Export a backup first if you need your records.</div><div className="flex gap-2.5 mt-5"><button className="btn btn-danger-soft flex-1" onClick={async () => { if (await confirmSensitiveAdmin('clear local POS data')) { resetData(); setConfirmReset(false); } else { setBackupMsg('Administrator confirmation cancelled.'); } }}><RotateCcw size={15} /> Clear Demo Data</button><button className="btn btn-soft flex-1" onClick={() => setConfirmReset(false)}>Cancel</button></div></Modal>
    </div>
  );
}