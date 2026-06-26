'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * AppHeader — sticky top bar with real-time balance + Deriv-style account switcher
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
      width: '32px', height: '32px', borderRadius: '50%',
      background: 'rgba(255,255,255,0.08)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '1rem', flexShrink: 0,
    }}>
      {flags[currency] ?? '🌐'}
    </span>
  )
}

/** Teal coin/D icon — matches Deriv account-switcher button */
function DerivCoinIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="12" fill="#00D2D3" />
      <path d="M8 7h4.5C14.985 7 17 9.015 17 12s-2.015 5-4.5 5H8V7z" fill="#fff" />
      <path d="M10 9.5v5h2.2c1.49 0 2.3-1.12 2.3-2.5S13.69 9.5 12.2 9.5H10z" fill="#00D2D3" />
    </svg>
  )
}

/** Arrow right icon for logout row */
function ArrowRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Chevron icon */
function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ transform: up ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function AppHeader() {
  const router  = useRouter()
  const dropRef = useRef<HTMLDivElement>(null)

  const [data,          setData]          = useState<BalanceData | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [spinning,      setSpinning]      = useState(false)
  const [switching,     setSwitching]     = useState(false)
  const [open,          setOpen]          = useState(false)
  const [tab,           setTab]           = useState<'real' | 'demo'>('real')
  const [accordionOpen, setAccordionOpen] = useState(true)

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

  // Real-time balance: listen for CustomEvents dispatched by bot WebSockets
  // (both speedbot and analysis subscribe to balance: 1 on their authenticated WS)
  useEffect(() => {
    const handler = (e: Event) => {
      const { balance, currency } = (e as CustomEvent<{ balance: number; currency: string }>).detail
      setData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          accounts: prev.accounts.map(a =>
            a.accountId === prev.activeAccountId
              ? { ...a, balance, currency }
              : a
          ),
        }
      })
    }
    window.addEventListener('deriv-balance', handler)
    return () => window.removeEventListener('deriv-balance', handler)
  }, [])

  // Refresh immediately when user returns to this tab (e.g. after resetting demo
  // balance on Deriv's site in another tab) — covers the most common reload case.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchBalance() }
    const onFocus   = () => fetchBalance()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchBalance])

  // Fallback REST poll every 15 s (covers pages with no bot WS open)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchBalance()
    }, 15_000)
    return () => clearInterval(id)
  }, [fetchBalance])

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

  /* ── Logout ── */
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 200,
      background: 'rgba(7,17,30,0.97)', backdropFilter: 'blur(12px)',
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

      {/* Right — Account switcher */}
      <div ref={dropRef} style={{ position: 'relative' }}>

        {/* ── Trigger button — Deriv style ── */}
        {loading ? (
          <div style={{
            width: '160px', height: '36px', borderRadius: '8px',
            background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.4s ease infinite',
          }} />
        ) : (
          <button
            onClick={() => setOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: open ? 'rgba(0,210,211,0.08)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${open ? 'rgba(0,210,211,0.35)' : 'rgba(255,255,255,0.1)'}`,
              borderRadius: '8px', padding: '5px 12px 5px 8px',
              color: '#E5E5E5', cursor: 'pointer',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            {/* Teal coin icon */}
            <DerivCoinIcon />

            {/* Balance + currency */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2 }}>
              <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>
                {spinning ? (
                  <span style={{
                    display: 'inline-block', width: '60px', height: '12px', borderRadius: '4px',
                    background: 'rgba(255,255,255,0.1)', animation: 'pulse 1.4s ease infinite',
                  }} />
                ) : (
                  displayBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                )}
              </span>
              <span style={{ color: '#7a9ab5', fontSize: '0.72rem', fontWeight: 500 }}>
                {displayCurrency}
                {activeAccount?.isDemo && (
                  <span style={{ marginLeft: '4px', color: '#888', fontStyle: 'italic' }}>Demo</span>
                )}
              </span>
            </div>

            {/* Chevron */}
            <span style={{ color: '#7a9ab5', marginLeft: '2px' }}>
              <ChevronIcon up={open} />
            </span>
          </button>
        )}

        {/* ── Dropdown ── */}
        {open && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0,
            background: '#0d1821',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: '8px', width: '300px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            overflow: 'hidden', zIndex: 300,
            fontFamily: 'inherit',
          }}>

            {/* ── Real / Demo secondary tabs ── */}
            <div style={{
              display: 'flex',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              background: '#0a131d',
            }}>
              {(['real', 'demo'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => handleTabClick(t)}
                  style={{
                    flex: 1, padding: '11px 0',
                    background: 'transparent', border: 'none',
                    color: tab === t ? '#fff' : 'rgba(255,255,255,0.4)',
                    fontSize: '0.84rem',
                    fontWeight: tab === t ? 700 : 400,
                    cursor: 'pointer', textTransform: 'capitalize',
                    borderBottom: tab === t ? '2px solid #ff444f' : '2px solid transparent',
                    transition: 'all 0.15s',
                    letterSpacing: '0.01em',
                  }}
                >
                  {t === 'real' ? 'Real' : 'Demo'}
                </button>
              ))}
            </div>

            {/* ── "Deriv accounts" accordion header ── */}
            <div
              onClick={() => setAccordionOpen(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px',
                cursor: 'pointer',
                borderBottom: accordionOpen ? '1px solid rgba(255,255,255,0.05)' : 'none',
              }}
            >
              <p style={{
                margin: 0,
                color: 'rgba(255,255,255,0.5)',
                fontSize: '0.78rem', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                Deriv accounts
              </p>
              <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                <ChevronIcon up={accordionOpen} />
              </span>
            </div>

            {/* ── Account rows ── */}
            {accordionOpen && (
              <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                {displayedAccounts.length === 0 ? (
                  <div style={{ padding: '16px', color: '#555', fontSize: '0.83rem', textAlign: 'center' }}>
                    No {tab} accounts
                  </div>
                ) : displayedAccounts.map(acc => {
                  const isActive = acc.accountId === data?.activeAccountId
                  return (
                    <button
                      key={acc.accountId}
                      onClick={async () => {
                        if (!isActive) {
                          await switchAccount(acc.accountId)
                          setOpen(false)
                        }
                      }}
                      disabled={switching || isActive}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center',
                        gap: '12px', padding: '10px 16px',
                        background: isActive ? 'rgba(255,68,79,0.05)' : 'transparent',
                        border: 'none', cursor: isActive ? 'default' : 'pointer',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        transition: 'background 0.15s',
                        textAlign: 'left',
                      }}
                      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)' }}
                      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                    >
                      {/* Flag icon */}
                      <CurrencyFlag currency={acc.currency} />

                      {/* Currency label + account ID */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: '#E5E5E5', fontSize: '0.85rem', fontWeight: 600 }}>
                          {acc.currency}
                        </div>
                        <div style={{ color: '#4a6a85', fontSize: '0.74rem', letterSpacing: '0.03em', marginTop: '1px' }}>
                          {acc.accountId}
                        </div>
                      </div>

                      {/* Balance — right aligned */}
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ color: isActive ? '#fff' : '#8aa', fontSize: '0.85rem', fontWeight: isActive ? 600 : 400 }}>
                          {(acc.balance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {acc.currency}
                        </div>
                        {isActive && (
                          <div style={{ color: '#22c55e', fontSize: '0.7rem', marginTop: '1px' }}>● Active</div>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* ── 4px separator ── */}
            <div style={{ background: 'rgba(255,255,255,0.04)', height: '4px' }} />

            {/* ── CFD link ── */}
            <div style={{ padding: '12px 16px' }}>
              <a
                href="https://app.deriv.com"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: '#ff444f',
                  fontSize: '0.8rem',
                  textDecoration: 'none',
                  display: 'block',
                  lineHeight: 1.5,
                }}
                onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
              >
                Looking for CFD accounts? Go to Trader&#39;s Hub
              </a>
            </div>

            {/* ── 4px separator ── */}
            <div style={{ background: 'rgba(255,255,255,0.04)', height: '4px' }} />

            {/* ── Logout row ── */}
            <button
              onClick={handleLogout}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '13px 16px',
                background: 'transparent', border: 'none',
                color: 'rgba(255,255,255,0.7)',
                fontSize: '0.85rem', fontWeight: 500,
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,68,79,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span>Logout</span>
              <ArrowRightIcon />
            </button>

          </div>
        )}
      </div>

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }
      `}</style>
    </header>
  )
}
