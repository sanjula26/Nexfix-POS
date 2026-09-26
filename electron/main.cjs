const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;
const DEV_URL = process.env.NEXFIX_DEV_URL || 'http://localhost:5173/';
let autoUpdater = null;
let pendingUpdateInfo = null;
let updateDownloadActive = false;
let updateInstallScheduled = false;

function getMainWindow(){ return BrowserWindow.getAllWindows()[0] || null; }
function sendUpdateEvent(type,payload={}){ const win=getMainWindow(); if(win&&!win.isDestroyed()) win.webContents.send('update:event',{type,...payload}); }

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
    ipcMain.handle('update:status',()=>({supported:true,available:Boolean(pendingUpdateInfo),version:pendingUpdateInfo?.version||null,downloading:updateDownloadActive}));
    ipcMain.handle('update:check',async()=>{
      if(!app.isPackaged||!autoUpdater)return{supported:false,available:false};
      try{const result=await autoUpdater.checkForUpdates();return{supported:true,available:Boolean(result?.isUpdateAvailable),version:result?.updateInfo?.version||null};}
      catch(error){sendUpdateEvent('error',{message:error?.message||String(error)});return{supported:true,available:false,error:error?.message||String(error)};}
    });
    ipcMain.handle('update:downloadAndInstall',async()=>{
      if(!app.isPackaged||!autoUpdater)return{supported:false,started:false};
      if(updateDownloadActive||updateInstallScheduled)return{supported:true,started:false};
      try{
        if(!pendingUpdateInfo){const result=await autoUpdater.checkForUpdates();if(!result?.isUpdateAvailable)return{supported:true,started:false};pendingUpdateInfo=result.updateInfo;}
        updateDownloadActive=true;sendUpdateEvent('progress',{percent:0});await autoUpdater.downloadUpdate();return{supported:true,started:true};
      }catch(error){updateDownloadActive=false;sendUpdateEvent('error',{message:error?.message||String(error)});return{supported:true,started:false,error:error?.message||String(error)};}
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
app.whenReady().then(()=>{
  session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(permission==='camera'&&isAllowedNavigation(webContents.getURL())));
  setupAutoUpdater(); createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
