'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /callback
 * Handles the redirect from Deriv OAuth (new API).
 *
 * New Deriv API sends an AUTHORIZATION CODE (not tokens directly):
 *   ?code=AUTH_CODE&state=RANDOM_STATE
 *
 * We hand the code + state to the server-side /api/auth/token route,
 * which exchanges it for a Bearer token and fetches the user's accounts.
 */
export default function CallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code   = params.get('code')
    const state  = params.get('state')
    const error  = params.get('error')

    // Deriv sent an error (e.g. user cancelled)
    if (error) {
      router.replace('/?auth_error=' + encodeURIComponent(error))
      return
    }

    if (!code) {
      router.replace('/?auth_error=no_code_received')
      return
    }

    // Exchange the auth code for a Bearer token (server-side)
    fetch('/api/auth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, state }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          try { sessionStorage.removeItem('lima-auth-retry') } catch { /**/ }
          router.replace('/dashboard')
        } else if (data.error === 'invalid_session' || data.error === 'missing_state') {
          // State is stale or missing (browser back-button, expired TTL, etc.)
          // Retry once automatically — but if it fails again, this is a real,
          // persistent problem (not a one-off timing glitch), and silently
          // retrying forever would just bounce the user between us and Deriv
          // with no visible error and no way out.
          let retries = 0
          try { retries = Number(sessionStorage.getItem('lima-auth-retry') ?? '0') } catch { /**/ }
          if (retries < 1) {
            try { sessionStorage.setItem('lima-auth-retry', String(retries + 1)) } catch { /**/ }
            window.location.href = '/api/auth/login'
          } else {
            try { sessionStorage.removeItem('lima-auth-retry') } catch { /**/ }
            router.replace('/?auth_error=' + encodeURIComponent(data.error))
          }
        } else {
          try { sessionStorage.removeItem('lima-auth-retry') } catch { /**/ }
          router.replace('/?auth_error=' + encodeURIComponent(data.error ?? 'unknown'))
        }
      })
      .catch(() => router.replace('/?auth_error=network'))
  }, [router])

  return (
    <div style={{
      minHeight: '100vh', background: '#000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: '40px', height: '40px',
          border: '3px solid rgba(252,163,17,0.3)', borderTopColor: '#FCA311',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          margin: '0 auto 1.5rem',
        }} />
        <p style={{ color: '#E5E5E5', fontSize: '1rem' }}>Logging you in…</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
