import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './lib/offline'
import { startSyncManager } from './lib/syncManager'
import { restoreCloudSession } from './lib/supabase'

function AppBootstrap() {
  useEffect(() => {
    void restoreCloudSession()
    void registerServiceWorker()
    return startSyncManager()
  }, [])

  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>,
)
