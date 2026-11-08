import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { productError } from './lib/core'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {productError ? <main className="product-error" role="alert"><h1>Configuration unavailable</h1><p>{productError}</p><p>The site operator should check krab-profile.json.</p></main> : <App />}
  </StrictMode>,
)
