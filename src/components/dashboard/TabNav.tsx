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
    <>
      <style>{`
        .tabnav {
          background: var(--bg1);
          border-bottom: 1px solid var(--bdr);
          flex-shrink: 0;
        }
        .tabnav-inner {
          display: flex;
          align-items: stretch;
          height: 44px;
          width: 100%;
        }
        .tabnav-link {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          font-size: 0.75rem;
          white-space: nowrap;
          text-decoration: none;
          transition: color 0.15s;
          padding: 0;
        }
        /* ── Mobile / tablet: horizontal scroll ── */
        @media (max-width: 767px) {
          .tabnav {
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
          }
          .tabnav::-webkit-scrollbar { display: none; }
          .tabnav-inner {
            width: max-content;
            min-width: 100%;
          }
          .tabnav-link {
            flex: none;
            padding: 0 14px;
            font-size: 0.7rem;
            gap: 0.3rem;
          }
          .tabnav-icon { font-size: 0.85rem !important; }
          .tabnav-label { display: none; }
        }
        /* ── Tablet: show labels again, slightly smaller ── */
        @media (min-width: 480px) and (max-width: 767px) {
          .tabnav-label { display: inline; }
          .tabnav-link { padding: 0 10px; font-size: 0.68rem; }
        }
      `}</style>

      <nav className="tabnav">
        <div className="tabnav-inner">
          {TABS.filter(tab => tab.visible).map(tab => {
            const isActive =
              tab.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(tab.href)

            return (
              <Link
                key={tab.href + tab.label}
                href={tab.href}
                className="tabnav-link"
                style={{
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? 'var(--gold)' : 'var(--txt1)',
                  borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
                }}
                onMouseOver={e => {
                  if (!isActive) e.currentTarget.style.color = 'var(--txt0)'
                }}
                onMouseOut={e => {
                  if (!isActive) e.currentTarget.style.color = 'var(--txt1)'
                }}
              >
                <span className="tabnav-icon" style={{ fontSize: '0.8rem', lineHeight: 1 }}>{tab.icon}</span>
                <span className="tabnav-label">{tab.label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
