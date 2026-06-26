'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/* ─── Constants ─────────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'

const MARKETS = [
  { symbol: '1HZ100V',   label: 'Volatility 100 (1s)' },
  { symbol: '1HZ10V',    label: 'Volatility 10 (1s)'  },
  { symbol: '1HZ25V',    label: 'Volatility 25 (1s)'  },
  { symbol: '1HZ50V',    label: 'Volatility 50 (1s)'  },
  { symbol: '1HZ75V',    label: 'Volatility 75 (1s)'  },
  { symbol: 'R_100',     label: 'Volatility 100'       },
  { symbol: 'R_10',      label: 'Volatility 10'        },
  { symbol: 'R_25',      label: 'Volatility 25'        },
  { symbol: 'R_50',      label: 'Volatility 50'        },
  { symbol: 'R_75',      label: 'Volatility 75'        },
  { symbol: 'BOOM1000',  label: 'Boom 1000'            },
  { symbol: 'BOOM500',   label: 'Boom 500'             },
  { symbol: 'CRASH1000', label: 'Crash 1000'           },
  { symbol: 'CRASH500',  label: 'Crash 500'            },
  { symbol: 'stpRNG',    label: 'Step Index'           },
  { symbol: 'JD10',      label: 'Jump 10'              },
  { symbol: 'JD25',      label: 'Jump 25'              },
  { symbol: 'JD50',      label: 'Jump 50'              },
  { symbol: 'JD75',      label: 'Jump 75'              },
  { symbol: 'JD100',     label: 'Jump 100'             },
]

// Granularity=0 → tick mode; else → candle mode
const TIMEFRAMES = [
  { label: '1T',  granularity: 0     },
  { label: '1m',  granularity: 60    },
  { label: '5m',  granularity: 300   },
  { label: '15m', granularity: 900   },
  { label: '30m', granularity: 1800  },
  { label: '1h',  granularity: 3600  },
  { label: '4h',  granularity: 14400 },
  { label: '1D',  granularity: 86400 },
]

/* ─── Types ─────────────────────────────────────────────────────────────────── */
interface Candle { epoch: number; open: number; high: number; low: number; close: number }

/* ─── Helpers ───────────────────────────────────────────────────────────────── */
function fmtPrice(p: number, pip: number) {
  return p.toFixed(pip)
}

