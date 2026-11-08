import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { api } from './lib/api'

// External requests are stopped by the CSP before Electron sees them; report each one to the network log.
document.addEventListener('securitypolicyviolation', e => {
  if (/^(https?|wss?):/.test(e.blockedURI)) void api.invoke('network:csp-violation', e.blockedURI, e.effectiveDirective)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
