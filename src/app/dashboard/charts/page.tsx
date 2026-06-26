'use client'

import { useState, useEffect, useRef } from 'react'

const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'

const MARKETS = [
  { symbol: 'R_10',      label: 'Volatility 10 Index'        },
  { symbol: 'R_25',      label: 'Volatility 25 Index'        },
  { symbol: 'R_50',      label: 'Volatility 50 Index'        },
  { symbol: 'R_75',      label: 'Volatility 75 Index'        },
  { symbol: 'R_100',     label: 'Volatility 100 Index'       },
  { symbol: '1HZ10V',    label: 'Volatility 10 (1s) Index'  },
  { symbol: '1HZ25V',    label: 'Volatility 25 (1s) Index'  },
  { symbol: '1HZ50V',    label: 'Volatility 50 (1s) Index'  },
  { symbol: '1HZ75V',    label: 'Volatility 75 (1s) Index'  },
  { symbol: '1HZ100V',   label: 'Volatility 100 (1s) Index' },
  { symbol: 'BOOM1000',  label: 'Boom 1000 Index'           },
  { symbol: 'BOOM500',   label: 'Boom 500 Index'            },
  { symbol: 'CRASH1000', label: 'Crash 1000 Index'          },
  { symbol: 'CRASH500',  label: 'Crash 500 Index'           },
  { symbol: 'stpRNG',    label: 'Step Index'                },
  { symbol: 'JD10',      label: 'Jump 10 Index'             },
  { symbol: 'JD25',      label: 'Jump 25 Index'             },
  { symbol: 'JD50',      label: 'Jump 50 Index'             },
  { symbol: 'JD75',      label: 'Jump 75 Index'             },
  { symbol: 'JD100',     label: 'Jump 100 Index'            },
]

function lastDigit(price: number, pipSize = 2): number {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}

