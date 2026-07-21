'use client'

import { useEffect, useState } from 'react'

/**
 * Deters casual copying — disables right-click and common DevTools/view-source
 * shortcuts, and shows a blocking overlay if DevTools appears to be open.
 *
 * This is a deterrent, not real protection. Anyone who actually wants the code
 * can bypass all of it (disable JS, fetch the built JS files directly with curl,
 * open DevTools before the page loads, undock DevTools to a second window so the
 * size-based detection below never triggers, etc). It stops "right-click →
 * Inspect" curiosity from casual visitors and resellers — nothing more.
 */
export default function AntiDevTools() {
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    document.addEventListener('contextmenu', onContextMenu)

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const devtoolsCombo =
        key === 'f12' ||
        (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) ||
        (isMac && e.metaKey && e.altKey && (key === 'i' || key === 'j' || key === 'c')) ||
        (e.ctrlKey && key === 'u') ||
        (isMac && e.metaKey && key === 'u')
      if (devtoolsCombo) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)

    // Docked-DevTools heuristic: when DevTools is docked to a side/bottom of the
    // browser window, the gap between outer (window chrome) and inner (viewport)
    // dimensions jumps. False positives are possible on some browser toolbar/zoom
    // configurations — this is approximate, not authoritative.
    const THRESHOLD = 160
    const check = () => {
      const widthGap  = window.outerWidth  - window.innerWidth
      const heightGap = window.outerHeight - window.innerHeight
      setBlocked(widthGap > THRESHOLD || heightGap > THRESHOLD)
    }
    check()
    const interval = setInterval(check, 500)
    window.addEventListener('resize', check)

    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', check)
      clearInterval(interval)
    }
  }, [])

  if (!blocked) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 999999,
        background: '#050505', color: '#E5E5E5',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '2rem', gap: '0.75rem',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ fontSize: '2.5rem' }}>🔒</div>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 800, margin: 0, color: '#FCA311' }}>
        Developer Tools Disabled
      </h1>
      <p style={{ maxWidth: '360px', fontSize: '0.9rem', color: 'rgba(229,229,229,0.6)', margin: 0 }}>
        Close DevTools and reload the page to continue using Lima Trade.
      </p>
    </div>
  )
}
