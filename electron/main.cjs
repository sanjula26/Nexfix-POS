const { app, BrowserWindow, session, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const isDev = !app.isPackaged;
const DEV_URL = process.env.NEXFIX_DEV_URL || 'http://localhost:5173/';
let autoUpdater = null;
let pendingUpdateInfo = null;
let updateDownloadActive = false;
let updateInstallScheduled = false;
let updateAuthToken = '';
let updateDeviceId = '';
const UPDATE_FEED_URL = 'https://ocmzgamnehwbkuwkjdrr.supabase.co/functions/v1/desktop-updates';

function getMainWindow(){ return BrowserWindow.getAllWindows()[0] || null; }
function sendUpdateEvent(type,payload={}){ const win=getMainWindow(); if(win&&!win.isDestroyed()) win.webContents.send('update:event',{type,...payload}); }

function configureUpdaterCredentials(){
  if (!autoUpdater || !updateAuthToken || !updateDeviceId) return false;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${UPDATE_FEED_URL}/`,
    requestHeaders: {
      Authorization: `Bearer ${updateAuthToken}`,
      'X-Nexfix-Device': updateDeviceId,
    },
    useMultipleRangeRequest: false,
    timeout: 10 * 60 * 1000,
    publishAutoUpdate: false,
  });
  return true;
}

function setupAutoUpdater(){
  if(!app.isPackaged || process.platform!=='win32') return;
  try{
    ({autoUpdater}=require('electron-updater'));
    autoUpdater.autoDownload=false;
    autoUpdater.autoInstallOnAppQuit=false;
    autoUpdater.on('checking-for-update',()=>sendUpdateEvent('checking'));
    autoUpdater.on('update-available',info=>{pendingUpdateInfo=info;sendUpdateEvent('available',{version:info.version});});
    autoUpdater.on('update-not-available',info=>{pendingUpdateInfo=null;sendUpdateEvent('not-available',{version:info?.version||app.getVersion()});});
    autoUpdater.on('download-progress',info=>sendUpdateEvent('progress',{percent:Number(info.percent||0)}));
    autoUpdater.on('update-downloaded',info=>{
      pendingUpdateInfo=info; updateDownloadActive=false;
      sendUpdateEvent('downloaded',{version:info?.version||''});
      if(!updateInstallScheduled){updateInstallScheduled=true;setTimeout(()=>{try{autoUpdater.quitAndInstall(false,true);}catch(error){updateInstallScheduled=false;sendUpdateEvent('error',{message:error?.message||String(error)});}},600);}
    });
    autoUpdater.on('error',error=>{updateDownloadActive=false;updateInstallScheduled=false;sendUpdateEvent('error',{message:error?.message||String(error)});});
    ipcMain.handle('update:set-credentials',(_event,payload)=>{
      const token=typeof payload?.token==='string'?payload.token.trim():'';
      const deviceId=typeof payload?.deviceId==='string'?payload.deviceId.trim():'';
      updateAuthToken=token.length>=100?token:'';
      updateDeviceId=deviceId.length>=1&&deviceId.length<=200?deviceId:'';
      pendingUpdateInfo=null;
      return {ok:configureUpdaterCredentials()};
    });
    ipcMain.handle('update:status',()=>({supported:true,authorized:Boolean(updateAuthToken&&updateDeviceId),available:Boolean(pendingUpdateInfo),version:pendingUpdateInfo?.version||null,downloading:updateDownloadActive}));
    ipcMain.handle('update:check',async()=>{
      if(!app.isPackaged||!autoUpdater)return{supported:false,available:false};
      if(!configureUpdaterCredentials())return{supported:true,available:false,error:'Update authorization is not ready.'};
      try{const result=await autoUpdater.checkForUpdates();return{supported:true,available:Boolean(result?.isUpdateAvailable),version:result?.updateInfo?.version||null};}
      catch(error){sendUpdateEvent('error',{message:error?.message||String(error)});return{supported:true,available:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('update:downloadAndInstall',async()=>{
      if(!app.isPackaged||!autoUpdater)return{supported:false,started:false};
      if(!configureUpdaterCredentials())return{supported:true,started:false,error:'Update authorization is not ready.'};
      if(updateDownloadActive||updateInstallScheduled)return{supported:true,started:false};
      try{
        if(!pendingUpdateInfo){const result=await autoUpdater.checkForUpdates();if(!result?.isUpdateAvailable)return{supported:true,started:false};pendingUpdateInfo=result.updateInfo;}
        updateDownloadActive=true;sendUpdateEvent('progress',{percent:0});await autoUpdater.downloadUpdate();return{supported:true,started:true};
      }catch(error){updateDownloadActive=false;sendUpdateEvent('error',{message:error?.message||String(error)});return{supported:true,started:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('update:downloadAuthorizedInstaller',async()=>{
      if(!app.isPackaged||process.platform!=='win32')return{supported:false,ok:false,error:'Authorized installer downloads are available in the installed Windows POS only.'};
      if(!updateAuthToken||!updateDeviceId)return{supported:true,ok:false,error:'Update authorization is not ready. Please sign in to the POS first.'};
      let targetPath='';
      try{
        const authHeaders={Authorization:`Bearer ${updateAuthToken}`,'X-Nexfix-Device':updateDeviceId,Accept:'application/json'};
        const authorizeResponse=await fetch(`${UPDATE_FEED_URL}?download=1`,{headers:authHeaders});
        const data=await authorizeResponse.json().catch(()=>null);
        if(!authorizeResponse.ok||!data?.ok||typeof data.url!=='string')return{supported:true,ok:false,error:data?.error||'Installer download was not authorized.'};
        const streamResponse=await fetch(data.url,{headers:{Authorization:`Bearer ${updateAuthToken}`,'X-Nexfix-Device':updateDeviceId}});
        if(!streamResponse.ok||!streamResponse.body)return{supported:true,ok:false,error:'The authorized installer download could not be started.'};
        const safeName=path.basename(typeof data.name==='string'&&data.name?data.name:'Nexfix-POS-installer.exe').replace(/[<>:"/\\|?*]/g,'_');
        const downloadsDir=app.getPath('downloads');
        targetPath=path.join(downloadsDir,safeName);
        if(fs.existsSync(targetPath)){
          const ext=path.extname(safeName);
          const base=path.basename(safeName,ext);
          targetPath=path.join(downloadsDir,`${base}-${Date.now()}${ext}`);
        }
        const file=fs.createWriteStream(targetPath);
        await new Promise((resolve,reject)=>{
          file.on('finish',resolve);
          file.on('error',reject);
          Readable.fromWeb(streamResponse.body).on('error',reject).pipe(file);
        });
        shell.showItemInFolder(targetPath);
        return{supported:true,ok:true,path:targetPath,name:path.basename(targetPath),version:data.version||null};
      }catch(error){
        if(targetPath){try{fs.rmSync(targetPath,{force:true});}catch{}}
        return{supported:true,ok:false,error:error?.message||String(error)};
      }
    });
    const checkNow=()=>{void autoUpdater.checkForUpdates().catch(()=>{});};
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
  session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(permission==='camera'&&isAllowedNavigation(webContents.getURL())));
  setupAutoUpdater(); createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
