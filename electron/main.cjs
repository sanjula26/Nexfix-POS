const { app, BrowserWindow, session, ipcMain, clipboard, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Supabase/Cloudflare can negotiate HTTP/3/QUIC on Windows. This POS has
// repeatedly observed Chromium ERR_QUIC_PROTOCOL_ERROR on the updater path.
// Force the updater and renderer onto the reliable TCP-based HTTP path so a
// broken UDP/443/QUIC route cannot strand the update check or download.
app.commandLine.appendSwitch('disable-quic');

const isDev = !app.isPackaged;
const DEV_URL = process.env.NEXFIX_DEV_URL || 'http://localhost:5173/';
let autoUpdater = null;
let pendingUpdateInfo = null;
let updateDownloadActive = false;
let updateInstallScheduled = false;
let updateAuthToken = '';
let updateDeviceId = '';
let updateAuthMode = 'bearer';
let updateCheckPromise = null;
const UPDATE_CHECK_TIMEOUT_MS = 30 * 1000;
const UPDATE_FEED_URL = 'https://ocmzgamnehwbkuwkjdrr.supabase.co/functions/v1/desktop-updates';
const AUTH_PROTOCOL = 'nexfix';
let pendingAuthCallback = null;
const singleInstanceLock = app.requestSingleInstanceLock();

function emitAuthCallback(url){
  try{
    const parsed = new URL(url);
    if(parsed.protocol !== AUTH_PROTOCOL + ':' || parsed.hostname !== 'auth' || parsed.pathname !== '/callback') return;
    const code = parsed.searchParams.get('code')?.trim() || '';
    if(!code || code.length > 4096) return;
    const flowId = parsed.searchParams.get('sb_flow_id')?.trim() || '';
    pendingAuthCallback = { code, flowId: flowId || undefined };
    const win = getMainWindow();
    if(win && !win.isDestroyed()) win.webContents.send('auth:callback', pendingAuthCallback);
  }catch{}
}

if(!singleInstanceLock){
  app.quit();
}else{
  app.on('second-instance',(_event,commandLine)=>{
    const url = [...commandLine].reverse().find(value => typeof value === 'string' && value.toLowerCase().startsWith(AUTH_PROTOCOL + '://'));
    if(url) emitAuthCallback(url);
    const win = getMainWindow();
    if(win && !win.isDestroyed()){ if(win.isMinimized()) win.restore(); win.focus(); }
  });
}

function getMainWindow(){ return BrowserWindow.getAllWindows()[0] || null; }

function isTrustedRenderer(event){
  const frame=event?.senderFrame;
  if(!frame || frame!==event.sender.mainFrame) return false;
  return isAllowedNavigation(frame.url);
}

function getSecureRecoveryFile(){ return path.join(app.getPath('userData'),'nexfix-secure','cloud-updater-recovery.json'); }

function readSecureRecoveryFile(){
  try{
    if(!fs.existsSync(getSecureRecoveryFile())) return {};
    const raw=fs.readFileSync(getSecureRecoveryFile(),'utf8');
    const parsed=JSON.parse(raw);
    return parsed && typeof parsed==='object' ? parsed : {};
  }catch{return {};}
}

function writeSecureRecoveryFile(value){
  const dir=path.dirname(getSecureRecoveryFile());
  fs.mkdirSync(dir,{recursive:true});
  const tmp=getSecureRecoveryFile()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value),'utf8');
  fs.renameSync(tmp,getSecureRecoveryFile());
}
function sendUpdateEvent(type,payload={}){ const win=getMainWindow(); if(win&&!win.isDestroyed()) win.webContents.send('update:event',{type,...payload}); }

