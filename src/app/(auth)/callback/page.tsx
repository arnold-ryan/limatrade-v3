'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /callback
 * Handles the redirect from legacy Deriv OAuth (oauth.deriv.com).
 *
 * Legacy Deriv OAuth sends tokens directly in the redirect URL — no code exchange:
 *   ?acct1=CR799393&token1=a1-...&cur1=usd&acct2=VRTC...&token2=a1-...&cur2=usd
 *
 * We parse all acct/token/cur params and hand them to /api/auth/token to store in session.
 */
export default function CallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    // Deriv error param
    const error = params.get('error')
    if (error) {
      router.replace('/?auth_error=' + encodeURIComponent(error))
      return
    }

    // Parse acct1/token1/cur1, acct2/token2/cur2, ...
    const accounts: Array<{ accountId: string; token: string; currency: string; isDemo: boolean }> = []
    let i = 1
    while (params.get(`token${i}`)) {
      const acct = params.get(`acct${i}`) ?? ''
      const tok  = params.get(`token${i}`) ?? ''
      const cur  = params.get(`cur${i}`) ?? 'USD'
      if (tok) {
        accounts.push({
          accountId: acct,
          token:     tok,
          currency:  cur.toUpperCase(),
          isDemo:    acct.toUpperCase().startsWith('VRT') || acct.toUpperCase().startsWith('DEMO'),
        })
      }
      i++
    }

    if (accounts.length === 0) {
      router.replace('/?auth_error=no_accounts_received')
      return
    }

    fetch('/api/auth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accounts }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          router.replace('/dashboard')
        } else {
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
