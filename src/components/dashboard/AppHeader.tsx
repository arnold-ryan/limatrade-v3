'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface BalanceData {
  balance: number
  currency: string
  loginid: string
  accountType: string
}

export default function AppHeader() {
  const router = useRouter()
  const [data,       setData]       = useState<BalanceData | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [spinning,   setSpinning]   = useState(false)
  const [menuOpen,   setMenuOpen]   = useState(false)

  const fetchBalance = useCallback(async (showSpin = false) => {
    if (showSpin) setSpinning(true)
    try {
      const res = await fetch('/api/user/balance', { cache: 'no-store' })
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
      if (showSpin) setTimeout(() => setSpinning(false), 600)
    }
  }, [])

  useEffect(() => { fetchBalance() }, [fetchBalance])

  const handleLogout = async () => {
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
      {/* Left: Logo + Reports */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.75rem' }}>
        <Link href="/dashboard" style={{ textDecoration: 'none' }}>
          <span
            style={{
              fontWeight: 800,
              fontSize: '1.15rem',
              color: 'var(--gold)',
              letterSpacing: '-0.02em',
            }}
          >
            Lima<span style={{ color: '#fff' }}>Trade</span>
          </span>
        </Link>

        <Link
          href="/dashboard/reports"
          style={{
            fontSize: '0.8rem',
            fontWeight: 500,
            color: 'rgba(229,229,229,0.5)',
            textDecoration: 'none',
            transition: 'color 0.15s',
          }}
          onMouseOver={e => (e.currentTarget.style.color = '#fff')}
          onMouseOut={e  => (e.currentTarget.style.color = 'rgba(229,229,229,0.5)')}
        >
          Reports
        </Link>
      </div>

      {/* Right: Balance + account + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {/* Refresh button */}
        <button
          onClick={() => fetchBalance(true)}
          title="Refresh balance"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'rgba(229,229,229,0.45)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseOver={e => {
            e.currentTarget.style.borderColor = 'var(--gold)'
            e.currentTarget.style.color = 'var(--gold)'
          }}
          onMouseOut={e => {
            e.currentTarget.style.borderColor = 'var(--border)'
            e.currentTarget.style.color = 'rgba(229,229,229,0.45)'
          }}
        >
          <svg
            width="14" height="14"
            viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ animation: spinning ? 'spin 0.6s linear' : 'none' }}
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
          </svg>
        </button>

        {/* Balance + account dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              padding: '0.35rem 0.75rem',
              borderRadius: '10px',
              border: '1px solid var(--border)',
              background: '#0a0a0a',
              cursor: 'pointer',
              transition: 'border-color 0.15s',
            }}
            onMouseOver={e => (e.currentTarget.style.borderColor = 'rgba(252,163,17,0.4)')}
            onMouseOut={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            {/* Account type badge */}
            <span
              style={{
                fontSize: '0.62rem',
                fontWeight: 700,
                padding: '0.15rem 0.45rem',
                borderRadius: '5px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                background: isDemo ? 'rgba(252,163,17,0.15)' : 'rgba(34,197,94,0.15)',
                color:      isDemo ? 'var(--gold)'           : '#22c55e',
              }}
            >
              {isDemo ? 'Demo' : 'Real'}
            </span>

            {/* Balance */}
            {loading ? (
              <span
                className="skeleton-pulse"
                style={{
                  display: 'inline-block',
                  width: '72px', height: '14px',
                  background: '#1a1a1a', borderRadius: '4px',
                }}
              />
            ) : (
              <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                {data?.currency ?? 'USD'} {data?.balance?.toFixed(2) ?? '—'}
              </span>
            )}

            {/* Chevron */}
            <svg
              width="12" height="12"
              viewBox="0 0 24 24" fill="none"
              stroke="rgba(229,229,229,0.4)" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: menuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
            >
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {/* Dropdown */}
          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                right: 0,
                minWidth: '200px',
                background: '#0d0d0d',
                border: '1px solid var(--border)',
                borderRadius: '12px',
                overflow: 'hidden',
                boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
                zIndex: 100,
              }}
            >
              {/* Account info row */}
              <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.4)', marginBottom: '0.2rem' }}>
                  Account ID
                </div>
                <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#fff' }}>
                  {data?.loginid ?? '—'}
                </div>
              </div>

              {/* Deposit */}
              <a
                href="https://app.deriv.com/cashier/deposit"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block',
                  padding: '0.75rem 1rem',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: 'var(--gold)',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--border)',
                  transition: 'background 0.15s',
                }}
                onMouseOver={e => (e.currentTarget.style.background = 'rgba(252,163,17,0.06)')}
                onMouseOut={e  => (e.currentTarget.style.background = 'transparent')}
              >
                + Deposit Funds
              </a>

              {/* Logout */}
              <button
                onClick={handleLogout}
                style={{
                  width: '100%',
                  padding: '0.75rem 1rem',
                  textAlign: 'left',
                  fontSize: '0.82rem',
                  fontWeight: 500,
                  color: '#ef4444',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onMouseOver={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.06)')}
                onMouseOut={e  => (e.currentTarget.style.background = 'transparent')}
              >
                Log Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
