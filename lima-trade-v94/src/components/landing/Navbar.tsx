'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

export default function Navbar() {
  const [authUrl, setAuthUrl] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/auth/preauth')
      .then(r => r.json())
      .then(d => { if (d.url) setAuthUrl(d.url) })
      .catch(() => {})
  }, [])

  const href = authUrl ?? '/api/auth/login'

  return (
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--border)' }}>

      {/* Logo */}
      <Link href="/" className="text-2xl font-black tracking-tight no-underline">
        <span style={{ color: 'var(--gold)' }}>Lima</span>
        <span className="text-white"> Trade</span>
      </Link>

      {/* Auth buttons */}
      <div className="flex items-center gap-3">
        <a href={href}
          className="px-5 py-2 rounded-full text-sm font-semibold text-white border transition-colors"
          style={{ borderColor: 'rgba(255,255,255,0.25)' }}
          onMouseOver={e => (e.currentTarget.style.borderColor = 'var(--gold)')}
          onMouseOut={e  => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)')}>
          Log in
        </a>
        <a href={href}
          className="flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold text-black btn-glow"
          style={{ background: 'var(--gold)' }}>
          Sign up
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
          </svg>
        </a>
      </div>
    </header>
  )
}
