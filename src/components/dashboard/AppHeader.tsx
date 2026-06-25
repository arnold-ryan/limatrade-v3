'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface BalanceData {
  balance: number
  currency: string
  loginid: string
  accountType: string
}

// Simple flag emoji by currency
function CurrencyFlag({ currency }: { currency: string }) {
  const flags: Record<string, string> = {
    USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', AUD: '🇦🇺',
    BTC: '₿',   ETH: 'Ξ',
  }
  const flag = flags[currency] ?? '🌐'
  return (
    <span
      style={{
        width: '28px', height: '28px',
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.85rem', flexShrink: 0,
      }}
    >
      {flag}
    </span>
  )
}

export default function AppHeader() {
  const router  = useRouter()
  const dropRef = useRef<HTMLDivElement>(null)

  const [data,     setData]     = useState<BalanceData | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [spinning, setSpinning] = useState(false)
  const [open,     setOpen]     = useState(false)
  // Which panel is shown inside the dropdown
  const [tab, setTab] = useState<'real' | 'demo'>('real')

  const fetchBalance = useCallback(async (showSpin = false) => {
    if (showSpin) setSpinning(true)
    try {
      const res = await fetch('/api/user/balance', { cache: 'no-store' })
      if (res.ok) {
        const d = await res.json()
        setData(d)
        // auto-select correct tab
        const isDemo = d.accountType === 'demo' || d.loginid?.startsWith('VRTC')
        setTab(isDemo ? 'demo' : 'real')
      }
    } finally {
      setLoading(false)
      if (showSpin) setTimeout(() => setSpinning(false), 600)
    }
  }, [])

  useEffect(() => { fetchBalance() }, [fetchBalance])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleLogout = async () => {
    setOpen(false)
    await fetch('/api/auth/logout')
    router.push('/')
  }

  const isDemo = data?.accountType === 'demo' || data?.loginid?.startsWith('VRTC')

  return (
    <header
      style={{
        height: '56px',
        background: '#000',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 1.25rem',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        flexShrink: 0,
      }}
    >
      {/* ── Left: Logo + Reports ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.75rem' }}>
        <Link href="/dashboard" style={{ textDecoration: 'none' }}>
          <span style={{ fontWeight: 800, fontSize: '1.15rem', color: 'var(--gold)', letterSpacing: '-0.02em' }}>
            Lima<span style={{ color: '#fff' }}>Trade</span>
          </span>
        </Link>

        <Link
          href="/dashboard/reports"
          style={{ fontSize: '0.8rem', fontWeight: 500, color: 'rgba(229,229,229,0.5)', textDecoration: 'none', transition: 'color 0.15s' }}
          onMouseOver={e => (e.currentTarget.style.color = '#fff')}
          onMouseOut={e  => (e.currentTarget.style.color = 'rgba(229,229,229,0.5)')}
        >
          Reports
        </Link>
      </div>

      {/* ── Right: refresh + account trigger ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>

        {/* Refresh */}
        <button
          onClick={() => fetchBalance(true)}
          title="Refresh balance"
          style={{
            width: '32px', height: '32px',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'rgba(229,229,229,0.4)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--gold)'; e.currentTarget.style.color = 'var(--gold)' }}
          onMouseOut={e  => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'rgba(229,229,229,0.4)' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            style={{ animation: spinning ? 'spin 0.6s linear' : 'none' }}>
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
          </svg>
        </button>

        {/* Account trigger button */}
        <div ref={dropRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.55rem',
              padding: '0.3rem 0.7rem',
              borderRadius: '10px',
              border: '1px solid var(--border)',
              background: '#0a0a0a',
              cursor: 'pointer',
              transition: 'border-color 0.15s',
            }}
            onMouseOver={e => (e.currentTarget.style.borderColor = 'rgba(252,163,17,0.4)')}
            onMouseOut={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            {/* Flag */}
            <CurrencyFlag currency={data?.currency ?? 'USD'} />

            {/* Balance amount */}
            {loading ? (
              <span className="skeleton-pulse" style={{ display: 'inline-block', width: '68px', height: '13px', background: '#1a1a1a', borderRadius: '4px' }} />
            ) : (
              <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {data?.balance?.toFixed(2) ?? '0.00'}&nbsp;{data?.currency ?? 'USD'}
              </span>
            )}

            {/* Chevron */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(229,229,229,0.4)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {/* ── Dropdown panel ── */}
          {open && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                right: 0,
                width: '260px',
                background: '#0d0d0d',
                border: '1px solid var(--border)',
                borderRadius: '14px',
                overflow: 'hidden',
                boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
                zIndex: 200,
              }}
            >
              {/* Real / Demo tab switcher */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {(['real', 'demo'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    style={{
                      padding: '0.7rem',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                      color:        tab === t ? '#fff' : 'rgba(229,229,229,0.4)',
                      borderBottom: tab === t ? '2px solid var(--gold)' : '2px solid transparent',
                      transition: 'color 0.15s',
                    }}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>

              {/* Section label */}
              <div
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.7rem 1rem 0.5rem',
                }}
              >
                <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Deriv account
                </span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(229,229,229,0.3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15"/>
                </svg>
              </div>

              {/* Account row */}
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.6rem 1rem 0.9rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <CurrencyFlag currency={data?.currency ?? 'USD'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#fff' }}>
                    {tab === 'demo' ? 'Demo' : data?.currency ?? 'USD'}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.4)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {data?.loginid ?? '—'}
                  </div>
                </div>
                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {tab === (isDemo ? 'demo' : 'real')
                    ? `${data?.balance?.toFixed(2) ?? '0.00'} ${data?.currency ?? 'USD'}`
                    : `0.00 ${data?.currency ?? 'USD'}`}
                </span>
              </div>

              {/* CFD / Trader's Hub link */}
              <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                <a
                  href="https://app.deriv.com/traders-hub"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.78rem', color: 'var(--gold)', textDecoration: 'none', transition: 'opacity 0.15s' }}
                  onMouseOver={e => (e.currentTarget.style.opacity = '0.75')}
                  onMouseOut={e  => (e.currentTarget.style.opacity = '1')}
                >
                  Looking for CFD accounts? Go to Trader&apos;s Hub
                </a>
              </div>

              {/* Logout */}
              <button
                onClick={handleLogout}
                style={{
                  width: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.75rem 1rem',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  fontWeight: 500,
                  color: 'rgba(229,229,229,0.6)',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseOver={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.07)'; e.currentTarget.style.color = '#ef4444' }}
                onMouseOut={e  => { e.currentTarget.style.background = 'transparent';            e.currentTarget.style.color = 'rgba(229,229,229,0.6)' }}
              >
                <span>Logout</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
