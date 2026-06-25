'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * AppHeader — sticky top bar with real-time balance + account switcher
 *
 * Balance API (/api/user/balance) returns:
 *   { accounts: AccountRow[], activeAccountId: string }
 *
 * AccountRow: { accountId, balance, currency, isDemo, type }
 *
 * Account switching uses POST /api/auth/switch:
 *   { accountId } → { ok, activeAccountId }
 */

interface AccountRow {
  accountId: string
  balance:   number
  currency:  string
  isDemo:    boolean
  type?:     string
}

interface BalanceData {
  accounts:        AccountRow[]
  activeAccountId: string
}

function CurrencyFlag({ currency }: { currency: string }) {
  const flags: Record<string, string> = {
    USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', AUD: '🇦🇺',
    BTC: '₿',   ETH: 'Ξ',
  }
  return (
    <span style={{
      width: '28px', height: '28px', borderRadius: '50%',
      background: 'rgba(255,255,255,0.08)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.85rem', flexShrink: 0,
    }}>
      {flags[currency] ?? '🌐'}
    </span>
  )
}

export default function AppHeader() {
  const router  = useRouter()
  const dropRef = useRef<HTMLDivElement>(null)

  const [data,       setData]       = useState<BalanceData | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [spinning,   setSpinning]   = useState(false)
  const [switching,  setSwitching]  = useState(false)
  const [open,       setOpen]       = useState(false)
  const [tab,        setTab]        = useState<'real' | 'demo'>('real')

  /* ── Fetch balance ── */
  const fetchBalance = useCallback(async (showSpin = false) => {
    if (showSpin) setSpinning(true)
    try {
      const res = await fetch('/api/user/balance', { cache: 'no-store' })
      if (res.ok) {
        const d: BalanceData = await res.json()
        setData(d)
        // Mirror the active tab to the active account type
        const active = d.accounts.find(a => a.accountId === d.activeAccountId)
        if (active) setTab(active.isDemo ? 'demo' : 'real')
      }
    } finally {
      setLoading(false)
      if (showSpin) setTimeout(() => setSpinning(false), 600)
    }
  }, [])

  useEffect(() => { fetchBalance() }, [fetchBalance])

  // Close dropdown on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  /* ── Switch account ── */
  async function switchAccount(targetId: string) {
    if (switching) return
    setSwitching(true)
    try {
      const res = await fetch('/api/auth/switch', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accountId: targetId }),
      })
      if (res.ok) await fetchBalance()
    } finally {
      setSwitching(false)
    }
  }

  async function handleTabClick(t: 'real' | 'demo') {
    setTab(t)
    if (!data) return
    const target = data.accounts.find(a => a.isDemo === (t === 'demo'))
    if (target && target.accountId !== data.activeAccountId) {
      await switchAccount(target.accountId)
    }
  }

  /* ── Active account details ── */
  const activeAccount = data?.accounts.find(a => a.accountId === data.activeAccountId)
    ?? data?.accounts[0]

  const realAccounts = data?.accounts.filter(a => !a.isDemo) ?? []
  const demoAccounts = data?.accounts.filter(a =>  a.isDemo) ?? []

  const displayedAccounts = tab === 'real' ? realAccounts : demoAccounts
  const displayBalance  = activeAccount?.balance ?? 0
  const displayCurrency = activeAccount?.currency ?? 'USD'
  const displayId       = activeAccount?.accountId ?? ''

  /* ── Logout ── */
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 200,
      background: 'rgba(7,17,30,0.95)', backdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      height: '56px',
      display: 'flex', alignItems: 'center',
      padding: '0 24px', gap: '12px',
      justifyContent: 'space-between',
    }}>

      {/* Left — Logo */}
      <Link href="/dashboard" style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        textDecoration: 'none',
      }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '8px',
          background: 'linear-gradient(135deg, #FCA311, #e8920a)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: '1rem', color: '#000',
        }}>L</div>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: '1.1rem', letterSpacing: '-0.3px' }}>
          Lima Trade
        </span>
      </Link>

      {/* Right — Balance + Account */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>

        {/* Balance display */}
        {loading ? (
          <div style={{
            width: '120px', height: '32px', borderRadius: '8px',
            background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.4s ease infinite',
          }} />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '10px', padding: '6px 12px',
          }}>
            {spinning ? (
              <div style={{
                width: '14px', height: '14px', borderRadius: '50%',
                border: '2px solid rgba(252,163,17,0.3)', borderTopColor: '#FCA311',
                animation: 'spin 0.6s linear infinite',
              }} />
            ) : (
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: activeAccount?.isDemo ? '#888' : '#22c55e',
              }} />
            )}
            <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>
              {displayCurrency} {displayBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {/* Account switcher dropdown */}
        <div ref={dropRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: open ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px', padding: '6px 12px',
              color: '#E5E5E5', fontSize: '0.85rem', cursor: 'pointer',
              transition: 'background 0.15s',
            }}
          >
            <CurrencyFlag currency={displayCurrency} />
            <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeAccount ? (activeAccount.isDemo ? 'Demo' : 'Real') : 'Account'}
            </span>
            <span style={{ color: '#888', fontSize: '0.75rem' }}>{open ? '▲' : '▼'}</span>
          </button>

          {open && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0,
              background: '#0d1f35', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px', minWidth: '280px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              overflow: 'hidden', zIndex: 100,
            }}>
              {/* Real / Demo tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {(['real', 'demo'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => handleTabClick(t)}
                    style={{
                      flex: 1, padding: '10px',
                      background: 'transparent', border: 'none',
                      color: tab === t ? '#fff' : '#888',
                      fontSize: '0.85rem', fontWeight: tab === t ? 600 : 400,
                      cursor: 'pointer', textTransform: 'capitalize',
                      borderBottom: tab === t ? '2px solid #FCA311' : '2px solid transparent',
                      transition: 'all 0.15s',
                    }}
                  >{t}</button>
                ))}
              </div>

              {/* Account list */}
              <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                {displayedAccounts.length === 0 ? (
                  <div style={{ padding: '16px', color: '#888', fontSize: '0.85rem', textAlign: 'center' }}>
                    No {tab} accounts
                  </div>
                ) : displayedAccounts.map(acc => {
                  const isActive = acc.accountId === data?.activeAccountId
                  return (
                    <button
                      key={acc.accountId}
                      onClick={async () => {
                        await switchAccount(acc.accountId)
                        setOpen(false)
                      }}
                      disabled={switching || isActive}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center',
                        gap: '12px', padding: '12px 16px',
                        background: isActive ? 'rgba(252,163,17,0.06)' : 'transparent',
                        border: 'none', cursor: isActive ? 'default' : 'pointer',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        transition: 'background 0.15s',
                      }}
                    >
                      <CurrencyFlag currency={acc.currency} />
                      <div style={{ flex: 1, textAlign: 'left' }}>
                        <div style={{ color: '#E5E5E5', fontSize: '0.85rem', fontWeight: 500 }}>
                          {acc.isDemo ? 'Demo Account' : 'Real Account'}
                        </div>
                        <div style={{ color: '#888', fontSize: '0.75rem' }}>
                          {acc.currency} {(acc.balance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                      </div>
                      {isActive && (
                        <div style={{
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: '#22c55e',
                        }} />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Footer actions */}
              <div style={{
                padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)',
                display: 'flex', justifyContent: 'flex-end',
              }}>
                <button
                  onClick={handleLogout}
                  style={{
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    color: '#ef4444', borderRadius: '8px',
                    padding: '6px 14px', fontSize: '0.8rem',
                    cursor: 'pointer', transition: 'background 0.15s',
                  }}
                >
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }
      `}</style>
    </header>
  )
}
