'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * AppHeader — sticky top bar with real-time balance + account switcher
 *
 * Balance API (/api/user/balance) returns:
 *   { balance, currency, loginid, accountType, accounts: AccountRow[] }
 *
 * AccountRow: { loginid, balance, currency, isDemo, type }
 *
 * Account switching uses /api/auth/switch:
 *   POST { loginid } → { ok, loginid, currency }
 *   Then we re-fetch balance to update the header.
 *
 * Real accounts  → loginid starts with "CR"
 * Demo accounts  → loginid starts with "VRTC"
 */

interface AccountRow {
  loginid:  string
  balance:  number
  currency: string
  isDemo:   boolean
  type:     string
}

interface BalanceData {
  balance:     number
  currency:    string
  loginid:     string
  accountType: string       // "real" | "demo"
  accounts:    AccountRow[]
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
        // Mirror the active tab to whatever account is currently active
        setTab(d.accountType === 'demo' || d.loginid?.startsWith('VRTC') ? 'demo' : 'real')
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

  /* ── Switch account (real ↔ demo) ── */
  async function switchAccount(targetLoginid: string) {
    if (switching) return
    setSwitching(true)
    try {
      const res = await fetch('/api/auth/switch', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ loginid: targetLoginid }),
      })
      if (res.ok) {
        // Refresh balance to reflect the new active account
        await fetchBalance()
      }
    } finally {
      setSwitching(false)
    }
  }

  /* ── When user clicks a tab, switch to that account type ── */
  async function handleTabClick(t: 'real' | 'demo') {
    setTab(t)
    if (!data) return

    const target = data.accounts.find(a => a.isDemo === (t === 'demo'))
    if (!target) return
    if (target.loginid === data.loginid) return  // already active

    await switchAccount(target.loginid)
  }

  const handleLogout = async () => {
    setOpen(false)
    await fetch('/api/auth/logout')
    router.push('/')
  }

  // Derive displayed balance from accounts array for each tab
  const realAccount = data?.accounts?.find(a => !a.isDemo)
  const demoAccount = data?.accounts?.find(a => a.isDemo)
  const activeAccount = tab === 'real' ? realAccount : demoAccount
  const headerBalance  = data?.balance ?? 0
  const headerCurrency = data?.currency ?? 'USD'

  return (
    <header style={{
      height: '56px',
      background: '#000',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 1.25rem',
      position: 'sticky', top: 0, zIndex: 50, flexShrink: 0,
    }}>

      {/* ── Left: Logo ── */}
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

      {/* ── Right: Refresh + Account dropdown ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>

        {/* Refresh */}
        <button
          onClick={() => fetchBalance(true)}
          title="Refresh balance"
          style={{
            width: '32px', height: '32px', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'rgba(229,229,229,0.4)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--gold)'; e.currentTarget.style.color = 'var(--gold)' }}
          onMouseOut={e  => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'rgba(229,229,229,0.4)' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ animation: spinning ? 'spin 0.6s linear' : 'none' }}>
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
          </svg>
        </button>

        {/* Account trigger */}
        <div ref={dropRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.55rem',
              padding: '0.3rem 0.7rem', borderRadius: '10px',
              border: '1px solid var(--border)', background: '#0a0a0a',
              cursor: 'pointer', transition: 'border-color 0.15s',
            }}
            onMouseOver={e => (e.currentTarget.style.borderColor = 'rgba(252,163,17,0.4)')}
            onMouseOut={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <CurrencyFlag currency={headerCurrency} />

            {loading ? (
              <span style={{ display: 'inline-block', width: '68px', height: '13px', background: '#1a1a1a', borderRadius: '4px' }} />
            ) : (
              <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {headerBalance.toFixed(2)}&nbsp;{headerCurrency}
              </span>
            )}

            {/* Demo badge */}
            {!loading && (data?.accountType === 'demo' || data?.loginid?.startsWith('VRTC')) && (
              <span style={{
                fontSize: '0.6rem', fontWeight: 700, color: 'var(--gold)',
                background: 'rgba(252,163,17,0.12)', border: '1px solid rgba(252,163,17,0.25)',
                padding: '1px 5px', borderRadius: '4px',
              }}>
                DEMO
              </span>
            )}

            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(229,229,229,0.4)"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {/* ── Dropdown ── */}
          {open && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '270px',
              background: '#0d0d0d', border: '1px solid var(--border)',
              borderRadius: '14px', overflow: 'hidden',
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)', zIndex: 200,
            }}>

              {/* Real / Demo tabs — clicking actually switches accounts */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--border)' }}>
                {(['real', 'demo'] as const).map(t => {
                  const acct = t === 'real' ? realAccount : demoAccount
                  const isActive = tab === t
                  const isCurrentSession = data?.loginid && (
                    t === 'demo' ? data.loginid.startsWith('VRTC') : !data.loginid.startsWith('VRTC')
                  )
                  return (
                    <button
                      key={t}
                      onClick={() => handleTabClick(t)}
                      disabled={switching || !acct}
                      style={{
                        padding: '0.7rem 0.5rem',
                        fontSize: '0.8rem', fontWeight: 600,
                        background: 'transparent', border: 'none', cursor: acct ? 'pointer' : 'not-allowed',
                        color:        isActive ? '#fff' : 'rgba(229,229,229,0.4)',
                        borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
                        transition: 'color 0.15s',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                      }}
                    >
                      <span>{t === 'real' ? 'Real' : 'Demo'}</span>
                      {acct && (
                        <span style={{
                          fontSize: '0.62rem', fontWeight: 500,
                          color: isActive ? 'var(--gold)' : 'rgba(229,229,229,0.25)',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {acct.balance.toFixed(2)} {acct.currency}
                        </span>
                      )}
                      {isCurrentSession && (
                        <span style={{
                          width: '4px', height: '4px', borderRadius: '50%',
                          background: '#22c55e', display: 'inline-block',
                        }}/>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Active account detail */}
              {activeAccount && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  borderBottom: '1px solid var(--border)',
                  background: 'rgba(252,163,17,0.03)',
                }}>
                  <CurrencyFlag currency={activeAccount.currency} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#fff' }}>
                      {activeAccount.currency} {tab === 'demo' ? '(Demo)' : '(Real)'}
                    </div>
                    <div style={{
                      fontSize: '0.7rem', color: 'rgba(229,229,229,0.4)',
                      marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {activeAccount.loginid}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                      {activeAccount.balance.toFixed(2)}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)' }}>
                      {activeAccount.currency}
                    </div>
                  </div>
                </div>
              )}

              {/* Switching spinner */}
              {switching && (
                <div style={{
                  padding: '0.6rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--gold)" strokeWidth="2"
                    style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }}>
                    <circle cx="7" cy="7" r="5" strokeDasharray="25" strokeDashoffset="8"/>
                  </svg>
                  <span style={{ fontSize: '0.75rem', color: 'rgba(229,229,229,0.4)' }}>Switching account…</span>
                </div>
              )}

              {/* Trader's Hub link */}
              <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                <a
                  href="https://app.deriv.com/traders-hub"
                  target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: '0.78rem', color: 'var(--gold)', textDecoration: 'none', transition: 'opacity 0.15s' }}
                  onMouseOver={e => (e.currentTarget.style.opacity = '0.75')}
                  onMouseOut={e  => (e.currentTarget.style.opacity = '1')}
                >
                  CFD accounts? Go to Trader&apos;s Hub ↗
                </a>
              </div>

              {/* Logout */}
              <button
                onClick={handleLogout}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.75rem 1rem', background: 'transparent', border: 'none', cursor: 'pointer',
                  fontSize: '0.82rem', fontWeight: 500, color: 'rgba(229,229,229,0.6)',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseOver={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.07)'; e.currentTarget.style.color = '#ef4444' }}
                onMouseOut={e  => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(229,229,229,0.6)' }}
              >
                <span>Logout</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </header>
  )
}
