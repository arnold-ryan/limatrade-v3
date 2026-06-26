'use client'

import { useEffect, useRef, useState } from 'react'

const SYMBOLS = [
  { name: 'Vol 10',      id: '1HZ10V'   },
  { name: 'Vol 25',      id: '1HZ25V'   },
  { name: 'Vol 50',      id: '1HZ50V'   },
  { name: 'Vol 75',      id: '1HZ75V'   },
  { name: 'Vol 100',     id: '1HZ100V'  },
  { name: 'Bull Market', id: 'BOOM1000' },
  { name: 'Bear Market', id: 'CRASH1000'},
]

type TickData = { price: string; dir: 'up' | 'down' | 'flat' }

export default function Ticker() {
  const [ticks, setTicks] = useState<Record<string, TickData>>({})
  const wsRef = useRef<WebSocket | null>(null)
  const prevRef = useRef<Record<string, number>>({})

  useEffect(() => {
    // Public WS endpoint — no auth required
    const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089')
    wsRef.current = ws

    ws.onopen = () => {
      SYMBOLS.forEach(s =>
        ws.send(JSON.stringify({ ticks: s.id, subscribe: 1 }))
      )
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.msg_type !== 'tick') return
      const { symbol, quote } = msg.tick
      const sym = SYMBOLS.find(s => s.id === symbol)
      if (!sym) return
      const prev = prevRef.current[symbol] ?? quote
      const dir: TickData['dir'] = quote > prev ? 'up' : quote < prev ? 'down' : 'flat'
      prevRef.current[symbol] = quote
      setTicks(t => ({ ...t, [symbol]: { price: quote.toFixed(2), dir } }))
    }

    return () => ws.close()
  }, [])

  const items = [...SYMBOLS, ...SYMBOLS] // duplicate for seamless loop

  return (
    <div className="fixed z-40 left-0 right-0 overflow-hidden"
      style={{ top: '64px', background: 'var(--navy)', borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
      <div className="ticker-track flex gap-0 animate-ticker" style={{ width: 'max-content' }}>
        {items.map((s, i) => {
          const t = ticks[s.id]
          const color = !t ? '#fff' : t.dir === 'up' ? 'var(--up)' : t.dir === 'down' ? 'var(--down)' : '#fff'
          return (
            <div key={i} className="flex items-center gap-2 px-6 text-xs font-semibold whitespace-nowrap"
              style={{ borderRight: '1px solid rgba(255,255,255,0.08)' }}>
              <span style={{ color: 'var(--silver)', fontWeight: 400 }}>{s.name}</span>
              <span style={{ color }}>{t?.price ?? '—'}</span>
              {t && <span style={{ color, fontSize: '10px' }}>{t.dir === 'up' ? '▲' : t.dir === 'down' ? '▼' : ''}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
