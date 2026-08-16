import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startSyncManager } from './lib/syncManager'

function AppBootstrap() {
  useEffect(() => startSyncManager(), [])
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>,
)