function PriceChart({ prices, livePrice, label, pipSize }: {
  prices: number[]; livePrice: number | null; label: string; pipSize: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visible = prices.slice(-400)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || visible.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    canvas.width  = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    const lo = Math.min(...visible)
    const hi = Math.max(...visible)
    const range = hi - lo || 1
    const padL = 62, padR = 16, padT = 12, padB = 24
    const cW = W - padL - padR
    const cH = H - padT - padB
    const xOf = (i: number) => padL + (i / (visible.length - 1)) * cW
    const yOf = (p: number) => padT + (1 - (p - lo) / range) * cH

    ctx.fillStyle = '#060f1c'
    ctx.fillRect(0, 0, W, H)

    for (let i = 0; i <= 5; i++) {
      const y = padT + (i / 5) * cH
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
      const v = hi - (i / 5) * range
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '10px monospace'
      ctx.textAlign = 'right'
      ctx.fillText(v.toFixed(pipSize), padL - 4, y + 4)
    }

    const vStep = Math.max(1, Math.floor(visible.length / 8))
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    for (let i = 0; i < visible.length; i += vStep) {
      ctx.beginPath(); ctx.moveTo(xOf(i), padT); ctx.lineTo(xOf(i), padT + cH); ctx.stroke()
    }

    const grad = ctx.createLinearGradient(0, padT, 0, padT + cH)
    grad.addColorStop(0, 'rgba(252,163,17,0.18)')
    grad.addColorStop(1, 'rgba(252,163,17,0)')
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(visible[0]))
    for (let i = 1; i < visible.length; i++) ctx.lineTo(xOf(i), yOf(visible[i]))
    ctx.lineTo(xOf(visible.length - 1), padT + cH)
    ctx.lineTo(xOf(0), padT + cH)
    ctx.closePath()
    ctx.fillStyle = grad; ctx.fill()

    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(visible[0]))
    for (let i = 1; i < visible.length; i++) ctx.lineTo(xOf(i), yOf(visible[i]))
    ctx.strokeStyle = '#FCA311'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke()

    if (livePrice != null) {
      const ly = yOf(livePrice)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(239,68,68,0.45)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#ef4444'
      ctx.fillRect(W - padR + 2, ly - 8, 56, 16)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'left'
      ctx.fillText(livePrice.toFixed(pipSize), W - padR + 5, ly + 4)
    }

    const lx = xOf(visible.length - 1)
    const ly2 = yOf(visible[visible.length - 1])
    ctx.beginPath(); ctx.arc(lx, ly2, 4.5, 0, Math.PI * 2)
    ctx.fillStyle = '#FCA311'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
  }, [visible, livePrice, pipSize])

  return (
    <div style={{ background: '#060f1c', borderRadius: '10px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)', flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px 6px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <span style={{ fontSize: '0.73rem', fontWeight: 700, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {label}
        </span>
        <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.22)' }}>
          last {Math.min(prices.length, 400)} ticks
        </span>
      </div>
      {prices.length < 2 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.78rem' }}>
          Waiting for tick data…
        </div>
      ) : (
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', flex: 1 }} />
      )}
    </div>
  )
}

export default function ChartsPage() {
  const [symbol,       setSymbol]       = useState('R_100')
  const [prices,       setPrices]       = useState<number[]>([])
  const [livePrice,    setLivePrice]    = useState<number | null>(null)
  const [recentDigits, setRecentDigits] = useState<number[]>([])
  const [pipSize,      setPipSize]      = useState(2)
  const [connected,    setConnected]    = useState(false)

  const marketLabel = MARKETS.find(m => m.symbol === symbol)?.label ?? symbol

  useEffect(() => {
    setConnected(false)
    setPrices([])
    setLivePrice(null)
    setRecentDigits([])

    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({
        ticks_history: symbol, end: 'latest', count: 200,
        style: 'ticks', subscribe: 1, req_id: 1,
      }))
    }
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.msg_type === 'history') {
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps != null) setPipSize(ps)
        const hist = (msg as { history: { prices: number[] } }).history.prices
        const nums = hist.map(Number)
        const ps2 = ps ?? pipSize
        setRecentDigits(nums.slice(-50).map(p => lastDigit(p, ps2)))
        setPrices(nums)
        setLivePrice(nums[nums.length - 1] ?? null)
      }

      if (msg.msg_type === 'tick') {
        const td = (msg as { tick: { quote: number; pip_size: number } }).tick
        if (td.pip_size != null) setPipSize(td.pip_size)
        const q = td.quote
        setLivePrice(q)
        setRecentDigits(prev => [...prev.slice(-49), lastDigit(q, td.pip_size ?? pipSize)])
        setPrices(prev => [...prev.slice(-999), q])
      }
    }
    ws.onerror = () => setConnected(false)
    ws.onclose = () => setConnected(false)

    return () => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 99 })) } catch { /**/ }
      ws.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  /* digit stats */
  const digitCounts = Array.from({ length: 10 }, (_, d) => ({
    d, count: recentDigits.filter(x => x === d).length,
  }))
  const maxCount = Math.max(...digitCounts.map(x => x.count), 1)

  const inputSt: React.CSSProperties = {
    background: '#0a0f1a', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px', color: '#fff', fontSize: '0.82rem',
    padding: '0.45rem 0.65rem', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <div style={{ background: '#000', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.9rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#050505', flexShrink: 0,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: '#fff' }}>Charts</h1>
          <p style={{ margin: 0, fontSize: '0.7rem', color: 'rgba(229,229,229,0.35)', marginTop: '1px' }}>
            Live price feed · digit analysis · tick history
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          {livePrice != null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#FCA311', fontVariantNumeric: 'tabular-nums' }}>
                {livePrice.toFixed(pipSize)}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
              background: connected ? '#22c55e' : '#888',
              boxShadow: connected ? '0 0 6px #22c55e88' : 'none',
              animation: connected ? 'pulse 2s ease infinite' : 'none',
            }} />
            <span style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.5)' }}>
              {connected ? 'Live' : 'Connecting…'}
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '1.25rem', gap: '1rem', overflowY: 'auto' }}>

        {/* Market picker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
          <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'rgba(229,229,229,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
            Market
          </label>
          <select value={symbol} onChange={e => setSymbol(e.target.value)} style={{ ...inputSt, minWidth: '220px', cursor: 'pointer' }}>
            {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
          </select>
        </div>

        {/* Price chart */}
        <div style={{ flexShrink: 0, height: '320px', display: 'flex' }}>
          <PriceChart prices={prices} livePrice={livePrice} label={marketLabel} pipSize={pipSize} />
        </div>

        {/* Digit analysis */}
        <div style={{
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '12px', padding: '1rem', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#fff' }}>Last Digit Analysis</span>
            <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.3)' }}>
              {recentDigits.length} ticks
            </span>
          </div>

          {/* Bar chart */}
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end', height: '80px', marginBottom: '0.5rem' }}>
            {digitCounts.map(({ d, count }) => {
              const pct = count / maxCount
              const isHot = count === maxCount
              const isCold = count === Math.min(...digitCounts.map(x => x.count))
              return (
                <div key={d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', height: '100%', justifyContent: 'flex-end' }}>
                  <span style={{ fontSize: '0.6rem', color: isHot ? '#22c55e' : isCold ? '#ef4444' : 'rgba(229,229,229,0.35)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {count}
                  </span>
                  <div style={{
                    width: '100%', height: `${Math.max(pct * 52, 3)}px`, borderRadius: '3px 3px 0 0',
                    background: isHot ? '#22c55e' : isCold ? '#ef4444' : 'rgba(252,163,17,0.45)',
                    transition: 'height 0.3s',
                  }} />
                </div>
              )
            })}
          </div>

          {/* Digit labels */}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {digitCounts.map(({ d }) => (
              <div key={d} style={{ flex: 1, textAlign: 'center', fontSize: '0.68rem', fontWeight: 700, color: 'rgba(229,229,229,0.55)' }}>
                {d}
              </div>
            ))}
          </div>

          {/* Recent tick row */}
          {recentDigits.length > 0 && (
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.2rem', flexWrap: 'wrap' }}>
              {recentDigits.slice(-30).map((d, i) => {
                const isLast = i === Math.min(recentDigits.length, 30) - 1
                return (
                  <div key={i} style={{
                    width: '22px', height: '22px', borderRadius: '4px', fontSize: '0.62rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: isLast ? 'rgba(252,163,17,0.2)' : 'rgba(255,255,255,0.04)',
                    border: `1.5px solid ${isLast ? '#FCA311' : 'rgba(255,255,255,0.1)'}`,
                    color: isLast ? '#FCA311' : 'rgba(229,229,229,0.55)',
                  }}>{d}</div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }`}</style>
    </div>
  )
}
