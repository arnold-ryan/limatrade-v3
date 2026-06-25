'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

type NavItem = {
  href:  string
  label: string
  soon?: boolean
  icon:  React.ReactNode
}

const NAV: NavItem[] = [
  {
    href:  '/dashboard',
    label: 'Trade',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
        <polyline points="16 7 22 7 22 13"/>
      </svg>
    ),
  },
  {
    href:  '/dashboard/portfolio',
    label: 'Portfolio',
    soon:  true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        <line x1="12" y1="12" x2="12" y2="16"/>
        <line x1="10" y1="14" x2="14" y2="14"/>
      </svg>
    ),
  },
  {
    href:  '/dashboard/bots',
    label: 'Bots',
    soon:  true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2"/>
        <circle cx="12" cy="5" r="2"/>
        <path d="M12 7v4"/>
        <path d="M8 15h.01M16 15h.01"/>
      </svg>
    ),
  },
  {
    href:  '/dashboard/reports',
    label: 'Reports',
    soon:  true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
    ),
  },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside
      style={{
        width: '220px',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--border)',
        background: '#050505',
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: '1.25rem',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <Link
          href="/"
          style={{
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'var(--gold)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
              <polyline points="16 7 22 7 22 13"/>
            </svg>
          </div>
          <span style={{ fontWeight: 800, fontSize: '1.05rem', letterSpacing: '-0.02em' }}>
            <span style={{ color: 'var(--gold)' }}>Lima</span>
            <span style={{ color: '#fff' }}>Trade</span>
          </span>
        </Link>
      </div>

      {/* Navigation */}
      <nav
        style={{
          flex: 1,
          padding: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.2rem',
          overflowY: 'auto',
        }}
      >
        {NAV.map(item => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.soon ? '#' : item.href}
              onClick={e => item.soon && e.preventDefault()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.7rem 0.9rem',
                borderRadius: '10px',
                textDecoration: 'none',
                transition: 'all 0.15s',
                background:  active ? 'rgba(252,163,17,0.1)'  : 'transparent',
                color:       active ? 'var(--gold)'           : 'rgba(229,229,229,0.55)',
                borderLeft: `3px solid ${active ? 'var(--gold)' : 'transparent'}`,
                cursor: item.soon ? 'default' : 'pointer',
              }}
            >
              {item.icon}
              <span style={{ fontSize: '0.875rem', fontWeight: active ? 700 : 500 }}>
                {item.label}
              </span>
              {item.soon && (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    padding: '0.15rem 0.4rem',
                    borderRadius: '4px',
                    background: 'rgba(252,163,17,0.1)',
                    color: 'rgba(252,163,17,0.6)',
                    letterSpacing: '0.04em',
                  }}
                >
                  SOON
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Logout */}
      <div
        style={{
          padding: '0.75rem',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <a
          href="/api/auth/logout"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.7rem 0.9rem',
            borderRadius: '10px',
            color: 'rgba(239,68,68,0.65)',
            textDecoration: 'none',
            fontSize: '0.875rem',
            fontWeight: 500,
            transition: 'color 0.15s',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Logout
        </a>
      </div>
    </aside>
  )
}
