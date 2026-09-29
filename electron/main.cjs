const { app, BrowserWindow, session, ipcMain, clipboard, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = !app.isPackaged;
const DEV_URL = process.env.NEXFIX_DEV_URL || 'http://localhost:5173/';
let autoUpdater = null;
let pendingUpdateInfo = null;
let updateDownloadActive = false;
let updateInstallScheduled = false;
let updateAuthToken = '';
let updateDeviceId = '';
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

function configureUpdaterCredentials(){
  if (!autoUpdater) return false;
  const authorized = Boolean(updateAuthToken && updateDeviceId);

  // electron-updater reads requestHeaders from the updater instance. Passing
  // requestHeaders only to setFeedURL() does not reliably carry them into
  // manifest/download requests on installed clients.
  autoUpdater.requestHeaders = authorized ? {
    Authorization: `Bearer ${updateAuthToken}`,
    'X-Nexfix-Device': updateDeviceId,
    'Cache-Control': 'no-cache',
  } : null;

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${UPDATE_FEED_URL}/`,
    useMultipleRangeRequest: false,
    timeout: 10 * 60 * 1000,
    publishAutoUpdate: false,
  });
  return authorized;
}

function setupAutoUpdater(){
  if(!app.isPackaged || process.platform!=='win32') return;
  try{
    ({autoUpdater}=require('electron-updater'));
    // Always point the updater at the private Supabase gateway. Never fall back
    // to the build-time GitHub provider before a signed-in session supplies
    // authorization headers.
    configureUpdaterCredentials();
    autoUpdater.autoDownload=false;
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
      // Supabase access tokens are JWT/opaque credentials; never assume a minimum length.
      updateAuthToken=token && token.length<=16384?token:'';
      updateDeviceId=deviceId.length>=1&&deviceId.length<=200?deviceId:'';
      pendingUpdateInfo=null;
      const ok=configureUpdaterCredentials();
      if(ok) setTimeout(()=>{ void autoUpdater.checkForUpdates().catch(()=>{}); },250);
      return {ok};
    });
    ipcMain.handle('update:clear-credentials',()=>{ updateAuthToken=''; updateDeviceId=''; pendingUpdateInfo=null; updateDownloadActive=false; updateInstallScheduled=false; return {ok:true}; });
    ipcMain.handle('update:status',()=>({supported:true,authorized:Boolean(updateAuthToken&&updateDeviceId),available:Boolean(pendingUpdateInfo),version:pendingUpdateInfo?.version||null,downloading:updateDownloadActive}));
    ipcMain.handle('update:check',async()=>{
      if(!app.isPackaged||!autoUpdater)return{supported:false,available:false};
      if(!configureUpdaterCredentials())return{supported:true,available:false,error:'Update authorization is not ready.'};
      try{const result=await autoUpdater.checkForUpdates();return{supported:true,available:Boolean(result?.isUpdateAvailable),version:result?.updateInfo?.version||null};}
      catch(error){sendUpdateEvent('error',{message:error?.message||String(error)});return{supported:true,available:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('update:downloadAndInstall',async()=>{
      if(!app.isPackaged||process.platform!=='win32')return{supported:false,started:false};
      if(!configureUpdaterCredentials())return{supported:true,started:false,error:'Update authorization is not ready.'};
      if(updateDownloadActive||updateInstallScheduled)return{supported:true,started:false};
      try{
        if(!pendingUpdateInfo){
          const result=await autoUpdater.checkForUpdates();
          if(!result?.isUpdateAvailable)return{supported:true,started:false};
          pendingUpdateInfo=result.updateInfo;
        }
        updateDownloadActive=true;
        sendUpdateEvent('progress',{percent:0});
        // Download into electron-updater's private cache, then the
        // update-downloaded handler performs the silent NSIS install/restart.
        await autoUpdater.downloadUpdate();
        return{supported:true,started:true};
      }catch(error){
        updateDownloadActive=false;
        updateInstallScheduled=false;
        sendUpdateEvent('error',{message:error?.message||String(error)});
        return{supported:true,started:false,error:error?.message||String(error)};
      }
    });

    const checkNow=()=>{
      if(!configureUpdaterCredentials()) return;
      void autoUpdater.checkForUpdates().catch(()=>{});
    };
    setTimeout(checkNow,5000);
    setInterval(checkNow,10*60*1000);
    app.on('browser-window-focus',checkNow);
  }catch(error){console.warn('[Nexfix updater] unavailable:',error?.message||error);}
}

function isAllowedNavigation(url){try{const parsed=new URL(url);if(isDev)return parsed.origin===new URL(DEV_URL).origin;return parsed.protocol==='file:';}catch{return false;}}
function createWindow(){
  const win=new BrowserWindow({width:1440,height:900,minWidth:1100,minHeight:700,backgroundColor:'#f5f6fb',icon:path.join(__dirname,'..','build','icon.ico'),show:false,frame:false,fullscreen:true,kiosk:true,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(({url})=>isAllowedNavigation(url)?{action:'allow'}:{action:'deny'});
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
