'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

const QUOTES = [
  'Small consistent gains build extraordinary wealth.',
  'Discipline in trading separates professionals from gamblers.',
  'Manage your risk first — profits will follow.',
  'The trend is your friend until it bends.',
  'Every master trader was once a beginner.',
  'Patience and precision beat speed and greed.',
]

const CARDS = [
  {
    title: 'Manual Trader',
    description: 'Trade Deriv synthetics with real-time charts and one-click execution.',
    href: '/dashboard/charts',
    accent: '#FCA311',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
  },
  {
    title: 'Free Bots',
    description: 'Browse ready-made trading bots you can deploy instantly.',
    href: '/dashboard/free-bots',
    accent: '#22c55e',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        <line x1="12" y1="15" x2="12" y2="17"/>
      </svg>
    ),
  },
  {
    title: 'Bot Builder',
    description: 'Design and backtest your own automated trading strategy.',
    href: '/dashboard/bot-builder',
    accent: '#a855f7',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
      </svg>
    ),
  },
  {
    title: 'Risk Calculator',
    description: 'Calculate position sizes and risk-to-reward ratios before you trade.',
    href: '/dashboard/risk-calc',
    accent: '#3b82f6',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2"/>
        <line x1="8" y1="6" x2="16" y2="6"/>
        <line x1="8" y1="10" x2="16" y2="10"/>
        <line x1="8" y1="14" x2="12" y2="14"/>
      </svg>
    ),
  },
]

export default function DashboardPage() {
  const [loginId, setLoginId] = useState('')
  const [quote,   setQuote]   = useState(QUOTES[0])

  // Fetch loginid from balance API
  useEffect(() => {
    fetch('/api/user/balance', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d.loginid) setLoginId(d.loginid) })
      .catch(() => {})
  }, [])

  // Rotate quote every 8 seconds
  useEffect(() => {
    let i = 0
    const id = setInterval(() => {
      i = (i + 1) % QUOTES.length
      setQuote(QUOTES[i])
    }, 8000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '2.5rem 1.5rem',
      }}
    >
      {/* Greeting */}
      <div style={{ marginBottom: '0.6rem' }}>
        <h1
          style={{
            fontSize: 'clamp(1.6rem, 4vw, 2.4rem)',
            fontWeight: 800,
            color: '#fff',
            letterSpacing: '-0.03em',
          }}
        >
          Hello{loginId ? ` ${loginId}` : ''} 👋
        </h1>
      </div>

      {/* Rotating quote */}
      <p
        key={quote}
        style={{
          fontSize: '0.92rem',
          fontStyle: 'italic',
          color: 'rgba(229,229,229,0.45)',
          marginBottom: '2.5rem',
          animation: 'fadeIn 0.5s ease',
        }}
      >
        &ldquo;{quote}&rdquo;
      </p>

      {/* Quick Actions header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          marginBottom: '1.25rem',
        }}
      >
        <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'rgba(229,229,229,0.35)',
            whiteSpace: 'nowrap',
          }}
        >
          Quick Actions
        </span>
        <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
      </div>

      {/* Cards grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        {CARDS.map(card => (
          <Link
            key={card.title}
            href={card.href}
            style={{ textDecoration: 'none' }}
          >
            <div
              style={{
                background: '#080808',
                border: '1px solid var(--border)',
                borderRadius: '14px',
                overflow: 'hidden',
                transition: 'border-color 0.2s, transform 0.2s, box-shadow 0.2s',
                cursor: 'pointer',
              }}
              onMouseOver={e => {
                const el = e.currentTarget as HTMLDivElement
                el.style.borderColor = card.accent
                el.style.transform = 'translateY(-3px)'
                el.style.boxShadow = `0 12px 32px rgba(0,0,0,0.4)`
              }}
              onMouseOut={e => {
                const el = e.currentTarget as HTMLDivElement
                el.style.borderColor = 'var(--border)'
                el.style.transform = 'translateY(0)'
                el.style.boxShadow = 'none'
              }}
            >
              {/* Colored top stripe */}
              <div style={{ height: '4px', background: card.accent }} />

              <div style={{ padding: '1.25rem' }}>
                {/* Icon box */}
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '10px',
                    background: `${card.accent}18`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: card.accent,
                    marginBottom: '0.9rem',
                  }}
                >
                  {card.icon}
                </div>

                <h3
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 700,
                    color: '#fff',
                    marginBottom: '0.4rem',
                  }}
                >
                  {card.title}
                </h3>
                <p
                  style={{
                    fontSize: '0.75rem',
                    color: 'rgba(229,229,229,0.45)',
                    lineHeight: 1.5,
                    marginBottom: '1rem',
                  }}
                >
                  {card.description}
                </p>

                {/* CTA */}
                <span
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    color: card.accent,
                  }}
                >
                  Open →
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