function restoreStoredUpdaterCredentials(){
  if(!safeStorage.isEncryptionAvailable()) return false;
  try{
    const encrypted=readSecureRecoveryFile().cloudUpdaterDeviceToken;
    if(typeof encrypted!=='string'||!encrypted) return false;
    const decrypted=safeStorage.decryptString(Buffer.from(encrypted,'base64')).trim();
    let token='';
    let deviceId='';
    try{
      const parsed=JSON.parse(decrypted);
      token=typeof parsed?.token==='string'?parsed.token.trim():'';
      deviceId=typeof parsed?.deviceId==='string'?parsed.deviceId.trim():'';
    }catch{
      // Older v3.0.1279 records contain only the token; the renderer will
      // provide the current device identity during its normal auth restore.
      token=decrypted;
    }
    if(!token || token.length<64 || token.length>512 || !deviceId || deviceId.length>200) return false;
    updateAuthToken=token;
    updateDeviceId=deviceId;
    updateAuthMode='device';
    return true;
  }catch{
    return false;
  }
}

function configureUpdaterCredentials(){
  if (!autoUpdater) return false;
  const authorized = Boolean(updateAuthToken && updateDeviceId);

  // electron-updater reads requestHeaders from the updater instance. Passing
  // requestHeaders only to setFeedURL() does not reliably carry them into
  // manifest/download requests on installed clients.
  autoUpdater.requestHeaders = authorized ? {
    ...(updateAuthMode === 'device'
      ? { 'X-Nexfix-Update-Token': updateAuthToken }
      : { Authorization: `Bearer ${updateAuthToken}` }),
    'X-Nexfix-Device': updateDeviceId,
    'Cache-Control': 'no-cache',
  } : null;

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${UPDATE_FEED_URL}/`,
    useMultipleRangeRequest: false,
    // A metadata check must fail fast. A hung network request must never leave
    // the Settings UI stuck on "Checking..." indefinitely.
    timeout: UPDATE_CHECK_TIMEOUT_MS,
    publishAutoUpdate: false,
  });
  return authorized;
}

async function downloadDirectPrivateUpdate() {
  if (!updateAuthToken || !updateDeviceId) throw new Error('Update authorization is not ready.');
  const headers = { 'X-Nexfix-Device': updateDeviceId };
  if (updateAuthMode === 'device') headers['X-Nexfix-Update-Token'] = updateAuthToken;
  else headers.Authorization = `Bearer ${updateAuthToken}`;

  const manifestResponse = await fetch(`${UPDATE_FEED_URL}?download=1`, { headers });
  const manifestText = await manifestResponse.text();
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { manifest = null; }
  if (!manifestResponse.ok || !manifest?.ok || typeof manifest.url !== 'string' || !manifest.url) {
    throw new Error(manifest?.error || 'Could not authorize the direct private update download.');
  }

  const expectedSize = Number(manifest.size);
  const expectedHash = String(manifest.sha512 || '').trim();
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error('Invalid installer size from the private update gateway.');
  if (!/^[a-f0-9]{128}$/i.test(expectedHash) && !/^[A-Za-z0-9+/]{86}==$/.test(expectedHash)) {
    throw new Error('Invalid installer SHA-512 from the private update gateway.');
  }

  const safeName = path.basename(String(manifest.name || 'Nexfix-POS-update.exe')).replace(/[^A-Za-z0-9._-]/g, '_');
  const tempDir = path.join(app.getPath('temp'), 'Nexfix-POS-Updater');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, safeName + '.download');
  const installerPath = path.join(tempDir, safeName);
  try { fs.rmSync(tempPath, { force: true }); } catch {}
  try { fs.rmSync(installerPath, { force: true }); } catch {}

  const response = await fetch(manifest.url);
  if (!response.ok || !response.body) {
    throw new Error(`Private installer download failed (HTTP ${response.status}).`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength !== expectedSize) {
    throw new Error(`Installer Content-Length mismatch. Expected ${expectedSize} bytes, received ${contentLength}.`);
  }

  const handle = await fs.promises.open(tempPath, 'w');
  const hash = crypto.createHash('sha512');
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      if (!buffer.length) continue;
      await handle.write(buffer, 0, buffer.length, total);
      hash.update(buffer);
      total += buffer.length;
      sendUpdateEvent('progress', { percent: Math.min(99, (total / expectedSize) * 100) });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
    await handle.close();
  }

  const digest = hash.digest();
  const actualHex = digest.toString('hex');
  const actualBase64 = digest.toString('base64');
  if (total !== expectedSize) throw new Error(`Installer size verification failed. Expected ${expectedSize} bytes, received ${total}.`);
  if (actualHex.toLowerCase() !== expectedHash.toLowerCase() && actualBase64 !== expectedHash) {
    throw new Error('Installer SHA-512 verification failed. The update was NOT installed.');
  }

  fs.renameSync(tempPath, installerPath);
  sendUpdateEvent('progress', { percent: 100 });
  return { version: String(manifest.version || ''), installerPath, installerName: safeName };
}

function setupAutoUpdater(){
  if(!app.isPackaged || process.platform!=='win32') return;
  try{
    ({autoUpdater}=require('electron-updater'));
    // Restore the encrypted per-device updater credential before the renderer
    // starts. This removes the restart-time renderer race while keeping the
    // token protected by Windows safeStorage.
    restoreStoredUpdaterCredentials();
    // Always point the updater at the private Supabase gateway. Never fall back
    // to the build-time GitHub provider before a signed-in session supplies
    // authorization headers.
    configureUpdaterCredentials();
    autoUpdater.autoDownload=false;
    // The private gateway reconstructs the full NSIS installer from protected chunks.
    // Do not let electron-updater request a blockmap/differential payload that the
    // gateway does not publish.
    autoUpdater.disableDifferentialDownload=true;
    autoUpdater.autoInstallOnAppQuit=false;
    autoUpdater.on('checking-for-update',()=>sendUpdateEvent('checking'));
    autoUpdater.on('update-available',info=>{pendingUpdateInfo=info;sendUpdateEvent('available',{version:info.version});});
    autoUpdater.on('update-not-available',info=>{pendingUpdateInfo=null;sendUpdateEvent('not-available',{version:info?.version||app.getVersion()});});
    autoUpdater.on('download-progress',info=>sendUpdateEvent('progress',{percent:Number(info.percent||0)}));
    autoUpdater.on('update-downloaded',info=>{
      pendingUpdateInfo=info; updateDownloadActive=false;
      sendUpdateEvent('downloaded',{version:info?.version||''});
      // Install the downloaded NSIS update silently and relaunch the POS.
      // No installer is copied to the user's Downloads folder.
      if(!updateInstallScheduled){
        updateInstallScheduled=true;
        setTimeout(()=>{
          try{ autoUpdater.quitAndInstall(true,true); }
          catch(error){
            updateInstallScheduled=false;
            sendUpdateEvent('error',{message:error?.message||String(error)});
          }
        },600);
      }
    });
    autoUpdater.on('error',error=>{updateDownloadActive=false;updateInstallScheduled=false;sendUpdateEvent('error',{message:error?.message||String(error)});});
    ipcMain.handle('cloud-recovery:save',(event,payload)=>{
      if(!isTrustedRenderer(event)) return {ok:false,error:'Untrusted renderer'};
      if(!safeStorage.isEncryptionAvailable()) return {ok:false,error:'OS secure storage is unavailable'};
      const email=typeof payload?.email==='string'?payload.email.trim().toLowerCase():'';
      const userId=typeof payload?.userId==='string'?payload.userId.trim():'';
      const refreshToken=typeof payload?.refreshToken==='string'?payload.refreshToken.trim():'';
      // Supabase refresh tokens are opaque credentials. Keep a generous
      // upper bound for future token formats while rejecting empty/absurd payloads.
      // Supabase refresh tokens are opaque credentials and their exact length is not a stable API contract.
      // Only reject missing or absurdly large values; never assume a minimum token length.
      if(!email || !userId || !refreshToken || refreshToken.length>16384) return {ok:false,error:'Invalid cloud recovery credential'};
      try{
        const encrypted=safeStorage.encryptString(JSON.stringify({email,userId,refreshToken,updatedAt:new Date().toISOString()})).toString('base64');
        writeSecureRecoveryFile({version:1,cloudUpdaterRecovery:encrypted});
        return {ok:true};
      }catch(error){ return {ok:false,error:error?.message||String(error)}; }
    });
    ipcMain.handle('cloud-recovery:load',(event,email)=>{
      if(!isTrustedRenderer(event)) return {ok:false,error:'Untrusted renderer'};
      if(!safeStorage.isEncryptionAvailable()) return {ok:false,error:'OS secure storage is unavailable'};
      const wanted=typeof email==='string'?email.trim().toLowerCase():'';
      if(!wanted) return {ok:false,error:'Cloud account email is required'};
      try{
        const encrypted=readSecureRecoveryFile().cloudUpdaterRecovery;
        if(typeof encrypted!=='string'||!encrypted) return {ok:true,found:false};
        const parsed=JSON.parse(safeStorage.decryptString(Buffer.from(encrypted,'base64')));
        if(!parsed || typeof parsed!=='object' || parsed.email!==wanted || typeof parsed.userId!=='string' || typeof parsed.refreshToken!=='string') return {ok:true,found:false};
        return {ok:true,found:true,userId:parsed.userId,refreshToken:parsed.refreshToken};
      }catch{return {ok:false,error:'Stored cloud recovery credential could not be opened'};}
    });
    ipcMain.handle('cloud-updater-token:save',(event,payload)=>{
      if(!isTrustedRenderer(event)) return {ok:false,error:'Untrusted renderer'};
      if(!safeStorage.isEncryptionAvailable()) return {ok:false,error:'OS secure storage is unavailable'};
      const token=typeof payload?.token==='string'?payload.token.trim():'';
      const deviceId=typeof payload?.deviceId==='string'?payload.deviceId.trim():'';
      if(!token || token.length<64 || token.length>512 || !deviceId || deviceId.length>200) return {ok:false,error:'Invalid Windows updater authorization token'};
      try{
        const current=readSecureRecoveryFile();
        current.cloudUpdaterDeviceToken=safeStorage.encryptString(JSON.stringify({token,deviceId})).toString('base64');
        current.cloudUpdaterDeviceTokenVersion=1;
        writeSecureRecoveryFile({...current,version:2});
        return {ok:true};
      }catch(error){return {ok:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('cloud-updater-token:load',(event)=>{
      if(!isTrustedRenderer(event)) return {ok:false,error:'Untrusted renderer'};
      if(!safeStorage.isEncryptionAvailable()) return {ok:false,error:'OS secure storage is unavailable'};
      try{
        const encrypted=readSecureRecoveryFile().cloudUpdaterDeviceToken;
        if(typeof encrypted!=='string'||!encrypted) return {ok:true,found:false};
        const decrypted=safeStorage.decryptString(Buffer.from(encrypted,'base64')).trim();
        let token='';
        let storedDeviceId='';
        try{
          const parsed=JSON.parse(decrypted);
          token=typeof parsed?.token==='string'?parsed.token.trim():'';
          storedDeviceId=typeof parsed?.deviceId==='string'?parsed.deviceId.trim():'';
        }catch{
          // Backward-compatible migration for tokens saved by v3.0.1279 before
          // the device id was included in the encrypted record.
          token=decrypted;
        }
        if(!token || token.length<64 || token.length>512) return {ok:true,found:false};
        return {ok:true,found:true,token,deviceId:storedDeviceId};
      }catch{return {ok:false,error:'Stored Windows updater authorization could not be opened'};}
    });
    ipcMain.handle('cloud-updater-token:clear',(event)=>{
      if(!isTrustedRenderer(event)) return {ok:false,error:'Untrusted renderer'};
      try{
        const current=readSecureRecoveryFile();
        delete current.cloudUpdaterDeviceToken;
        delete current.cloudUpdaterDeviceTokenVersion;
        if(Object.keys(current).length===0){try{fs.rmSync(getSecureRecoveryFile(),{force:true});}catch{}}
        else writeSecureRecoveryFile(current);
        return {ok:true};
      }catch(error){return {ok:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('cloud-recovery:clear',(event)=>{
      if(!isTrustedRenderer(event)) return {ok:false,error:'Untrusted renderer'};
      try{
        const value=readSecureRecoveryFile();
        delete value.cloudUpdaterRecovery;
        if(Object.keys(value).length===0){try{fs.rmSync(getSecureRecoveryFile(),{force:true});}catch{}}
        else writeSecureRecoveryFile(value);
        return {ok:true};
      }catch(error){return {ok:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('update:set-credentials',(_event,payload)=>{
      const token=typeof payload?.token==='string'?payload.token.trim():'';
      const deviceId=typeof payload?.deviceId==='string'?payload.deviceId.trim():'';
      const mode=payload?.mode==='device'?'device':'bearer';
      // Supabase access tokens are opaque credentials; device updater tokens are
      // high-entropy 32-byte values encoded as 64 hex characters. Never assume
      // a JWT minimum length for the legacy bearer path.
      updateAuthToken=token && token.length<=16384?token:'';
      updateDeviceId=deviceId.length>=1&&deviceId.length<=200?deviceId:'';
      updateAuthMode=mode;
      pendingUpdateInfo=null;
      const ok=configureUpdaterCredentials();
      if(ok) setTimeout(()=>{ void autoUpdater.checkForUpdates().catch(()=>{}); },250);
      return {ok};
    });
    ipcMain.handle('update:clear-credentials',()=>{ updateAuthToken=''; updateDeviceId=''; updateAuthMode='bearer'; pendingUpdateInfo=null; updateDownloadActive=false; updateInstallScheduled=false; configureUpdaterCredentials(); return {ok:true}; });
    ipcMain.handle('update:status',()=>({supported:true,authorized:Boolean(updateAuthToken&&updateDeviceId),authorizationMode:updateAuthMode,available:Boolean(pendingUpdateInfo),version:pendingUpdateInfo?.version||null,downloading:updateDownloadActive}));
    const checkForUpdatesWithTimeout = async()=>{
      if(updateCheckPromise)return updateCheckPromise;
      updateCheckPromise=(async()=>{
        try{
          return await Promise.race([
            autoUpdater.checkForUpdates(),
            new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Update check timed out after ${UPDATE_CHECK_TIMEOUT_MS/1000} seconds. Please check your internet connection and try again.`)),UPDATE_CHECK_TIMEOUT_MS)),
          ]);
        }finally{
          updateCheckPromise=null;
        }
      })();
      return updateCheckPromise;
    };
    ipcMain.handle('update:check',async()=>{
      if(!app.isPackaged||!autoUpdater)return{supported:false,available:false};
      if(!configureUpdaterCredentials())return{supported:true,available:false,error:'Update authorization is not ready.'};
      try{
        const result=await checkForUpdatesWithTimeout();
        return{supported:true,available:Boolean(result?.isUpdateAvailable),version:result?.updateInfo?.version||null};
      }catch(error){
        const message=error?.message||String(error);
        sendUpdateEvent('error',{message});
        return{supported:true,available:false,error:message};
      }
    });
    ipcMain.handle('update:downloadAndInstall',async()=>{
      if(!app.isPackaged||process.platform!=='win32')return{supported:false,started:false};
      if(!configureUpdaterCredentials())return{supported:true,started:false,error:'Update authorization is not ready.'};
      if(updateDownloadActive||updateInstallScheduled)return{supported:true,started:false};
      try{
        if(!pendingUpdateInfo){
          const result=await checkForUpdatesWithTimeout();
          if(!result?.isUpdateAvailable)return{supported:true,started:false};
          pendingUpdateInfo=result.updateInfo;
        }

        // IMPORTANT: use electron-updater for the actual install handoff.
        // The private gateway already returns standard electron-updater YAML whose
        // installer URL is a short-lived, authorized Cloudflare R2 presigned URL.
        // This lets electron-updater own the Windows NSIS lifecycle and relaunch
        // instead of manually spawning a second PowerShell installer process.
        updateDownloadActive=true;
        sendUpdateEvent('progress',{percent:0});
        await autoUpdater.downloadUpdate();
        return{supported:true,started:true};
      }catch(error){
        updateDownloadActive=false;
        updateInstallScheduled=false;
        const message=error?.message||String(error);
        sendUpdateEvent('error',{message});
        return{supported:true,started:false,error:message};
      }
    });

    const checkNow=()=>{
      if(!configureUpdaterCredentials()) return;
      void checkForUpdatesWithTimeout().catch(()=>{});
    };
    setTimeout(checkNow,5000);
    setInterval(checkNow,10*60*1000);
    app.on('browser-window-focus',checkNow);
  }catch(error){console.warn('[Nexfix updater] unavailable:',error?.message||error);}
}

