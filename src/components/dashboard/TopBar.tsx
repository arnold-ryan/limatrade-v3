'use client'

import { useEffect, useState, useCallback } from 'react'

interface AccountInfo {
  balance:     number
  currency:    string
  loginid:     string
  accountType: string
  error?:      string
}

export default function TopBar() {
  const [info,    setInfo]    = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [spinning, setSpinning] = useState(false)

  const fetchBalance = useCallback(async () => {
    setSpinning(true)
    try {
      const res = await fetch('/api/user/balance')
      if (res.ok) {
        const data = await res.json()
        setInfo(data)
      }
    } catch {
      // silently fail — balance just won't show
    } finally {
      setLoading(false)
      setSpinning(false)
    }
  }, [])

  useEffect(() => {
    fetchBalance()
    // Refresh balance every 30 seconds
    const id = setInterval(fetchBalance, 30_000)
    return () => clearInterval(id)
  }, [fetchBalance])

  const isDemo = !info?.accountType || info.accountType === 'demo'

  return (
    <header
      style={{
        height: '56px',
        display: 'flex',
        alignItems: 'center',
        padding: '0 1.5rem',
        borderBottom: '1px solid var(--border)',
        background: '#050505',
        flexShrink: 0,
        gap: '0.75rem',
      }}
    >
      {/* Account type badge */}
      <div
        style={{
          padding: '0.3rem 0.85rem',
          borderRadius: '9999px',
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          background: isDemo ? 'rgba(252,163,17,0.12)' : 'rgba(34,197,94,0.12)',
          color:      isDemo ? 'var(--gold)'           : 'var(--up)',
          border:     `1px solid ${isDemo ? 'rgba(252,163,17,0.25)' : 'rgba(34,197,94,0.25)'}`,
        }}
      >
        {isDemo ? 'DEMO' : 'REAL'}
      </div>

      {/* Account ID */}
      {info?.loginid && (
        <span
          style={{
            fontSize: '0.72rem',
            color: 'rgba(229,229,229,0.35)',
            fontFamily: 'monospace',
          }}
        >
          {info.loginid}
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Balance */}
      {loading ? (
        <div
          style={{
            width: '130px',
            height: '22px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.05)',
          }}
          className="skeleton-pulse"
        />
      ) : (
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: '1.1rem',
              fontWeight: 800,
              color: 'var(--gold)',
              letterSpacing: '-0.025em',
              lineHeight: 1.1,
            }}
          >
            {info
              ? `${info.currency} ${info.balance.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`
              : '—'}
          </div>
          <div
            style={{
              fontSize: '0.62rem',
              color: 'rgba(229,229,229,0.35)',
              marginTop: '1px',
            }}
          >
            Available Balance
          </div>
        </div>
      )}

      {/* Refresh */}
      <button
        onClick={fetchBalance}
        title="Refresh balance"
        style={{
          padding: '0.45rem',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'rgba(229,229,229,0.5)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'color 0.15s, border-color 0.15s',
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transition: 'transform 0.5s',
            transform: spinning ? 'rotate(360deg)' : 'rotate(0deg)',
          }}
        >
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
          <path d="M21 3v5h-5"/>
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
          <path d="M8 16H3v5"/>
        </svg>
      </button>

      {/* Deposit */}
      <a
        href="https://app.deriv.com/cashier/deposit"
        target="_blank"
        rel="noopener noreferrer"
        className="btn-glow"
        style={{
          padding: '0.45rem 1rem',
          borderRadius: '8px',
          background: 'var(--gold)',
          color: '#000',
          fontSize: '0.8rem',
          fontWeight: 700,
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        Deposit
      </a>
    </header>
  )
}