function fmtTime(epoch: number, granularity: number): string {
  const d = new Date(epoch * 1000)
  if (granularity >= 86400) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (granularity >= 3600)  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/* ─── Candlestick Canvas ─────────────────────────────────────────────────────── */
function CandleChart({ candles, pipSize, granularity }: {
  candles: Candle[]; pipSize: number; granularity: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || candles.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const W   = container.clientWidth
    const H   = container.clientHeight
    canvas.width  = W * dpr
    canvas.height = H * dpr
    canvas.style.width  = W + 'px'
    canvas.style.height = H + 'px'
    ctx.scale(dpr, dpr)

    const padL = 12, padR = 72, padT = 14, padB = 28
    const cW = W - padL - padR
    const cH = H - padT - padB

    // Background
    ctx.fillStyle = '#060d18'
    ctx.fillRect(0, 0, W, H)

    // Visible candles — fit as many as possible with min 6px body width
    const maxCandles = Math.min(candles.length, Math.floor(cW / 8))
    const visible = candles.slice(-maxCandles)
    const n = visible.length
    if (n < 1) return

    const candleW = Math.min(Math.floor(cW / n) - 2, 18)
    const step    = cW / n
    const xOf     = (i: number) => padL + (i + 0.5) * step

    // Price range
    let lo = Infinity, hi = -Infinity
    for (const c of visible) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high }
    const range = hi - lo || 1
    const pad   = range * 0.08
    lo -= pad; hi += pad
    const yOf = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * cH

    // Horizontal grid lines + price labels
    const gridCount = 5
    for (let i = 0; i <= gridCount; i++) {
      const y = padT + (i / gridCount) * cH
      const v = hi - (i / gridCount) * (hi - lo)
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = `10px 'SF Mono', monospace`
      ctx.textAlign = 'left'
      ctx.fillText(fmtPrice(v, pipSize), W - padR + 5, y + 4)
    }

    // Vertical time labels (every ~8 candles)
    const labelEvery = Math.max(1, Math.floor(n / 6))
    for (let i = 0; i < n; i++) {
      if (i % labelEvery !== 0) continue
      const x = xOf(i)
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + cH); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.font = '9px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(fmtTime(visible[i].epoch, granularity), x, padT + cH + 18)
    }

    // Draw candles
    for (let i = 0; i < n; i++) {
      const c    = visible[i]
      const x    = xOf(i)
      const isUp = c.close >= c.open
      const col  = isUp ? '#26a69a' : '#ef5350'  // Deriv-style teal/red

      const bodyTop = yOf(Math.max(c.open, c.close))
      const bodyBot = yOf(Math.min(c.open, c.close))
      const bodyH   = Math.max(bodyBot - bodyTop, 1)
      const wickX   = x

      // Wick
      ctx.strokeStyle = col
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(wickX, yOf(c.high))
      ctx.lineTo(wickX, yOf(c.low))
      ctx.stroke()

      // Body
      const isLast = i === n - 1
      ctx.fillStyle = isUp
        ? (isLast ? 'rgba(38,166,154,0.9)' : 'rgba(38,166,154,0.75)')
        : (isLast ? 'rgba(239,83,80,0.9)'  : 'rgba(239,83,80,0.75)')
      ctx.strokeStyle = col
      ctx.lineWidth = 1
      const bx = x - candleW / 2
      ctx.fillRect(bx, bodyTop, candleW, bodyH)
      ctx.strokeRect(bx, bodyTop, candleW, bodyH)
    }

    // Last price line
    const last = visible[n - 1]
    const ly   = yOf(last.close)
    const isUp = last.close >= last.open
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = isUp ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke()
    ctx.setLineDash([])

    // Price badge
    const badgeColor = isUp ? '#26a69a' : '#ef5350'
    ctx.fillStyle = badgeColor
    const badge = fmtPrice(last.close, pipSize)
    const bw = badge.length * 6.5 + 12
    ctx.fillRect(W - padR + 1, ly - 9, bw, 18)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 10px monospace'
    ctx.textAlign = 'left'
    ctx.fillText(badge, W - padR + 6, ly + 4)

  }, [candles, pipSize, granularity])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const obs = new ResizeObserver(draw)
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [draw])

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {candles.length < 2 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.8rem' }}>
          Loading chart data…
        </div>
      )}
    </div>
  )
}

/* ─── Tick Line Canvas ───────────────────────────────────────────────────────── */
function TickChart({ prices, times, pipSize }: {
  prices: number[]; times: number[]; pipSize: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || prices.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const W   = container.clientWidth
    const H   = container.clientHeight
    canvas.width  = W * dpr
    canvas.height = H * dpr
    canvas.style.width  = W + 'px'
    canvas.style.height = H + 'px'
    ctx.scale(dpr, dpr)

    const padL = 12, padR = 72, padT = 14, padB = 28
    const cW = W - padL - padR
    const cH = H - padT - padB

    ctx.fillStyle = '#060d18'
    ctx.fillRect(0, 0, W, H)

    // Use last 500 visible points max
    const maxPts = Math.min(prices.length, 500)
    const vis    = prices.slice(-maxPts)
    const visTimes = times.slice(-maxPts)
    const n      = vis.length

    let lo = Math.min(...vis), hi = Math.max(...vis)
    const range = hi - lo || 1
    const pad = range * 0.1
    lo -= pad; hi += pad
    const xOf = (i: number) => padL + (i / (n - 1)) * cW
    const yOf = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * cH

    // Grid + price labels
    for (let i = 0; i <= 5; i++) {
      const y = padT + (i / 5) * cH
      const v = hi - (i / 5) * (hi - lo)
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(fmtPrice(v, pipSize), W - padR + 5, y + 4)
    }

    // Time labels
    const labelEvery = Math.max(1, Math.floor(n / 5))
    for (let i = 0; i < n; i++) {
      if (i % labelEvery !== 0) continue
      const x = xOf(i)
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + cH); ctx.stroke()
      if (visTimes[i]) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        ctx.font = '9px monospace'
        ctx.textAlign = 'center'
        ctx.fillText(fmtTime(visTimes[i], 0), x, padT + cH + 18)
      }
    }

    // Area fill
    const grad = ctx.createLinearGradient(0, padT, 0, padT + cH)
    grad.addColorStop(0, 'rgba(252,163,17,0.18)')
    grad.addColorStop(1, 'rgba(252,163,17,0.01)')
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(vis[0]))
    for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(vis[i]))
    ctx.lineTo(xOf(n - 1), padT + cH)
    ctx.lineTo(xOf(0), padT + cH)
    ctx.closePath()
    ctx.fillStyle = grad; ctx.fill()

    // Line
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(vis[0]))
    for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(vis[i]))
    ctx.strokeStyle = '#FCA311'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke()

    // Last price line + badge
    const last = vis[n - 1]
    const ly   = yOf(last)
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = 'rgba(252,163,17,0.4)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#FCA311'
    const badge = fmtPrice(last, pipSize)
    const bw = badge.length * 6.5 + 12
    ctx.fillRect(W - padR + 1, ly - 9, bw, 18)
    ctx.fillStyle = '#000'
    ctx.font = 'bold 10px monospace'
    ctx.textAlign = 'left'
    ctx.fillText(badge, W - padR + 6, ly + 4)

    // Dot on last point
    ctx.beginPath(); ctx.arc(xOf(n - 1), ly, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#FCA311'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()

  }, [prices, times, pipSize])

  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    const obs = new ResizeObserver(draw)
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [draw])

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {prices.length < 2 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.8rem' }}>
          Loading tick data…
        </div>
      )}
    </div>
  )
}