function isAllowedNavigation(url){try{const parsed=new URL(url);if(isDev)return parsed.origin===new URL(DEV_URL).origin;return parsed.protocol==='file:';}catch{return false;}}
function createWindow(){
  const win=new BrowserWindow({width:1440,height:900,minWidth:1100,minHeight:700,backgroundColor:'#f5f6fb',icon:path.join(__dirname,'..','build','icon.ico'),show:false,frame:false,fullscreen:true,kiosk:true,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(({url})=>{
    if(isAllowedNavigation(url)) return {action:'allow'};
    try{
      const parsed=new URL(url);
      if(parsed.protocol==='https:' && parsed.hostname==='wa.me'){
        void shell.openExternal(url);
      }
    }catch{}
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url)=>{if(!isAllowedNavigation(url))event.preventDefault();});
  win.webContents.on('will-redirect',(event,url)=>{if(!isAllowedNavigation(url))event.preventDefault();});
  const debugPackaged=app.isPackaged && process.env.NEXFIX_DEBUG==='1';
  win.webContents.on('did-fail-load',(_event,errorCode,errorDescription,validatedURL)=>{
    console.error(`[Nexfix renderer load failed] ${errorCode}: ${errorDescription} ${validatedURL}`);
    if(debugPackaged && !win.isDestroyed()) win.webContents.openDevTools({mode:'detach'});
  });
  if(debugPackaged){
    win.webContents.on('console-message',(_event,level,message,line,sourceId)=>{
      console.error(`[Nexfix renderer console] level=${level} ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('dom-ready',()=>{if(!win.isDestroyed())win.webContents.openDevTools({mode:'detach'});});
  }
  win.once('ready-to-show',()=>{ win.setFullScreen(true); win.setKiosk(true); win.show(); });
  if(isDev){
    win.loadURL(DEV_URL).catch(error=>console.error('[Nexfix] Failed to load development URL:',error));
  }else{
    const indexPath=path.join(__dirname,'..','dist','index.html');
    const fs=require('fs');
    if(!fs.existsSync(indexPath)){
      console.error(`[Nexfix] Packaged renderer entry is missing: ${indexPath}`);
      win.show();
      return;
    }
    console.log(`[Nexfix] Loading packaged renderer: ${indexPath}`);
    win.loadFile(indexPath).catch(error=>console.error('[Nexfix] Failed to load packaged renderer:',error));
  }
}
ipcMain.handle('app:version',()=>app.getVersion());
ipcMain.handle('app:copy-text',(_event,text)=>{if(typeof text!=='string'||!text.trim()||text.length>10000)return false;try{clipboard.writeText(text);return true;}catch{return false;}});
ipcMain.handle('app:open-external',async(_event,url)=>{try{const parsed=new URL(url);if(parsed.protocol!=='https:')return false;await shell.openExternal(parsed.toString());return true;}catch{return false;}});
ipcMain.handle('app:exit',()=>{ app.quit(); return true; });
app.whenReady().then(()=>{
  if(process.platform==='win32' && app.isPackaged){
    try{ app.setAsDefaultProtocolClient(AUTH_PROTOCOL); }catch{}
  }
  const startupAuthUrl = process.argv.find(value => typeof value === 'string' && value.toLowerCase().startsWith(AUTH_PROTOCOL + '://'));
  if(startupAuthUrl) emitAuthCallback(startupAuthUrl);
  session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(permission==='camera'&&isAllowedNavigation(webContents.getURL())));
  setupAutoUpdater(); createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
