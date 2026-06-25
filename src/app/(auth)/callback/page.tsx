'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// This page handles the redirect back from Deriv after login/signup.
// It passes the code to our server to exchange for a token safely.
export default function CallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const params  = new URLSearchParams(window.location.search)
    const code    = params.get('code')
    const state   = params.get('state')
    const error   = params.get('error')

    if (error) {
      router.replace('/?auth_error=' + encodeURIComponent(error))
      return
    }

    if (!code || !state) {
      router.replace('/?auth_error=missing_params')
      return
    }

    // Send to our server-side API route — token exchange happens there, never in browser
    fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) router.replace('/dashboard')
        else router.replace('/?auth_error=' + encodeURIComponent(data.error ?? 'unknown'))
      })
      .catch(() => router.replace('/?auth_error=network'))
  }, [router])

  return (
    <div style={{ minHeight: '100vh', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: '40px', height: '40px', border: '3px solid rgba(252,163,17,0.3)', borderTopColor: '#FCA311', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 1.5rem' }} />
        <p style={{ color: '#E5E5E5', fontSize: '1rem' }}>Logging you in…</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
