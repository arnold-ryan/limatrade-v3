'use client'

import { useState, useEffect } from 'react'

function useServerTime() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setTime(
        now.toUTCString().replace('GMT', 'UTC').split(' ').slice(1).join(' ')
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return time
}

function useNetworkStatus() {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const on  = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online',  on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export default function AppFooter() {
  const time   = useServerTime()
  const online = useNetworkStatus()

  return (
    <footer
      style={{
        height: '36px',
        background: '#000',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 1.25rem',
        flexShrink: 0,
        fontSize: '0.7rem',
        color: 'rgba(229,229,229,0.35)',
      }}
    >
      {/* Left: disclaimer */}
      <span>
        Trading involves risk. Only trade with funds you can afford to lose.
      </span>

      {/* Right: server time + network dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {time}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span
            style={{
              width: '7px', height: '7px',
              borderRadius: '50%',
              display: 'inline-block',
              background: online ? '#22c55e' : '#ef4444',
              boxShadow: online
                ? '0 0 6px rgba(34,197,94,0.6)'
                : '0 0 6px rgba(239,68,68,0.6)',
            }}
          />
          <span style={{ color: online ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)' }}>
            {online ? 'Connected' : 'Offline'}
          </span>
        </div>
      </div>
    </footer>
  )
}
