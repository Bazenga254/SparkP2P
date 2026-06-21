import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initDeepLinks } from './mobile/deepLink'
import { resumePendingGoogleLogin } from './mobile/oauth'

// Native app: listen for the OAuth deep link (best-effort), and — the reliable path — resume any
// Google login that was in flight when the browser tore this page down / on refresh.
initDeepLinks()
resumePendingGoogleLogin()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
