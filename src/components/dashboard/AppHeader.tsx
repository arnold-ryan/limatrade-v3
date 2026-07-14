'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * AppHeader — sticky top bar with real-time balance + Deriv-style account switcher
 * + light/dark theme toggle (persisted to localStorage, class toggled on <html>)
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
      background: 'var(--bg2)',
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

  // ── Theme toggle ─────────────────────────────────────────────────────────
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    setIsDark(!document.documentElement.classList.contains('light'))
  }, [])

  function toggleTheme() {
    const el = document.documentElement
    const willBeDark = el.classList.contains('light')
    el.classList.toggle('light')
    try { localStorage.setItem('lima-theme', willBeDark ? 'dark' : 'light') } catch (_) {}
    setIsDark(willBeDark)
  }

  /* ── Fetch balance ── */
  const fetchBalance = useCallback(async (showSpin = false) => {
    if (showSpin) setSpinning(true)
    try {
      const res = await fetch('/api/user/balance', { cache: 'no-store' })
      if (res.ok) {
        const d: BalanceData = await res.json()
        setData(d)
        const active = d.accounts.find(a => a.accountId === d.activeAccountId)
        if (active) setTab(active.isDemo ? 'demo' : 'real')
      }
    } finally {
      setLoading(false)
      if (showSpin) setTimeout(() => setSpinning(false), 600)
    }
  }, [])

  useEffect(() => { fetchBalance() }, [fetchBalance])

  // Real-time balance via CustomEvent from bot WebSockets
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

  // Refresh balance after prolonged inactivity (≥10 min)
  useEffect(() => {
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
      } else if (document.visibilityState === 'visible') {
        if (hiddenAt > 0 && Date.now() - hiddenAt >= 10 * 60 * 1000) {
          fetchBalance()
        }
        hiddenAt = 0
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [fetchBalance])

  // Fallback REST poll every 5 min
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchBalance()
    }, 5 * 60_000)
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
      if (res.ok) {
        await fetchBalance()
        window.dispatchEvent(new CustomEvent('deriv-account-switch'))
      }
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
    <header className="app-header" style={{
      position: 'sticky', top: 0, zIndex: 200,
      background: 'var(--hdr-bg)', backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--hdr-bdr)',
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
        <span className="app-header-logo-text" style={{ color: 'var(--hdr-txt)', fontWeight: 700, fontSize: '1.1rem', letterSpacing: '-0.3px' }}>
          Lima Trade
        </span>
      </Link>

      {/* Right side — theme toggle + account switcher */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

        {/* ── Theme toggle button ── */}
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            width: 34, height: 34,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--hdr-bdr)',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 16,
            color: 'var(--hdr-txt)',
            flexShrink: 0,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          {isDark ? '☀️' : '🌙'}
        </button>

        {/* ── Account switcher ── */}
        <div ref={dropRef} style={{ position: 'relative' }}>

          {/* Trigger button */}
          {loading ? (
            <div style={{
              width: '160px', height: '36px', borderRadius: '8px',
              background: 'var(--bg2)', animation: 'pulse 1.4s ease infinite',
            }} />
          ) : (
            <button
              onClick={() => setOpen(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                background: open ? 'rgba(0,210,211,0.08)' : 'var(--drop-row)',
                border: `1px solid ${open ? 'rgba(0,210,211,0.35)' : 'var(--hdr-bdr)'}`,
                borderRadius: '8px', padding: '5px 12px 5px 8px',
                color: 'var(--hdr-txt)', cursor: 'pointer',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <DerivCoinIcon />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2 }}>
                <span style={{ color: 'var(--txt0)', fontSize: '0.9rem', fontWeight: 600 }}>
                  {spinning ? (
                    <span style={{
                      display: 'inline-block', width: '60px', height: '12px', borderRadius: '4px',
                      background: 'var(--bg2)', animation: 'pulse 1.4s ease infinite',
                    }} />
                  ) : (
                    displayBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  )}
                </span>
                <span style={{ color: 'var(--txt1)', fontSize: '0.72rem', fontWeight: 500 }}>
                  {displayCurrency}
                  {activeAccount?.isDemo && (
                    <span style={{ marginLeft: '4px', color: 'var(--txt2)', fontStyle: 'italic' }}>Demo</span>
                  )}
                </span>
              </div>
              <span style={{ color: 'var(--txt1)', marginLeft: '2px' }}>
                <ChevronIcon up={open} />
              </span>
            </button>
          )}

          {/* ── Dropdown ── */}
          {open && (
            <div className="account-dropdown" style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0,
              background: 'var(--drop-bg)',
              border: '1px solid var(--drop-bdr)',
              borderRadius: '8px', width: '300px',
              boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
              overflow: 'hidden', zIndex: 300,
              fontFamily: 'inherit',
            }}>

              {/* Real / Demo tabs */}
              <div style={{
                display: 'flex',
                borderBottom: '1px solid var(--drop-sep)',
                background: 'var(--drop-bg2)',
              }}>
                {(['real', 'demo'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => handleTabClick(t)}
                    style={{
                      flex: 1, padding: '11px 0',
                      background: 'transparent', border: 'none',
                      color: tab === t ? 'var(--txt0)' : 'var(--drop-muted)',
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

              {/* Accordion header */}
              <div
                onClick={() => setAccordionOpen(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  borderBottom: accordionOpen ? '1px solid var(--drop-sep)' : 'none',
                }}
              >
                <p style={{
                  margin: 0,
                  color: 'var(--drop-muted)',
                  fontSize: '0.78rem', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  Deriv accounts
                </p>
                <span style={{ color: 'var(--drop-muted)' }}>
                  <ChevronIcon up={accordionOpen} />
                </span>
              </div>

              {/* Account rows */}
              {accordionOpen && (
                <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                  {displayedAccounts.length === 0 ? (
                    <div style={{ padding: '16px', color: 'var(--txt2)', fontSize: '0.83rem', textAlign: 'center' }}>
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
                          borderBottom: '1px solid var(--drop-row)',
                          transition: 'background 0.15s',
                          textAlign: 'left',
                        }}
                        onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--drop-row)' }}
                        onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                      >
                        <CurrencyFlag currency={acc.currency} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: 'var(--drop-txt)', fontSize: '0.85rem', fontWeight: 600 }}>
                            {acc.currency}
                          </div>
                          <div style={{ color: 'var(--txt2)', fontSize: '0.74rem', letterSpacing: '0.03em', marginTop: '1px' }}>
                            {acc.accountId}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ color: isActive ? 'var(--txt0)' : 'var(--txt1)', fontSize: '0.85rem', fontWeight: isActive ? 600 : 400 }}>
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

              {/* Separator */}
              <div style={{ background: 'var(--drop-sep)', height: '4px' }} />

              {/* CFD link */}
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

              {/* Separator */}
              <div style={{ background: 'var(--drop-sep)', height: '4px' }} />

              {/* Logout row */}
              <button
                onClick={handleLogout}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '13px 16px',
                  background: 'transparent', border: 'none',
                  color: 'var(--drop-txt)',
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
      </div>

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }

        /* ── Mobile header ── */
        @media (max-width: 767px) {
          .app-header { padding: 0 12px !important; gap: 8px !important; }
          .app-header-logo-text { display: none; }
          .account-dropdown {
            width: calc(100vw - 24px) !important;
            max-width: 300px;
          }
        }
      `}</style>
    </header>
  )
}
