'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// visible: false = route exists in the codebase but tab is hidden until the page is built
const TABS = [
  { label: 'Dashboard',      href: '/dashboard',               icon: '⊞', visible: true  },
  { label: 'Bot Builder',    href: '/dashboard/bot-builder',   icon: '⚙', visible: true  },
  { label: 'Free Bots',      href: '/dashboard/free-bots',     icon: '🤖', visible: true  },
  { label: 'Speedbot',       href: '/dashboard/speedbot',      icon: '⚡', visible: true  },
  { label: 'Analysis Tool',  href: '/dashboard/analysis',      icon: '📊', visible: true  },
  { label: 'Manual Trader',  href: '/dashboard/manual-trader', icon: '✎', visible: true  },
  { label: 'Charts',         href: '/dashboard/charts',        icon: '▲', visible: true  },
  // ── Not yet built — keep routes, hide tabs ──────────────────────────────
  { label: 'AI Software',    href: '/dashboard/ai-software',   icon: '✦', visible: false },
  { label: 'Auto Trader',    href: '/dashboard/auto-trader',   icon: '↺', visible: false },
  { label: 'Bulk Trader',    href: '/dashboard/bulk-trader',   icon: '⣿', visible: false },
  { label: 'Copy Trader',    href: '/dashboard/copy-trader',   icon: '⊕', visible: false },
  { label: 'Risk Calculator',href: '/dashboard/risk-calc',     icon: '⚖', visible: false },
  { label: 'Trade Academy',  href: '/dashboard/academy',       icon: '🎓', visible: false },
]

export default function TabNav() {
  const pathname = usePathname()

  return (
    <nav
      style={{
        background: '#050505',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          height: '44px',
          width: '100%',
        }}
      >
        {TABS.filter(tab => tab.visible).map(tab => {
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
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.4rem',
                fontSize: '0.75rem',
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--gold)' : 'rgba(229,229,229,0.5)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
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
              <span style={{ fontSize: '0.8rem', lineHeight: 1 }}>{tab.icon}</span>
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
