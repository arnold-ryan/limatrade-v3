'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { label: 'Dashboard',     href: '/dashboard',              icon: '⊞' },
  { label: 'Bot Builder',   href: '/dashboard/bot-builder',  icon: '⚙' },
  { label: 'Free Bots',     href: '/dashboard/free-bots',    icon: '🤖' },
  { label: 'Speedbot',      href: '/dashboard/speedbot',     icon: '⚡' },
  { label: 'AI Software',   href: '/dashboard/ai-software',  icon: '✦' },
  { label: 'Auto Trader',   href: '/dashboard/auto-trader',  icon: '↺' },
  { label: 'Analysis Tool', href: '/dashboard/analysis',     icon: '📊' },
  { label: 'Manual Trader', href: '/dashboard/manual-trader', icon: '✎' },
  { label: 'Bulk Trader',   href: '/dashboard/bulk-trader',  icon: '⣿' },
  { label: 'Charts',        href: '/dashboard/charts',       icon: '▲' },
  { label: 'Copy Trader',   href: '/dashboard/copy-trader',  icon: '⊕' },
  { label: 'Risk Calculator',href: '/dashboard/risk-calc',   icon: '⚖' },
  { label: 'Trade Academy', href: '/dashboard/academy',      icon: '🎓' },
]

export default function TabNav() {
  const pathname = usePathname()

  return (
    <nav
      style={{
        background: '#050505',
        borderBottom: '1px solid var(--border)',
        overflowX: 'auto',
        flexShrink: 0,
        scrollbarWidth: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          minWidth: 'max-content',
          height: '44px',
        }}
      >
        {TABS.map(tab => {
          // Active: exact match for /dashboard, prefix match for sub-pages
          const isActive =
            tab.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(tab.href)

          return (
            <Link
              key={tab.href + tab.label}
              href={tab.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0 1rem',
                fontSize: '0.78rem',
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--gold)' : 'rgba(229,229,229,0.5)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                position: 'relative',
                transition: 'color 0.15s',
                borderBottom: isActive
                  ? '2px solid var(--gold)'
                  : '2px solid transparent',
              }}
              onMouseOver={e => {
                if (!isActive) e.currentTarget.style.color = '#fff'
              }}
              onMouseOut={e => {
                if (!isActive) e.currentTarget.style.color = 'rgba(229,229,229,0.5)'
              }}
            >
              <span style={{ fontSize: '0.82rem', lineHeight: 1 }}>{tab.icon}</span>
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
