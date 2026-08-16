import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './lib/offline'
import { startSyncManager } from './lib/syncManager'

function AppBootstrap() {
  useEffect(() => {
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
