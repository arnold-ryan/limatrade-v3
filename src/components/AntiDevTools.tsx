'use client'

import { useEffect } from 'react'

/**
 * Deters casual copying — disables right-click and common DevTools/view-source
 * keyboard shortcuts.
 *
 * This used to also show a full-screen block when it detected DevTools was
 * docked open, using the gap between window.outerWidth/outerHeight and
 * innerWidth/innerHeight as a heuristic. That heuristic false-positives on
 * split-screen/tiled windows and some multi-tab layouts — confirmed in
 * production, where it locked legitimate users out of the site entirely just
 * for having two windows side by side. It's removed. Keyboard/right-click
 * blocking below only fires on an explicit action (a real click, a real key
 * combo), so it has no equivalent false-positive risk.
 *
 * This remains a deterrent, not real protection — anyone who actually wants
 * the code can bypass all of it (disable JS, fetch the built JS files
 * directly with curl, open DevTools before the page loads, use the browser's
 * top-menu "Inspect" instead of a shortcut, etc). It stops casual "right-click
 * → Inspect" curiosity — nothing more.
 */
export default function AntiDevTools() {
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

    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  return null
}
