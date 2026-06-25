'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /callback
 * Handles the redirect from Deriv OAuth.
 *
 * Deriv sends tokens DIRECTLY in the URL — not a code:
 *   ?token1=TOKEN&acct1=LOGINID&cur1=USD
 *   [&token2=TOKEN&acct2=LOGINID&cur2=USD]   ← second account if user has real + demo
 *
 * This page collects all token/acct/cur groups (up to 10),
 * sends them to /api/auth/token to be saved in the iron-session cookie,
 * then redirects to the dashboard.
 */
export default function CallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    // Collect every token/account group Deriv returned
    const accounts: Array<{ token: string; loginid: string; currency: string }> = []
    for (let i = 1; i <= 10; i++) {
      const token    = params.get(`token${i}`)
      const loginid  = params.get(`acct${i}`)
      const currency = params.get(`cur${i}`)
      if (!token || !loginid) break
      accounts.push({ token, loginid, currency: currency ?? 'USD' })
    }

    if (accounts.length === 0) {
      // Might be an error redirect from Deriv (e.g. user cancelled)
      const error = params.get('error') ?? 'no_tokens_received'
      router.replace('/?auth_error=' + encodeURIComponent(error))
      return
    }

    // Hand off to the server-side route — it saves the tokens to the encrypted cookie
    fetch('/api/auth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accounts }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) router.replace('/dashboard')
        else router.replace('/?auth_error=' + encodeURIComponent(data.error ?? 'unknown'))
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
