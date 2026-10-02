import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthGate } from './auth/AuthGate'
import { captureLink } from './nav/link'

// Before anything renders, so the link is out of the address bar even on the sign-in screen.
captureLink()

// Ask the browser not to evict the local copy of the data, so the next visit doesn't start with a full pull.
void navigator.storage?.persist?.().catch(() => undefined)

// Caches the app itself so it opens with no connection (sw/sw.js). Only built: the dev server has no /sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