/* ─── Main Page ─────────────────────────────────────────────────────────────── */
export default function ChartsPage() {
  const [symbol,    setSymbol]    = useState('1HZ100V')
  const [tfIdx,     setTfIdx]     = useState(0)  // index into TIMEFRAMES
  const [candles,   setCandles]   = useState<Candle[]>([])
  const [prices,    setPrices]    = useState<number[]>([])
  const [times,     setTimes]     = useState<number[]>([])
  const [pipSize,   setPipSize]   = useState(2)
  const [connected, setConnected] = useState(false)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [priceDir,  setPriceDir]  = useState<'up' | 'down' | null>(null)

  const wsRef      = useRef<WebSocket | null>(null)
  const prevPrice  = useRef<number | null>(null)
  const tf         = TIMEFRAMES[tfIdx]
  const isTickMode = tf.granularity === 0

  // Connect / reconnect whenever symbol or timeframe changes
  useEffect(() => {
    setConnected(false)
    setCandles([])
    setPrices([])
    setTimes([])
    setLivePrice(null)
    prevPrice.current = null

    const ws = new WebSocket(PUBLIC_WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      if (isTickMode) {
        ws.send(JSON.stringify({
          ticks_history: symbol,
          end: 'latest',
          count: 1000,
          style: 'ticks',
          subscribe: 1,
          req_id: 1,
        }))
      } else {
        ws.send(JSON.stringify({
          ticks_history: symbol,
          end: 'latest',
          count: 200,
          style: 'candles',
          granularity: tf.granularity,
          subscribe: 1,
          req_id: 2,
        }))
      }
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      const ps = (msg as { pip_size?: number }).pip_size
      if (ps != null) setPipSize(ps)

      // ── Tick history (initial batch) ──
      if (msg.msg_type === 'history') {
        type H = { history: { prices: number[]; times: number[] } }
        const h = (msg as unknown as H).history
        const ps2 = ps ?? pipSize
        void ps2
        const nums = h.prices.map(Number)
        const ts   = h.times.map(Number)
        setPrices(nums)
        setTimes(ts)
        setLivePrice(nums[nums.length - 1] ?? null)
        prevPrice.current = nums[nums.length - 1] ?? null
      }

      // ── Live tick update ──
      if (msg.msg_type === 'tick') {
        type T = { tick: { quote: number; epoch: number; pip_size?: number } }
        const t = (msg as unknown as T).tick
        const q = Number(t.quote)
        const e = Number(t.epoch)
        const prev = prevPrice.current
        setPriceDir(prev == null ? null : q > prev ? 'up' : q < prev ? 'down' : null)
        prevPrice.current = q
        setLivePrice(q)
        setPrices(prev => { const n = [...prev, q]; return n.length > 2000 ? n.slice(-2000) : n })
        setTimes(prev => { const n = [...prev, e]; return n.length > 2000 ? n.slice(-2000) : n })
      }

      // ── Candles (initial batch) ──
      if (msg.msg_type === 'candles') {
        type C = { candles: Array<{ epoch: number; open: string; high: string; low: string; close: string }> }
        const arr = (msg as unknown as C).candles
        const parsed: Candle[] = arr.map(c => ({
          epoch: Number(c.epoch),
          open:  Number(c.open),
          high:  Number(c.high),
          low:   Number(c.low),
          close: Number(c.close),
        }))
        setCandles(parsed)
        const last = parsed[parsed.length - 1]
        if (last) { setLivePrice(last.close); prevPrice.current = last.close }
      }

      // ── Live OHLC update (current candle forming) ──
      // ohlc.open_time = epoch of candle start; if newer than last candle → new candle
      if (msg.msg_type === 'ohlc') {
        type O = { ohlc: { open: string; high: string; low: string; close: string; open_time: string; epoch: string } }
        const o = (msg as unknown as O).ohlc
        const newCandle: Candle = {
          epoch: Number(o.open_time),
          open:  Number(o.open),
          high:  Number(o.high),
          low:   Number(o.low),
          close: Number(o.close),
        }
        const q = newCandle.close
        const prev = prevPrice.current
        setPriceDir(prev == null ? null : q > prev ? 'up' : q < prev ? 'down' : null)
        prevPrice.current = q
        setLivePrice(q)
        setCandles(prev => {
          if (!prev.length) return [newCandle]
          const last = prev[prev.length - 1]
          if (newCandle.epoch === last.epoch) {
            // Update current candle
            return [...prev.slice(0, -1), newCandle]
          } else if (newCandle.epoch > last.epoch) {
            // New candle started
            return [...prev, newCandle]
          }
          return prev
        })
      }
    }

    ws.onerror = () => setConnected(false)
    ws.onclose = () => { setConnected(false); wsRef.current = null }

    return () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ forget_all: isTickMode ? 'ticks' : 'candles', req_id: 99 }))
        }
      } catch { /**/ }
      ws.close()
      wsRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfIdx])

  const market = MARKETS.find(m => m.symbol === symbol)

  // Price change since first visible tick / open of first visible candle
  const priceColor = priceDir === 'up' ? '#26a69a' : priceDir === 'down' ? '#ef5350' : '#FCA311'

  return (
    <div style={{ background: '#060d18', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Top toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
        padding: '0.55rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#07101f', flexShrink: 0,
      }}>

        {/* Market selector */}
        <select
          value={symbol}
          onChange={e => setSymbol(e.target.value)}
          style={{
            background: '#0d1829', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '6px', color: '#fff', fontSize: '0.78rem', fontWeight: 600,
            padding: '0.32rem 0.55rem', cursor: 'pointer', outline: 'none',
          }}
        >
          {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
        </select>

        {/* Divider */}
        <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

        {/* Timeframe pills */}
        <div style={{ display: 'flex', gap: '2px', background: 'rgba(255,255,255,0.04)', borderRadius: '7px', padding: '3px' }}>
          {TIMEFRAMES.map((tf, i) => (
            <button key={tf.label} onClick={() => setTfIdx(i)} style={{
              padding: '0.2rem 0.5rem', borderRadius: '5px', border: 'none',
              background: tfIdx === i ? 'rgba(252,163,17,0.18)' : 'transparent',
              color: tfIdx === i ? '#FCA311' : 'rgba(229,229,229,0.4)',
              fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer',
              transition: 'all 0.12s',
              outline: tfIdx === i ? '1px solid rgba(252,163,17,0.35)' : 'none',
            }}>
              {tf.label}
            </button>
          ))}
        </div>

        {/* Live price */}
        {livePrice != null && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {market?.label}
            </span>
            <span style={{
              fontSize: '1.15rem', fontWeight: 800,
              color: priceColor,
              fontVariantNumeric: 'tabular-nums', lineHeight: 1,
              transition: 'color 0.2s',
            }}>
              {fmtPrice(livePrice, pipSize)}
            </span>
          </div>
        )}

        {/* Connection dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginLeft: livePrice != null ? '0' : 'auto' }}>
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
            background: connected ? '#22c55e' : '#666',
            boxShadow: connected ? '0 0 5px #22c55e88' : 'none',
            animation: connected ? 'pulse 2s ease infinite' : 'none',
          }} />
          <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)' }}>
            {connected ? 'Live' : 'Connecting…'}
          </span>
        </div>
      </div>

      {/* ── Chart area ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0' }}>
        {isTickMode
          ? <TickChart prices={prices} times={times} pipSize={pipSize} />
          : <CandleChart candles={candles} pipSize={pipSize} granularity={tf.granularity} />
        }
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
      `}</style>
    </div>
  )
}
