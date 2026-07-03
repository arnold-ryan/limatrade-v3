'use client'

/**
 * Lima Trade — Charts Page v82
 *
 * Brand-new layout (nothing reused from v77-v81 UI):
 *
 *   ┌──────────────────────────────────────────┬────────────────┐
 *   │  chart overlay bar (symbol, price, TF)   │                │
 *   │                                          │   TRADE PANEL  │
 *   │         LIGHTWEIGHT-CHARTS CANVAS        │  (type, dur,   │
 *   │                                          │   stake, both  │
 *   │                                          │   proposals)   │
 *   ├──────────────────────────────────────────┴────────────────┤
 *   │             POSITIONS / HISTORY  (bottom panel)           │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Two-WebSocket architecture (unchanged from v80/v81 — confirmed correct):
 *   PUBLIC  wss://api.derivws.com/trading/v1/options/ws/public  → ticks, history, symbols
 *   AUTH    OTP URL from /api/user/ws-url                       → balance, proposals, buy, POC
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart, IChartApi, UTCTimestamp,
  ISeriesApi, LineData, CandlestickData, AreaData,
} from 'lightweight-charts'

// ─── Constants ────────────────────────────────────────────────────────────────
const PUB_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'

const TT = [
  { id: 'OU', label: 'Over / Under',   ctA: 'DIGITOVER',  ctB: 'DIGITUNDER', lA: 'Over',  lB: 'Under',  cA: '#22c55e', cB: '#3b82f6', barrier: true  },
  { id: 'EO', label: 'Even / Odd',     ctA: 'DIGITEVEN',  ctB: 'DIGITODD',   lA: 'Even',  lB: 'Odd',    cA: '#22c55e', cB: '#a855f7', barrier: false },
  { id: 'MD', label: 'Match / Differ', ctA: 'DIGITMATCH', ctB: 'DIGITDIFF',  lA: 'Match', lB: 'Differ', cA: '#22c55e', cB: '#ef4444', barrier: true  },
  { id: 'RF', label: 'Rise / Fall',    ctA: 'CALL',       ctB: 'PUT',        lA: 'Rise',  lB: 'Fall',   cA: '#22c55e', cB: '#ef4444', barrier: false },
]

const TFS = [
  { label: '1T', gran: 0     },
  { label: '1m', gran: 60    },
  { label: '5m', gran: 300   },
  { label: '15m',gran: 900   },
  { label: '1h', gran: 3600  },
  { label: '4h', gran: 14400 },
  { label: '1D', gran: 86400 },
]

// ─── Types ────────────────────────────────────────────────────────────────────
interface Sym  { symbol: string; name: string; pip: number; dp: number; group: string; open: boolean }
interface Prop { id: string; ask: number; payout: number; err?: string }
interface Pos  {
  id: number; ct: string; side: 'A'|'B'; ttId: string
  lA: string; lB: string; cA: string; cB: string
  stake: number; payout: number; bid: number; profit: number
  status: 'open'|'won'|'lost'|'sold'; barrier?: string; ts: number
}

// ─── Static fallback markets (shown when active_symbols WS hasn't responded) ──
const FALLBACK_MARKETS: Sym[] = [
  { symbol: 'R_10',     name: 'Volatility 10 Index',       pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: 'R_25',     name: 'Volatility 25 Index',       pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: 'R_50',     name: 'Volatility 50 Index',       pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: 'R_75',     name: 'Volatility 75 Index',       pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: 'R_100',    name: 'Volatility 100 Index',      pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: '1HZ10V',   name: 'Volatility 10 (1s) Index',  pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: '1HZ25V',   name: 'Volatility 25 (1s) Index',  pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: '1HZ50V',   name: 'Volatility 50 (1s) Index',  pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: '1HZ75V',   name: 'Volatility 75 (1s) Index',  pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: '1HZ100V',  name: 'Volatility 100 (1s) Index', pip: 0.001,   dp: 3, group: 'Volatility Indices', open: true },
  { symbol: 'BOOM500',  name: 'Boom 500 Index',            pip: 0.01,    dp: 2, group: 'Crash/Boom Indices', open: true },
  { symbol: 'BOOM1000', name: 'Boom 1000 Index',           pip: 0.01,    dp: 2, group: 'Crash/Boom Indices', open: true },
  { symbol: 'CRASH500', name: 'Crash 500 Index',           pip: 0.01,    dp: 2, group: 'Crash/Boom Indices', open: true },
  { symbol: 'CRASH1000',name: 'Crash 1000 Index',          pip: 0.01,    dp: 2, group: 'Crash/Boom Indices', open: true },
  { symbol: 'stpRNG',   name: 'Step Index',                pip: 0.1,     dp: 1, group: 'Step Indices',       open: true },
  { symbol: 'JD10',     name: 'Jump 10 Index',             pip: 0.001,   dp: 3, group: 'Jump Indices',       open: true },
  { symbol: 'JD25',     name: 'Jump 25 Index',             pip: 0.001,   dp: 3, group: 'Jump Indices',       open: true },
  { symbol: 'JD50',     name: 'Jump 50 Index',             pip: 0.001,   dp: 3, group: 'Jump Indices',       open: true },
  { symbol: 'JD75',     name: 'Jump 75 Index',             pip: 0.001,   dp: 3, group: 'Jump Indices',       open: true },
  { symbol: 'JD100',    name: 'Jump 100 Index',            pip: 0.001,   dp: 3, group: 'Jump Indices',       open: true },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────
const f2  = (n: number) => n.toFixed(2)
const fdp = (n: number, dp: number) => n.toFixed(dp)
const lastDigit = (p: number, dp: number) => Math.abs(Math.round(p * 10 ** dp)) % 10
const sma = (arr: number[], n: number) =>
  arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n)

// ─── Digit frequency bar ─────────────────────────────────────────────────────
function DigitBar({ freqs, last }: { freqs: number[]; last: number | null }) {
  const total = freqs.reduce((a, b) => a + b, 0)
  const COLORS = ['#9ca3af','#22c55e','#ef4444','#f97316','#eab308','#3b82f6','#a78bfa','#ec4899','#14b8a6','#60a5fa']
  const SZ = 58, CX = 29, CY = 27, R = 21, SW = 3.5

  function arc(pct: number) {
    // bottom-half semicircle gauge: left point → clockwise through bottom → right point
    const startX = CX - R, endX = CX + R, Y = CY
    if (pct <= 0) return ''
    if (pct >= 99.9) return `M ${startX} ${Y} A ${R} ${R} 0 0 1 ${endX} ${Y}`
    const angle = (180 + pct * 1.8) * (Math.PI / 180)
    const x = (CX + R * Math.cos(angle)).toFixed(2)
    const y = (CY + R * Math.sin(angle)).toFixed(2)
    return `M ${startX} ${Y} A ${R} ${R} 0 0 1 ${x} ${y}`
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '0 10px' }}>
      {[0,1,2,3,4,5,6,7,8,9].map(d => {
        const pct = total > 0 ? (freqs[d] / total) * 100 : 0
        const isLast = d === last
        const col = COLORS[d]
        return (
          <div key={d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: SZ, height: SZ, borderRadius: '50%', position: 'relative',
              background: 'rgba(6,14,28,0.88)', border: `1.5px solid ${isLast ? col : 'rgba(255,255,255,0.12)'}`,
              boxShadow: isLast ? `0 0 8px ${col}55` : 'none' }}>
              <svg width={SZ} height={SZ} viewBox={`0 0 ${SZ} ${SZ}`} style={{ position: 'absolute', inset: 0 }}>
                <path d={`M ${CX-R} ${CY} A ${R} ${R} 0 0 1 ${CX+R} ${CY}`}
                  fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={SW} strokeLinecap="round" />
                {pct > 0 && <path d={arc(pct)} fill="none" stroke={col} strokeWidth={SW} strokeLinecap="round"
                  style={{ transition: 'all 0.35s ease' }} />}
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', paddingBottom: '2px' }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 800, lineHeight: 1,
                  color: isLast ? col : 'rgba(229,229,229,0.85)' }}>{d}</span>
                <span style={{ fontSize: '0.47rem', lineHeight: 1.3, fontVariantNumeric: 'tabular-nums',
                  color: isLast ? col : 'rgba(229,229,229,0.4)' }}>
                  {total > 0 ? pct.toFixed(1)+'%' : '0%'}
                </span>
              </div>
            </div>
            <div style={{ height: '10px', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '2px' }}>
              {isLast && <div style={{ width: 0, height: 0,
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderBottom: '7px solid #ef4444' }} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ChartsPage() {

  // ── Market ──────────────────────────────────────────────────────────────────
  const [symbol,  setSymbol]  = useState('R_100')
  const [syms,    setSyms]    = useState<Sym[]>([])
  const [symsOk,  setSymsOk]  = useState(false)
  const [mktOpen, setMktOpen] = useState(false)
  const [mktQ,    setMktQ]    = useState('')
  const symbolRef = useRef(symbol)
  useEffect(() => { symbolRef.current = symbol }, [symbol])
  const curSym = syms.find(s => s.symbol === symbol) ?? FALLBACK_MARKETS.find(s => s.symbol === symbol)
  const dp     = curSym?.dp ?? 2
  const dpRef  = useRef(dp)
  useEffect(() => { dpRef.current = dp }, [dp])

  // ── Chart config ────────────────────────────────────────────────────────────
  const [tfIdx,     setTfIdx]     = useState(0)
  const [chartType, setChartType] = useState<'area'|'line'|'candles'>('area')
  const [maOn,      setMaOn]      = useState(false)
  const [maPeriod,  setMaPeriod]  = useState(20)
  const tf      = TFS[tfIdx]
  const isTick  = tf.gran === 0
  const tfIdxRef    = useRef(tfIdx)
  const maOnRef     = useRef(maOn)
  const maPeriodRef = useRef(maPeriod)
  const isTickRef   = useRef(isTick)
  useEffect(() => { tfIdxRef.current    = tfIdx     }, [tfIdx])
  useEffect(() => { maOnRef.current     = maOn      }, [maOn])
  useEffect(() => { maPeriodRef.current = maPeriod  }, [maPeriod])
  useEffect(() => { isTickRef.current   = isTick    }, [isTick])

  // ── Price ───────────────────────────────────────────────────────────────────
  const [price,    setPrice]    = useState<number|null>(null)
  const [priceDir, setPriceDir] = useState<'up'|'dn'|null>(null)
  const [digitFreq, setDigitFreq] = useState<number[]>(Array(10).fill(0))
  const [lastDig,   setLastDig]   = useState<number|null>(null)
  const [delta,    setDelta]    = useState(0)
  const prevRef = useRef<number|null>(null)

  // ── Trading state ────────────────────────────────────────────────────────────
  const [ttIdx,   setTtIdx]   = useState(0)
  const [dur,     setDur]     = useState(5)
  const [stake,   setStake]   = useState('1.00')
  const [barrier, setBarrier] = useState(5)
  const [propA,   setPropA]   = useState<Prop|null>(null)
  const [propB,   setPropB]   = useState<Prop|null>(null)
  const [buyingA, setBuyingA] = useState(false)
  const [buyingB, setBuyingB] = useState(false)
  const [buyErr,  setBuyErr]  = useState<string|null>(null)
  const [openPos, setOpenPos] = useState<Pos[]>([])
  const [closed,  setClosed]  = useState<Pos[]>([])
  const [posTabs, setPosTabs] = useState<'open'|'history'>('open')
  const tt = TT[ttIdx]
  const ttRef      = useRef(tt)
  const stakeRef   = useRef(stake)
  const durRef     = useRef(dur)
  const barrierRef = useRef(barrier)
  const propARef   = useRef<Prop|null>(null)
  const propBRef   = useRef<Prop|null>(null)
  useEffect(() => { ttRef.current      = tt      }, [tt])
  useEffect(() => { stakeRef.current   = stake   }, [stake])
  useEffect(() => { durRef.current     = dur     }, [dur])
  useEffect(() => { barrierRef.current = barrier }, [barrier])
  useEffect(() => { propARef.current   = propA   }, [propA])
  useEffect(() => { propBRef.current   = propB   }, [propB])

  // ── Auth WS state ────────────────────────────────────────────────────────────
  const [authKey,   setAuthKey]   = useState(0)
  const [authReady, setAuthReady] = useState(false)
  const [balance,   setBalance]   = useState<number|null>(null)
  const [currency,  setCurrency]  = useState('USD')
  const [wsErr,     setWsErr]     = useState<string|null>(null)
  const currencyRef = useRef('USD')
  useEffect(() => { currencyRef.current = currency }, [currency])

  // ── Pub WS state ─────────────────────────────────────────────────────────────
  const [live, setLive] = useState(false)

  // ── WS + Chart refs ──────────────────────────────────────────────────────────
  const pubRef    = useRef<WebSocket|null>(null)
  const authRef   = useRef<WebSocket|null>(null)
  const chartRef  = useRef<IChartApi|null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const areaR     = useRef<ISeriesApi<'Area'>|null>(null)
  const lineR     = useRef<ISeriesApi<'Line'>|null>(null)
  const candleR   = useRef<ISeriesApi<'Candlestick'>|null>(null)
  const maR       = useRef<ISeriesApi<'Line'>|null>(null)
  const prices    = useRef<number[]>([])
  const times     = useRef<UTCTimestamp[]>([])
  const curCandleRef = useRef<CandlestickData|null>(null)
  const reqId     = useRef(100)
  const buyMapA   = useRef<Map<number, Pos>>(new Map())
  const buyMapB   = useRef<Map<number, Pos>>(new Map())

  // ── Account switch listener ──────────────────────────────────────────────────
  useEffect(() => {
    const h = () => {
      setPropA(null); setPropB(null)
      setBalance(null); setAuthReady(false)
      authRef.current?.close()
      setAuthKey(k => k + 1)
    }
    window.addEventListener('deriv-account-switch', h)
    return () => window.removeEventListener('deriv-account-switch', h)
  }, [])

  // ── Chart helpers ────────────────────────────────────────────────────────────
  const clearSeries = useCallback(() => {
    const c = chartRef.current; if (!c) return
    ;[areaR, lineR, candleR, maR].forEach(r => {
      if (r.current) { try { c.removeSeries(r.current) } catch {} ; r.current = null }
    })
  }, [])

  const addMA = useCallback(() => {
    if (!chartRef.current || !maOnRef.current) return
    maR.current = chartRef.current.addLineSeries({ color: '#f59e0b', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const vs = sma(prices.current, maPeriodRef.current)
    const d  = vs.map((v, i) => v !== null ? { time: times.current[i], value: v } as LineData : null).filter(Boolean) as LineData[]
    if (d.length) maR.current.setData(d)
  }, [])

  const buildSeries = useCallback(() => {
    clearSeries()
    const c = chartRef.current; if (!c) return
    const type = isTickRef.current ? 'area' : chartType
    if (type === 'area') {
      areaR.current = c.addAreaSeries({ lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.18)', bottomColor: 'rgba(252,163,17,0)', lineWidth: 2 })
      const d = times.current.map((t, i) => ({ time: t, value: prices.current[i] })) as AreaData[]
      if (d.length) areaR.current.setData(d)
      addMA()
    } else if (type === 'line') {
      lineR.current = c.addLineSeries({ color: '#FCA311', lineWidth: 2 })
      const d = times.current.map((t, i) => ({ time: t, value: prices.current[i] })) as LineData[]
      if (d.length) lineR.current.setData(d)
      addMA()
    } else {
      candleR.current = c.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
    }
  }, [chartType, clearSeries, addMA])

  const appendTick = useCallback((epoch: number, p: number) => {
    const t = epoch as UTCTimestamp
    if (isTickRef.current) {
      prices.current.push(p)
      times.current.push(t)
      if (prices.current.length > 2000) { prices.current.shift(); times.current.shift() }
      const pt = { time: t, value: p }
      areaR.current?.update(pt as AreaData)
      lineR.current?.update(pt as LineData)
      chartRef.current?.timeScale().scrollToRealTime()
      if (maR.current && maOnRef.current) {
        const n = maPeriodRef.current
        if (prices.current.length >= n) {
          const sl = prices.current.slice(-n)
          maR.current.update({ time: t, value: sl.reduce((a, b) => a + b, 0) / n } as LineData)
        }
      }
    } else {
      const gran = TFS[tfIdxRef.current].gran
      const bkt  = (Math.floor(epoch / gran) * gran) as UTCTimestamp
      const cur  = curCandleRef.current
      if (cur && cur.time === bkt) {
        const u: CandlestickData = { time: bkt, open: cur.open, high: Math.max(cur.high, p), low: Math.min(cur.low, p), close: p }
        curCandleRef.current = u; candleR.current?.update(u)
      } else {
        const nc: CandlestickData = { time: bkt, open: p, high: p, low: p, close: p }
        curCandleRef.current = nc; candleR.current?.update(nc)
      }
    }
  }, [])

  // ── subscribeProposals ───────────────────────────────────────────────────────
  const subscribeProposals = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 998 }))
    setPropA(null); setPropB(null)
    const amt = parseFloat(stakeRef.current) || 1
    const cur = ttRef.current
    const bar = cur.barrier ? String(barrierRef.current) : undefined
    const base = { proposal: 1, subscribe: 1, basis: 'stake', amount: amt, currency: currencyRef.current, underlying_symbol: symbolRef.current, duration: durRef.current, duration_unit: 't' }
    ws.send(JSON.stringify({ ...base, contract_type: cur.ctA, ...(bar ? { barrier: bar } : {}), req_id: 10 }))
    ws.send(JSON.stringify({ ...base, contract_type: cur.ctB, ...(bar ? { barrier: bar } : {}), req_id: 11 }))
  }, [])

  const requestHistory = useCallback((ws: WebSocket, sym: string, gran: number) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (gran === 0) {
      ws.send(JSON.stringify({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks', req_id: 3 }))
    } else {
      ws.send(JSON.stringify({ ticks_history: sym, count: 500, end: 'latest', style: 'candles', granularity: gran, req_id: 3 }))
    }
  }, [])

  const subscribeTicks = useCallback((ws: WebSocket, sym: string) => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 999 }))
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1, req_id: 2 }))
  }, [])

  // ── PUBLIC WebSocket ──────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket, ping: ReturnType<typeof setInterval>, dead = false
    function connect() {
      ws = new WebSocket(PUB_WS)
      pubRef.current = ws
      ws.onopen = () => {
        if (dead) return
        setLive(true)
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 }))
        subscribeTicks(ws, symbolRef.current)
        requestHistory(ws, symbolRef.current, TFS[tfIdxRef.current].gran)
        ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1, req_id: 900 })) }, 25_000)
      }
      ws.onmessage = ev => {
        if (dead) return
        let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.msg_type === 'active_symbols') {
          const list: Sym[] = (msg.active_symbols as any[]).map((s: any) => ({
            symbol: s.symbol, name: s.display_name,
            pip: s.pip, dp: Math.round(-Math.log10(s.pip)),
            group: s.submarket_display_name, open: !!s.exchange_is_open,
          }))
          setSyms(list); setSymsOk(true)
        }
        if (msg.msg_type === 'tick') {
          const t = msg.tick as { symbol: string; quote: number; epoch: number }
          if (t.symbol !== symbolRef.current) return
          const p = t.quote, prev = prevRef.current
          setPrice(p)
          if (prev !== null) { setPriceDir(p > prev ? 'up' : p < prev ? 'dn' : null); setDelta(p - prev) }
          prevRef.current = p; setLive(true)
          appendTick(t.epoch, p)
          const d = lastDigit(p, dpRef.current)
          setLastDig(d)
          setDigitFreq(prev => { const n = [...prev]; n[d]++; return n })
        }
        if (msg.msg_type === 'history' && msg.req_id === 3) {
          const h = msg.history as { times: number[]; prices: number[] }
          if (!h?.times?.length) return
          prices.current = [...h.prices]
          times.current  = h.times.map(t => t as UTCTimestamp)
          const d = h.times.map((t, i) => ({ time: t as UTCTimestamp, value: h.prices[i] }))
          areaR.current?.setData(d as AreaData[])
          lineR.current?.setData(d as LineData[])
          if (maOnRef.current && maR.current) {
            const vs = sma(h.prices, maPeriodRef.current)
            const md = vs.map((v, i) => v !== null ? { time: h.times[i] as UTCTimestamp, value: v } as LineData : null).filter(Boolean) as LineData[]
            maR.current.setData(md)
          }
        }
        if (msg.msg_type === 'candles' && msg.req_id === 3) {
          const cs = msg.candles as Array<{ epoch: number; open: number; high: number; low: number; close: number }>
          if (!cs?.length) return
          const d: CandlestickData[] = cs.map(c => ({ time: c.epoch as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
          candleR.current?.setData(d)
          curCandleRef.current = d[d.length - 1]
          prices.current = cs.map(c => c.close)
          times.current  = cs.map(c => c.epoch as UTCTimestamp)
        }
      }
      ws.onerror = () => setLive(false)
      ws.onclose = () => { setLive(false); if (!dead) setTimeout(connect, 3000) }
    }
    connect()
    return () => { dead = true; clearInterval(ping); ws?.close(); pubRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── AUTH WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket|null = null, ping: ReturnType<typeof setInterval>, dead = false, retries = 0
    async function connect() {
      try {
        const r = await fetch('/api/user/ws-url', { cache: 'no-store' })
        if (!r.ok) { setWsErr('login'); return }
        const { wsUrl } = await r.json()
        if (!wsUrl) { setWsErr('login'); return }
        ws = new WebSocket(wsUrl)
        authRef.current = ws
        ws.onopen = () => {
          if (dead) return
          retries = 0; setAuthReady(true); setWsErr(null)
          ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
          subscribeProposals(ws!)
          ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1, req_id: 901 })) }, 25_000)
        }
        ws.onmessage = ev => {
          if (dead) return
          let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
          if (msg.error?.code === 'AuthorizationRequired' || msg.error?.code === 'InvalidToken') { setWsErr('login'); ws?.close(); return }
          if (msg.msg_type === 'balance') {
            const b = msg.balance as { balance: number; currency: string }
            setBalance(b.balance); if (b.currency) setCurrency(b.currency)
            window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: b.balance, currency: b.currency } }))
          }
          if (msg.msg_type === 'proposal') {
            if (msg.error) {
              const e = msg.error.message ?? 'Error'
              // route errors by req_id as before
              if (msg.req_id === 10) setPropA({ id: '', ask: 0, payout: 0, err: e })
              if (msg.req_id === 11) setPropB({ id: '', ask: 0, payout: 0, err: e })
              return
            }
            const p = msg.proposal as { id: string; ask_price: number; payout: number; contract_type: string }
            const prop: Prop = { id: p.id, ask: p.ask_price, payout: p.payout }
            const cur = ttRef.current
            // Route by contract_type from response — reliable regardless of arrival order or stale updates
            if (p.contract_type === cur.ctA) setPropA(prop)
            else if (p.contract_type === cur.ctB) setPropB(prop)
          }
          if (msg.msg_type === 'buy') {
            const rid = msg.req_id as number
            const isA = buyMapA.current.has(rid)
            const map = isA ? buyMapA.current : buyMapB.current
            if (msg.error) {
              map.delete(rid)
              isA ? setBuyingA(false) : setBuyingB(false)
              setBuyErr(msg.error.message ?? 'Buy failed')
              if (ws?.readyState === WebSocket.OPEN) subscribeProposals(ws)
              return
            }
            const b = msg.buy as { contract_id: number; buy_price: number; payout: number; balance_after: number; purchase_time: number }
            const meta = map.get(rid)!; map.delete(rid)
            isA ? setBuyingA(false) : setBuyingB(false)
            setBuyErr(null); setBalance(b.balance_after)
            if (meta) {
              const pos: Pos = { ...meta, id: b.contract_id, stake: b.buy_price, payout: b.payout, bid: b.buy_price, profit: 0, status: 'open', ts: b.purchase_time }
              setOpenPos(prev => [pos, ...prev])
              if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1, req_id: ++reqId.current }))
            }
            if (ws?.readyState === WebSocket.OPEN) subscribeProposals(ws)
          }
          if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
            const poc = msg.proposal_open_contract as { contract_id: number; is_sold: number; status: string; bid_price: string; profit: string }
            const cid = poc.contract_id, settled = poc.is_sold === 1
            const bid = parseFloat(poc.bid_price ?? '0'), profit = parseFloat(poc.profit ?? '0')
            if (settled) {
              setOpenPos(prev => prev.filter(p => p.id !== cid))
              setClosed(prev => {
                const orig = prev.find(p => p.id === cid)
                const u: Pos = orig ? { ...orig, bid, profit, status: poc.status as Pos['status'] }
                  : { id: cid, ct: '', side: 'A', ttId: '', lA: '', lB: '', cA: '#22c55e', cB: '#ef4444', stake: 0, payout: 0, bid, profit, status: poc.status as Pos['status'], ts: 0 }
                return [u, ...prev.filter(p => p.id !== cid)].slice(0, 50)
              })
            } else {
              setOpenPos(prev => prev.map(p => p.id === cid ? { ...p, bid, profit, status: poc.status as Pos['status'] } : p))
            }
          }
        }
        ws.onerror = () => setAuthReady(false)
        ws.onclose = () => {
          setAuthReady(false); authRef.current = null
          if (dead) return
          retries++
          if (retries > 5) { setWsErr('lost'); return }
          setWsErr('reconnecting')
          setTimeout(connect, Math.min(retries * 2000, 10_000))
        }
      } catch { if (!dead) setTimeout(connect, 5000) }
    }
    connect()
    return () => { dead = true; clearInterval(ping); ws?.close(); authRef.current = null }
  }, [subscribeProposals, authKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Symbol change ─────────────────────────────────────────────────────────────
  useEffect(() => {
    prices.current = []; times.current = []; curCandleRef.current = null
    setPrice(null); prevRef.current = null; setLastDig(null); setDigitFreq(Array(10).fill(0))
    const pub = pubRef.current, auth = authRef.current
    if (pub?.readyState === WebSocket.OPEN) {
      subscribeTicks(pub, symbol)
      requestHistory(pub, symbol, TFS[tfIdxRef.current].gran)
    }
    if (auth?.readyState === WebSocket.OPEN) subscribeProposals(auth)
  }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── TF change ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    prices.current = []; times.current = []; curCandleRef.current = null
    const pub = pubRef.current
    if (pub?.readyState === WebSocket.OPEN) requestHistory(pub, symbolRef.current, tf.gran)
    buildSeries()
  }, [tfIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Chart type / MA ───────────────────────────────────────────────────────────
  useEffect(() => { if (chartRef.current) buildSeries() }, [chartType, maOn, maPeriod, buildSeries])

  // ── Trade params → resubscribe ────────────────────────────────────────────────
  useEffect(() => {
    const auth = authRef.current
    if (auth?.readyState === WebSocket.OPEN) subscribeProposals(auth)
  }, [ttIdx, stake, dur, barrier, subscribeProposals])

  // ── Chart init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return
    const chart = createChart(canvasRef.current, {
      layout:          { background: { color: '#050c18' }, textColor: 'rgba(200,215,235,0.5)' },
      grid:            { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      crosshair:       { mode: 0 },
      timeScale:       { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      handleScroll: true, handleScale: true,
    })
    chartRef.current = chart
    areaR.current = chart.addAreaSeries({ lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.18)', bottomColor: 'rgba(252,163,17,0)', lineWidth: 2 })
    const ro = new ResizeObserver(([e]) => chart.applyOptions({ width: e.contentRect.width, height: e.contentRect.height }))
    ro.observe(canvasRef.current)
    return () => { ro.disconnect(); try { chart.remove() } catch {}; chartRef.current = null; areaR.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Buy handler ───────────────────────────────────────────────────────────────
  const doBuy = useCallback((side: 'A'|'B') => {
    const ws = authRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (side === 'A' && buyingA) return
    if (side === 'B' && buyingB) return
    const prop = side === 'A' ? propARef.current : propBRef.current
    if (!prop?.id || prop.err) { setBuyErr('Price not ready'); return }
    const ask = Number(prop.ask)
    if (!ask || isNaN(ask)) return
    side === 'A' ? setBuyingA(true) : setBuyingB(true)
    setBuyErr(null)
    const rid = ++reqId.current
    const cur = ttRef.current
    const meta: Pos = {
      id: 0, ct: side === 'A' ? cur.ctA : cur.ctB, side,
      ttId: cur.id, lA: cur.lA, lB: cur.lB, cA: cur.cA, cB: cur.cB,
      stake: 0, payout: 0, bid: 0, profit: 0, status: 'open',
      barrier: cur.barrier ? String(barrierRef.current) : undefined, ts: 0,
    }
    ;(side === 'A' ? buyMapA : buyMapB).current.set(rid, meta)
    ws.send(JSON.stringify({ buy: prop.id, price: parseFloat((ask * 1.02).toFixed(2)), req_id: rid }))
    setTimeout(() => {
      const map = side === 'A' ? buyMapA.current : buyMapB.current
      if (map.has(rid)) { map.delete(rid); side === 'A' ? setBuyingA(false) : setBuyingB(false); setBuyErr('No response') }
    }, 12_000)
  }, [buyingA, buyingB])

  // ── Market filter ─────────────────────────────────────────────────────────────
  const activeSyms = syms.length > 0 ? syms : FALLBACK_MARKETS
  const filtered = mktQ
    ? activeSyms.filter(s => s.name.toLowerCase().includes(mktQ.toLowerCase()) || s.symbol.toLowerCase().includes(mktQ.toLowerCase()))
    : activeSyms
  const groups = filtered.reduce<Record<string, Sym[]>>((a, s) => {
    if (!a[s.group]) a[s.group] = []
    a[s.group].push(s); return a
  }, {})

  // ── Derived display values ────────────────────────────────────────────────────
  const priceColor = priceDir === 'up' ? '#22c55e' : priceDir === 'dn' ? '#ef4444' : '#e5e5e5'
  const totalPL    = [...openPos, ...closed].reduce((s, p) => s + p.profit, 0)

  // ── Proposal card renderer ────────────────────────────────────────────────────
  function ProposalCard({ side }: { side: 'A'|'B' }) {
    const prop    = side === 'A' ? propA : propB
    const buying  = side === 'A' ? buyingA : buyingB
    const label   = side === 'A' ? tt.lA : tt.lB
    const color   = side === 'A' ? tt.cA : tt.cB
    const ok      = !!prop?.id && !prop?.err && authReady
    return (
      <div style={{
        flex: 1, borderRadius: '10px', padding: '12px 10px',
        border: `1px solid ${ok ? color + '30' : 'rgba(255,255,255,0.07)'}`,
        background: ok ? color + '08' : 'rgba(255,255,255,0.02)',
        display: 'flex', flexDirection: 'column', gap: '6px',
        transition: 'all 0.15s',
      }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 800, color: ok ? color : 'rgba(229,229,229,0.35)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}
        </div>
        {prop?.err ? (
          <div style={{ fontSize: '0.6rem', color: '#ef4444', lineHeight: 1.4 }}>{prop.err.slice(0, 60)}</div>
        ) : prop?.ask ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)' }}>Stake</span>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#e5e5e5', fontVariantNumeric: 'tabular-nums' }}>{f2(prop.ask)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)' }}>Payout</span>
              <span style={{ fontSize: '0.88rem', fontWeight: 800, color: color, fontVariantNumeric: 'tabular-nums' }}>{f2(prop.payout)}</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.2)' }}>{authReady ? 'Fetching…' : '—'}</div>
        )}
        <button
          onClick={() => doBuy(side)}
          disabled={!ok || buying}
          style={{
            marginTop: '2px', padding: '10px 4px', borderRadius: '7px', border: 'none', outline: 'none',
            background: ok && !buying ? color : 'rgba(255,255,255,0.05)',
            color:      ok && !buying ? '#fff' : 'rgba(229,229,229,0.2)',
            cursor:     ok && !buying ? 'pointer' : 'not-allowed',
            fontWeight: 800, fontSize: '0.78rem', transition: 'all 0.12s',
          }}
        >
          {buying ? '…' : `Buy ${label}`}
        </button>
      </div>
    )
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#050c18', color: '#e5e5e5', fontFamily: 'Inter,system-ui,sans-serif', fontSize: '14px', overflow: 'hidden' }}>

      {/* ── TOP ROW: chart + trade panel ───────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

        {/* ── CHART COLUMN ─────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

          {/* Chart top bar */}
          <div style={{
            height: '52px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '12px',
            padding: '0 14px', borderBottom: '1px solid rgba(255,255,255,0.05)',
            background: '#06101c',
          }}>
            {/* Symbol button */}
            <button
              onClick={() => { setMktOpen(v => !v); setMktQ('') }}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                background: mktOpen ? 'rgba(252,163,17,0.1)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${mktOpen ? 'rgba(252,163,17,0.4)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '8px', padding: '5px 10px', cursor: 'pointer', outline: 'none',
                transition: 'all 0.12s',
              }}
            >
              <span style={{
                width: '24px', height: '24px', borderRadius: '50%',
                background: 'linear-gradient(135deg,#FCA311,#c97000)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.45rem', fontWeight: 900, color: '#000', flexShrink: 0,
              }}>
                {symbol.replace(/[^A-Z0-9]/gi,'').slice(0,3).toUpperCase()}
              </span>
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#e5e5e5', lineHeight: 1.1 }}>{curSym?.name ?? symbol}</div>
                {price != null && (
                  <div style={{ fontSize: '0.72rem', fontWeight: 600, color: priceColor, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                    {fdp(price, dp)}
                    <span style={{ marginLeft: '4px', color: priceDir === 'up' ? '#22c55e' : priceDir === 'dn' ? '#ef4444' : 'rgba(229,229,229,0.3)', fontSize: '0.62rem' }}>
                      {delta >= 0 ? '+' : ''}{fdp(delta, dp)}
                    </span>
                  </div>
                )}
              </div>
              <span style={{ color: 'rgba(229,229,229,0.3)', fontSize: '0.55rem', marginLeft: '2px' }}>▾</span>
            </button>

            {/* Divider */}
            <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

            {/* Timeframe chips */}
            <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
              {TFS.map((t, i) => (
                <button key={t.label}
                  onClick={() => setTfIdx(i)}
                  style={{
                    padding: '4px 8px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                    background: tfIdx === i ? 'rgba(252,163,17,0.15)' : 'transparent',
                    color:      tfIdx === i ? '#FCA311' : 'rgba(229,229,229,0.4)',
                    fontSize:   '0.7rem', fontWeight: 700, outline: 'none',
                    transition: 'all 0.1s',
                  }}
                >{t.label}</button>
              ))}
            </div>

            {/* Divider */}
            <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

            {/* Chart type (only for non-tick) */}
            {!isTick && (
              <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                {(['area','line','candles'] as const).map(ct => (
                  <button key={ct}
                    onClick={() => setChartType(ct)}
                    style={{
                      padding: '4px 8px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                      background: chartType === ct ? 'rgba(59,130,246,0.15)' : 'transparent',
                      color:      chartType === ct ? '#60a5fa' : 'rgba(229,229,229,0.35)',
                      fontSize: '0.68rem', fontWeight: 600, outline: 'none', textTransform: 'capitalize',
                      transition: 'all 0.1s',
                    }}
                  >{ct}</button>
                ))}
              </div>
            )}

            {/* MA toggle */}
            {!isTick && (
              <>
                <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  <div
                    onClick={() => setMaOn(v => !v)}
                    style={{ width: '30px', height: '16px', borderRadius: '8px', cursor: 'pointer', background: maOn ? '#f59e0b' : 'rgba(255,255,255,0.1)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}
                  >
                    <div style={{ position: 'absolute', top: '2px', width: '12px', height: '12px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', left: maOn ? '16px' : '2px' }} />
                  </div>
                  <span style={{ fontSize: '0.64rem', color: maOn ? '#f59e0b' : 'rgba(229,229,229,0.3)', fontWeight: 600 }}>MA</span>
                  {maOn && (
                    <input type="number" min={2} max={200} value={maPeriod}
                      onChange={e => setMaPeriod(Math.max(2, Math.min(200, parseInt(e.target.value)||20)))}
                      style={{ width: '44px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', color: '#e5e5e5', padding: '3px 6px', fontSize: '0.68rem', outline: 'none' }}
                    />
                  )}
                </div>
              </>
            )}

            <div style={{ flex: 1 }} />

            {/* Live dot */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%',
                background: live ? '#22c55e' : '#555',
                boxShadow: live ? '0 0 6px #22c55e88' : 'none',
                animation: live ? 'blink 2s infinite' : 'none',
              }} />
              <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)' }}>{live ? 'Live' : 'Connecting…'}</span>
            </div>
          </div>

          {/* Chart canvas */}
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <div ref={canvasRef} style={{ width: '100%', height: '100%' }} />

            {/* Digit frequency overlay — bottom of chart */}
            {digitFreq.some(v => v > 0) && (
              <div style={{ position: 'absolute', bottom: '28px', left: 0, right: 0, zIndex: 10, pointerEvents: 'none' }}>
                <DigitBar freqs={digitFreq} last={lastDig} />
              </div>
            )}

            {/* Market drawer — slides over chart */}
            {mktOpen && (
              <>
                <div onClick={() => setMktOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.3)' }} />
                <div style={{
                  position: 'absolute', top: 0, left: 0, bottom: 0, width: '480px',
                  background: '#070f1e', borderRight: '1px solid rgba(255,255,255,0.06)',
                  display: 'flex', flexDirection: 'column', zIndex: 25,
                  boxShadow: '8px 0 40px rgba(0,0,0,0.7)',
                }}>
                  <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '10px', color: 'rgba(229,229,229,0.7)' }}>Select Market</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="rgba(200,215,235,0.35)" strokeWidth="1.3"/><path d="M8.5 8.5L11.5 11.5" stroke="rgba(200,215,235,0.35)" strokeWidth="1.3" strokeLinecap="round"/></svg>
                      <input autoFocus type="text" placeholder="Search…" value={mktQ}
                        onChange={e => setMktQ(e.target.value)}
                        style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#e5e5e5', fontSize: '0.8rem' }}
                      />
                      {mktQ && <button onClick={() => setMktQ('')} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}>×</button>}
                    </div>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '12px' }}>
                    {Object.entries(groups).map(([g, ms]) => (
                      <div key={g}>
                        <div style={{ padding: '10px 16px 4px', fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{g}</div>
                        {ms.map(m => {
                          const sel = m.symbol === symbol
                          return (
                            <button key={m.symbol}
                              onClick={() => { setSymbol(m.symbol); setMktOpen(false) }}
                              style={{
                                width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                                padding: '9px 16px', background: sel ? 'rgba(252,163,17,0.07)' : 'transparent',
                                border: 'none', borderLeft: `2px solid ${sel ? '#FCA311' : 'transparent'}`,
                                color: sel ? '#FCA311' : 'rgba(229,229,229,0.7)', cursor: 'pointer',
                                opacity: m.open ? 1 : 0.4, textAlign: 'left',
                              }}
                            >
                              <span style={{ width: '28px', height: '28px', borderRadius: '50%', background: sel ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800, flexShrink: 0 }}>
                                {m.symbol.replace(/[^A-Z0-9]/gi,'').slice(0,3).toUpperCase()}
                              </span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: '0.78rem', fontWeight: sel ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                                {!m.open && <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.28)', marginTop: '1px' }}>Closed</div>}
                              </div>
                              {sel && <span style={{ color: '#FCA311', fontSize: '0.8rem' }}>✓</span>}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                    {Object.keys(groups).length === 0 && (
                      <div style={{ padding: '3rem', textAlign: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.75rem' }}>No results</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── TRADE PANEL ──────────────────────────────────────────────────────── */}
        <div style={{
          width: '286px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          background: '#060e1c', display: 'flex', flexDirection: 'column',
        }}>

          {/* Trade type selector */}
          <div style={{ padding: '12px 14px 0', flexShrink: 0 }}>
            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Trade Type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
              {TT.map((t, i) => (
                <button key={t.id}
                  onClick={() => { setTtIdx(i); setPropA(null); setPropB(null) }}
                  style={{
                    padding: '8px 6px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                    background: ttIdx === i ? 'rgba(252,163,17,0.12)' : 'rgba(255,255,255,0.04)',
                    color:      ttIdx === i ? '#FCA311' : 'rgba(229,229,229,0.4)',
                    fontSize:   '0.68rem', fontWeight: 700, transition: 'all 0.12s',
                    outline:    ttIdx === i ? '1px solid rgba(252,163,17,0.35)' : 'none' as any,
                    textAlign: 'center',
                  }}
                >
                  <div>{t.label.split(' / ')[0]}</div>
                  <div style={{ fontSize: '0.55rem', opacity: 0.65, marginTop: '1px' }}>/ {t.label.split(' / ')[1]}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Barrier (for OU + MD) */}
          {tt.barrier && (
            <div style={{ padding: '12px 14px 0', flexShrink: 0 }}>
              <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Digit ({barrier})</div>
              <div style={{ display: 'flex', gap: '3px' }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <button key={d}
                    onClick={() => setBarrier(d)}
                    style={{
                      flex: 1, padding: '6px 2px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                      background: barrier === d ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.04)',
                      color:      barrier === d ? '#FCA311' : 'rgba(229,229,229,0.5)',
                      fontSize: '0.72rem', fontWeight: 700,
                      outline: barrier === d ? '1px solid rgba(252,163,17,0.35)' : 'none' as any,
                    }}
                  >{d}</button>
                ))}
              </div>
            </div>
          )}

          {/* Duration + Stake */}
          <div style={{ padding: '12px 14px 0', flexShrink: 0, display: 'flex', gap: '10px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '5px' }}>Duration</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input type="number" min={1} max={10} value={dur}
                  onChange={e => setDur(Math.max(1, Math.min(10, parseInt(e.target.value)||1)))}
                  style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#e5e5e5', padding: '7px 8px', fontSize: '0.78rem', outline: 'none' }}
                />
                <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.3)', flexShrink: 0 }}>t</span>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '5px' }}>Stake ({currency})</div>
              <input type="number" min="0.35" step="0.01" value={stake}
                onChange={e => setStake(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#e5e5e5', padding: '7px 8px', fontSize: '0.78rem', outline: 'none' }}
              />
            </div>
          </div>

          {/* Quick stake buttons */}
          <div style={{ padding: '6px 14px 0', flexShrink: 0, display: 'flex', gap: '3px' }}>
            {[0.5,1,2,5,10].map(v => (
              <button key={v}
                onClick={() => setStake(v.toFixed(2))}
                style={{ flex: 1, padding: '4px 2px', borderRadius: '5px', border: 'none', cursor: 'pointer', background: parseFloat(stake) === v ? 'rgba(252,163,17,0.12)' : 'rgba(255,255,255,0.04)', color: parseFloat(stake) === v ? '#FCA311' : 'rgba(229,229,229,0.35)', fontSize: '0.62rem', fontWeight: 700, outline: 'none', transition: 'all 0.1s' }}
              >{v}</button>
            ))}
          </div>

          {/* Divider */}
          <div style={{ margin: '12px 14px 0', height: '1px', background: 'rgba(255,255,255,0.05)' }} />

          {/* Proposal cards */}
          <div style={{ padding: '12px 14px 0', flexShrink: 0 }}>
            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
              {tt.label}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <ProposalCard side="A" />
              <ProposalCard side="B" />
            </div>
          </div>

          {/* Error */}
          {buyErr && (
            <div style={{ margin: '10px 14px 0', padding: '8px 10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '7px', fontSize: '0.65rem', color: '#ef4444' }}>
              ⚠ {buyErr}
            </div>
          )}

          {/* Connection warnings */}
          {wsErr === 'login' && (
            <div style={{ margin: '10px 14px 0', padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: '7px', fontSize: '0.63rem', color: 'rgba(229,229,229,0.3)', textAlign: 'center' }}>
              Login to enable trading
            </div>
          )}
          {wsErr === 'reconnecting' && (
            <div style={{ margin: '10px 14px 0', textAlign: 'center', fontSize: '0.62rem', color: '#f59e0b' }}>Reconnecting…</div>
          )}
          {wsErr === 'lost' && (
            <div style={{ margin: '10px 14px 0', textAlign: 'center', fontSize: '0.62rem', color: '#ef4444' }}>Connection lost — refresh</div>
          )}

          <div style={{ flex: 1 }} />

          {/* Auth status */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: authReady ? '#22c55e' : wsErr ? '#ef4444' : '#444', boxShadow: authReady ? '0 0 5px #22c55e88' : 'none', animation: authReady ? 'blink 2s infinite' : 'none' }} />
            <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.25)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {authReady
                ? `${currency}${balance != null ? ` · ${f2(balance)}` : ''}`
                : wsErr === 'login' ? 'Not logged in'
                : wsErr ?? 'Connecting…'}
            </span>
          </div>
        </div>
      </div>

      {/* ── BOTTOM: POSITIONS / HISTORY ────────────────────────────────────────── */}
      <div style={{ height: '196px', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.06)', background: '#060e1c', display: 'flex', flexDirection: 'column' }}>

        {/* Tab bar */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px', gap: '0', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          {([['open','Open'], ['history','History']] as const).map(([id, label]) => {
            const count = id === 'open' ? openPos.length : closed.length
            const active = posTabs === id
            return (
              <button key={id}
                onClick={() => setPosTabs(id)}
                style={{
                  padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none',
                  color:       active ? '#e5e5e5' : 'rgba(229,229,229,0.35)',
                  borderBottom: active ? '2px solid #FCA311' : '2px solid transparent',
                  fontWeight:  active ? 700 : 400, fontSize: '0.75rem',
                  display: 'flex', alignItems: 'center', gap: '6px',
                  transition: 'all 0.12s',
                }}
              >
                {label}
                {count > 0 && (
                  <span style={{ background: active ? '#FCA311' : 'rgba(255,255,255,0.12)', color: active ? '#000' : 'rgba(229,229,229,0.5)', borderRadius: '10px', padding: '1px 6px', fontSize: '0.58rem', fontWeight: 700 }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}

          {/* P&L summary */}
          {(openPos.length + closed.length) > 0 && (
            <div style={{ marginLeft: 'auto', fontSize: '0.65rem', color: 'rgba(229,229,229,0.35)', fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: '5px' }}>
              Total P&amp;L:
              <span style={{ fontWeight: 800, color: totalPL >= 0 ? '#22c55e' : '#ef4444' }}>
                {totalPL >= 0 ? '+' : ''}{f2(totalPL)}
              </span>
            </div>
          )}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {posTabs === 'open' && openPos.length === 0 && (
            <div style={{ padding: '28px', textAlign: 'center', color: 'rgba(229,229,229,0.15)', fontSize: '0.72rem' }}>No open positions</div>
          )}
          {posTabs === 'history' && closed.length === 0 && (
            <div style={{ padding: '28px', textAlign: 'center', color: 'rgba(229,229,229,0.15)', fontSize: '0.72rem' }}>No trade history</div>
          )}
          {(posTabs === 'open' ? openPos : closed).length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.02)', position: 'sticky', top: 0 }}>
                  {['Contract','Type','Stake','Payout','P&L','Status'].map(h => (
                    <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontWeight: 600, color: 'rgba(229,229,229,0.3)', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(posTabs === 'open' ? openPos : closed).map(p => {
                  const label  = p.side === 'A' ? p.lA : p.lB
                  const color  = p.side === 'A' ? p.cA : p.cB
                  const status = p.status
                  const sColor = status === 'won' ? '#22c55e' : status === 'lost' ? '#ef4444' : status === 'open' ? '#f59e0b' : 'rgba(229,229,229,0.4)'
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '7px 14px', fontVariantNumeric: 'tabular-nums', color: 'rgba(229,229,229,0.4)', fontSize: '0.62rem' }}>#{p.id}</td>
                      <td style={{ padding: '7px 14px' }}>
                        <span style={{ fontWeight: 700, color }}>
                          {label}{p.barrier ? ` ${p.barrier}` : ''}
                        </span>
                        <span style={{ marginLeft: '5px', fontSize: '0.58rem', color: 'rgba(229,229,229,0.3)' }}>{p.ttId}</span>
                      </td>
                      <td style={{ padding: '7px 14px', fontVariantNumeric: 'tabular-nums' }}>{f2(p.stake)}</td>
                      <td style={{ padding: '7px 14px', fontVariantNumeric: 'tabular-nums', color: '#22c55e' }}>{f2(p.payout)}</td>
                      <td style={{ padding: '7px 14px', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: p.profit >= 0 ? '#22c55e' : '#ef4444' }}>
                        {p.profit >= 0 ? '+' : ''}{f2(p.profit)}
                      </td>
                      <td style={{ padding: '7px 14px' }}>
                        <span style={{ color: sColor, fontWeight: 600, textTransform: 'capitalize', fontSize: '0.65rem' }}>{status}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { opacity: 0.35 }
        input::placeholder { color: rgba(229,229,229,0.18) }
        button:hover:not(:disabled) { filter: brightness(1.1) }
        ::-webkit-scrollbar { width: 3px; height: 3px }
        ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.07); border-radius: 2px }
      `}</style>
    </div>
  )
}
