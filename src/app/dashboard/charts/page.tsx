'use client'

/**
 * Lima Trade — Charts Page v84
 *
 * Layout (v82 base + 4 fixes):
 *
 *  ┌────────────────────────────────────────────────────────────────────┐
 *  │  [Asset pill ▼]  [1T][1m][5m][15m][1h][4h][1D]          • Live   │
 *  ├─────────────────┬──────────────────────────────┬───────────────────┤
 *  │                 │                              │  TRADE TYPE       │
 *  │  POSITIONS LEFT │        C H A R T             │  Over/Under  E/O  │
 *  │  (220px)        │                              │  Match/Diff  R/F  │
 *  │  Open / History │                              │  ─────────────    │
 *  │  ─────────────  │                              │  DIGIT (0-9)      │
 *  │  [table rows]   │                              │  ─────────────    │
 *  │                 │                              │  DUR  |  STAKE    │
 *  │                 │                              │  quickpicks       │
 *  │                 │                              │  ─────────────    │
 *  │                 │                              │  [BUY A]  [BUY B] │
 *  └─────────────────┴──────────────────────────────┴───────────────────┘
 *
 * Fixes vs v82:
 *   1. Market selector: retry active_symbols on open + handle wrapped responses
 *   2. Market names: R_100 → "Volatility 100", 1HZ100V → "Volatility 100 (1s)"
 *   3. Positions moved from bottom panel to left sidebar
 *   4. Smooth ticks: Date.now()/1000 timestamps + scrollToRealTime() after each update
 *
 * Two-WebSocket architecture (unchanged):
 *   PUBLIC  wss://api.derivws.com/trading/v1/options/ws/public
 *   AUTH    OTP URL from /api/user/ws-url
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart, IChartApi, UTCTimestamp,
  ISeriesApi, LineData, CandlestickData,
} from 'lightweight-charts'

// ─── Constants ────────────────────────────────────────────────────────────────
const PUB_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'

const TRADE_TYPES = [
  { id: 'OU', label: 'Over / Under',   ctA: 'DIGITOVER',  ctB: 'DIGITUNDER', lA: 'Over',  lB: 'Under',  cA: '#22c55e', cB: '#3b82f6', barrier: true  },
  { id: 'EO', label: 'Even / Odd',     ctA: 'DIGITEVEN',  ctB: 'DIGITODD',   lA: 'Even',  lB: 'Odd',    cA: '#22c55e', cB: '#a855f7', barrier: false },
  { id: 'MD', label: 'Match / Differ', ctA: 'DIGITMATCH', ctB: 'DIGITDIFF',  lA: 'Match', lB: 'Differ', cA: '#22c55e', cB: '#ef4444', barrier: true  },
  { id: 'RF', label: 'Rise / Fall',    ctA: 'CALL',       ctB: 'PUT',        lA: 'Rise',  lB: 'Fall',   cA: '#22c55e', cB: '#ef4444', barrier: false },
]

const TFS = [
  { label: '1T',  gran: 0     },
  { label: '1m',  gran: 60    },
  { label: '5m',  gran: 300   },
  { label: '15m', gran: 900   },
  { label: '1h',  gran: 3600  },
  { label: '4h',  gran: 14400 },
  { label: '1D',  gran: 86400 },
]

const STAKE_PICKS = [0.5, 1, 2, 5, 10]

// ─── Types ────────────────────────────────────────────────────────────────────
interface Sym { symbol: string; name: string; dp: number; group: string; open: boolean }
interface Prop { id: string; ask: number; payout: number }
interface Pos {
  id: number; ct: string; side: 'A'|'B'; ttId: string
  lA: string; lB: string; cA: string; cB: string
  stake: number; payout: number; profit: number
  status: 'open'|'won'|'lost'; barrier?: string; ts: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const f2  = (n: number) => n.toFixed(2)
const fdp = (n: number, dp: number) => n.toFixed(dp)

/** Rename R_100 → "Volatility 100", 1HZ100V → "Volatility 100 (1s)" */
function normalizeName(symbol: string, apiName: string): string {
  // If the API already gives a proper name, use it
  if (apiName && !/^R_\d+$/.test(apiName) && !/^1HZ/.test(apiName)) return apiName
  const rMatch = symbol.match(/^R_(\d+)$/)
  if (rMatch) return `Volatility ${rMatch[1]}`
  const hzMatch = symbol.match(/^1HZ(\d+)V$/)
  if (hzMatch) return `Volatility ${hzMatch[1]} (1s)`
  return apiName || symbol
}

const sma = (arr: number[], n: number) =>
  arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n)

// ─── Component ────────────────────────────────────────────────────────────────
export default function ChartsPage() {

  // ── Market ──────────────────────────────────────────────────────────────────
  const [symbol,   setSymbol]   = useState('R_100')
  const [syms,     setSyms]     = useState<Sym[]>([])
  const [symOpen,  setSymOpen]  = useState(false)
  const [symQ,     setSymQ]     = useState('')
  const [pubReady, setPubReady] = useState(false)
  const symbolRef = useRef(symbol)
  useEffect(() => { symbolRef.current = symbol }, [symbol])
  const curSym = syms.find(s => s.symbol === symbol)
  const dp     = curSym?.dp ?? 2
  const dpRef  = useRef(dp)
  useEffect(() => { dpRef.current = dp }, [dp])

  // ── Chart config ────────────────────────────────────────────────────────────
  const [tfIdx,     setTfIdx]     = useState(0)
  const [chartType, setChartType] = useState<'area'|'line'|'candles'>('area')
  const [maOn,      setMaOn]      = useState(false)
  const tf     = TFS[tfIdx]
  const isTick = tf.gran === 0
  const tfIdxRef  = useRef(tfIdx)
  const maOnRef   = useRef(maOn)
  const isTickRef = useRef(isTick)
  useEffect(() => { tfIdxRef.current  = tfIdx  }, [tfIdx])
  useEffect(() => { maOnRef.current   = maOn   }, [maOn])
  useEffect(() => { isTickRef.current = isTick }, [isTick])

  // ── Price ───────────────────────────────────────────────────────────────────
  const [price,    setPrice]    = useState<number|null>(null)
  const [prevDelta, setPrevDelta] = useState<number|null>(null)
  const prevPriceRef = useRef<number|null>(null)

  // ── Trade state ─────────────────────────────────────────────────────────────
  const [ttIdx,   setTtIdx]   = useState(0)
  const [barrier, setBarrier] = useState(5)
  const [tickDur, setTickDur] = useState(1)
  const [stake,   setStake]   = useState('10.00')
  const tt = TRADE_TYPES[ttIdx]
  const ttRef = useRef(tt)
  useEffect(() => { ttRef.current = tt }, [tt])

  // ── Proposals ───────────────────────────────────────────────────────────────
  const [propA,   setPropA]   = useState<Prop|null>(null)
  const [propB,   setPropB]   = useState<Prop|null>(null)
  const [buyingA, setBuyingA] = useState(false)
  const [buyingB, setBuyingB] = useState(false)
  const buyingARef = useRef(buyingA)
  const buyingBRef = useRef(buyingB)
  useEffect(() => { buyingARef.current = buyingA }, [buyingA])
  useEffect(() => { buyingBRef.current = buyingB }, [buyingB])

  // ── Auth / Balance ──────────────────────────────────────────────────────────
  const [balance,   setBalance]   = useState<number|null>(null)
  const [currency,  setCurrency]  = useState('USD')
  const [authReady, setAuthReady] = useState(false)
  const [authErr,   setAuthErr]   = useState<string|null>(null)
  const [authKey,   setAuthKey]   = useState(0)

  // ── Positions ───────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<Pos[]>([])
  const [posTab,    setPosTab]    = useState<'open'|'history'>('open')

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const chartEl      = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi|null>(null)
  const seriesRef    = useRef<ISeriesApi<any>|null>(null)
  const maRef        = useRef<ISeriesApi<'Line'>|null>(null)
  const pubRef       = useRef<WebSocket|null>(null)
  const authRef      = useRef<WebSocket|null>(null)
  const pricesRef    = useRef<number[]>([])
  const tsRef        = useRef<number[]>([])
  const propTimerRef = useRef<ReturnType<typeof setTimeout>|null>(null)
  const retrySymRef  = useRef<ReturnType<typeof setTimeout>|null>(null)

  // ── Account-switch listener ───────────────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════════════════════
  // Chart setup
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!chartEl.current) return
    const chart = createChart(chartEl.current, {
      layout:    { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid:      { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#21262d' },
      timeScale: {
        borderColor:      '#21262d',
        timeVisible:      true,
        secondsVisible:   false,
        rightOffset:      10,       // space after last bar for smooth tracking
        barSpacing:       6,
        fixLeftEdge:      false,
        lockVisibleTimeRangeOnResize: true,
      },
    })
    chartRef.current = chart
    const obs = new ResizeObserver(() => {
      if (chartEl.current) chart.resize(chartEl.current.offsetWidth, chartEl.current.offsetHeight)
    })
    obs.observe(chartEl.current)
    return () => { obs.disconnect(); chart.remove(); chartRef.current = null }
  }, [])

  // ── Rebuild series ────────────────────────────────────────────────────────
  const rebuildSeries = useCallback((
    type: 'area'|'line'|'candles', ma: boolean,
    prices: number[], times: number[],
  ) => {
    const chart = chartRef.current
    if (!chart) return
    if (seriesRef.current) { try { chart.removeSeries(seriesRef.current) } catch {} seriesRef.current = null }
    if (maRef.current)     { try { chart.removeSeries(maRef.current)     } catch {} maRef.current     = null }

    if (type === 'candles') {
      seriesRef.current = chart.addCandlestickSeries({
        upColor: '#3fb950', downColor: '#f85149',
        borderUpColor: '#3fb950', borderDownColor: '#f85149',
        wickUpColor: '#3fb950', wickDownColor: '#f85149',
      })
    } else if (type === 'area') {
      seriesRef.current = chart.addAreaSeries({
        lineColor: '#e6b429', topColor: 'rgba(230,180,41,0.28)',
        bottomColor: 'rgba(230,180,41,0)', lineWidth: 2,
      })
    } else {
      seriesRef.current = chart.addLineSeries({ color: '#e6b429', lineWidth: 2 })
    }

    if (ma && prices.length >= 20) {
      const maS = chart.addLineSeries({ color: '#58a6ff', lineWidth: 1, lineStyle: 2 })
      maRef.current = maS
      const vals = sma(prices, 20)
      maS.setData(vals.map((v, i) => v !== null ? { time: times[i] as UTCTimestamp, value: v } : null).filter(Boolean) as LineData[])
    }
  }, [])

  // ══════════════════════════════════════════════════════════════════════════
  // Load tick history
  // ══════════════════════════════════════════════════════════════════════════
  const loadHistory = useCallback((sym: string, gran: number) => {
    const ws = pubRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const end   = Math.floor(Date.now() / 1000)
    const start = gran > 0 ? end - gran * 500 : end - 3600
    if (gran > 0) {
      ws.send(JSON.stringify({ ticks_history: sym, granularity: gran, style: 'candles', start, end, count: 500 }))
    } else {
      ws.send(JSON.stringify({ ticks_history: sym, style: 'ticks', start, end, count: 500 }))
    }
  }, [])

  // ══════════════════════════════════════════════════════════════════════════
  // Public WS — market data
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let ws: WebSocket
    let alive = true

    const requestSymbols = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }))
      }
    }

    const connect = () => {
      ws = new WebSocket(PUB_WS)
      pubRef.current = ws

      ws.onopen = () => {
        if (!alive) return
        setPubReady(true)
        requestSymbols()
        ws.send(JSON.stringify({ ticks: symbolRef.current, subscribe: 1 }))
        loadHistory(symbolRef.current, TFS[tfIdxRef.current].gran)
        // Retry symbols after 4s in case first request was dropped
        retrySymRef.current = setTimeout(() => {
          setSyms(prev => {
            if (prev.length === 0) requestSymbols()
            return prev
          })
        }, 4000)
      }

      ws.onmessage = (e) => {
        if (!alive) return
        const msg = JSON.parse(e.data)
        const sym = symbolRef.current

        // ── active_symbols — handle multiple wrapping formats ────────────
        const rawSymbols: any[] | null =
          Array.isArray(msg.active_symbols)   ? msg.active_symbols   :
          Array.isArray(msg.data?.active_symbols) ? msg.data.active_symbols :
          Array.isArray(msg.data)             ? msg.data             :
          null

        if (rawSymbols && rawSymbols.length > 0) {
          const list: Sym[] = rawSymbols.map((s: any) => ({
            symbol: s.symbol ?? s.instrument_id ?? '',
            name:   normalizeName(
              s.symbol ?? s.instrument_id ?? '',
              s.display_name ?? s.name ?? ''
            ),
            dp:     s.pip ? (String(s.pip).split('.')[1]?.length ?? 2) : 2,
            group:  s.submarket_display_name ?? s.market_display_name ?? s.market ?? 'Other',
            open:   s.exchange_is_open === 1 || s.is_open === true || s.exchange_is_open === true,
          })).filter(x => x.symbol)
          setSyms(list)
        }

        // ── live tick ────────────────────────────────────────────────────
        if (msg.tick && msg.tick.symbol === sym) {
          const p  = msg.tick.quote as number
          const ts = (Date.now() / 1000) as UTCTimestamp   // sub-second smooth

          setPrice(prev => {
            const delta = prev !== null ? p - prev : 0
            setPrevDelta(delta)
            prevPriceRef.current = prev
            return p
          })

          if (isTickRef.current && seriesRef.current) {
            pricesRef.current.push(p)
            tsRef.current.push(ts)
            try {
              ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).update({ time: ts, value: p })
              // Smooth scroll: keep chart tracking real-time
              chartRef.current?.timeScale().scrollToRealTime()
            } catch {}

            if (maOnRef.current && maRef.current && pricesRef.current.length >= 20) {
              const vals = pricesRef.current
              const avg  = vals.slice(-20).reduce((a, b) => a + b, 0) / 20
              try { maRef.current.update({ time: ts, value: avg }) } catch {}
            }
          }
        }

        // ── candles history ──────────────────────────────────────────────
        if (msg.candles && !isTickRef.current && seriesRef.current) {
          const data = (msg.candles as any[]).map(c => ({
            time:  c.epoch as UTCTimestamp,
            open:  c.open, high: c.high, low: c.low, close: c.close,
          }))
          pricesRef.current = data.map(c => c.close)
          tsRef.current     = data.map(c => c.time)
          try {
            if (chartType === 'candles') {
              ;(seriesRef.current as ISeriesApi<'Candlestick'>).setData(data as CandlestickData[])
            } else {
              ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).setData(
                data.map(c => ({ time: c.time, value: c.close }))
              )
            }
            chartRef.current?.timeScale().scrollToRealTime()
          } catch {}
          if (maOnRef.current && maRef.current && pricesRef.current.length >= 20) {
            const vals = sma(pricesRef.current, 20)
            try {
              maRef.current.setData(
                vals.map((v, i) => v !== null ? { time: tsRef.current[i] as UTCTimestamp, value: v } : null)
                    .filter(Boolean) as LineData[]
              )
            } catch {}
          }
        }

        // ── tick history ─────────────────────────────────────────────────
        if (msg.history && isTickRef.current && seriesRef.current) {
          const prices = (msg.history.prices as number[]) ?? []
          const times  = (msg.history.times  as number[]) ?? []
          pricesRef.current = prices
          tsRef.current     = times
          try {
            ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).setData(
              prices.map((p, i) => ({ time: times[i] as UTCTimestamp, value: p }))
            )
            chartRef.current?.timeScale().scrollToRealTime()
          } catch {}
          if (maOnRef.current && maRef.current && prices.length >= 20) {
            const vals = sma(prices, 20)
            try {
              maRef.current.setData(
                vals.map((v, i) => v !== null ? { time: times[i] as UTCTimestamp, value: v } : null)
                    .filter(Boolean) as LineData[]
              )
            } catch {}
          }
        }
      }

      ws.onclose = () => {
        if (alive) { setPubReady(false); setTimeout(connect, 2000) }
      }
    }

    connect()
    return () => {
      alive = false
      if (retrySymRef.current) clearTimeout(retrySymRef.current)
      ws?.close()
    }
  }, [loadHistory, chartType]) // eslint-disable-line

  // ── Re-subscribe when symbol / TF changes ────────────────────────────────
  useEffect(() => {
    const ws = pubRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'ticks' }))
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }))
    pricesRef.current = []; tsRef.current = []
    rebuildSeries(chartType, maOn, [], [])
    loadHistory(symbol, tf.gran)
  }, [symbol, tfIdx]) // eslint-disable-line

  // ── Rebuild on chart type / MA toggle ────────────────────────────────────
  useEffect(() => {
    rebuildSeries(chartType, maOn, pricesRef.current, tsRef.current)
    loadHistory(symbol, tf.gran)
  }, [chartType, maOn]) // eslint-disable-line

  // ══════════════════════════════════════════════════════════════════════════
  // Auth WS — balance, proposals, buy
  // ══════════════════════════════════════════════════════════════════════════
  const subscribeProposals = useCallback(() => {
    const ws  = authRef.current
    const stk = parseFloat(stake) || 1
    const cur = ttRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'proposal' }))
    setPropA(null); setPropB(null)

    const base: Record<string, unknown> = {
      proposal: 1, subscribe: 1,
      amount: stk, basis: 'stake',
      currency: currency || 'USD',
      symbol: symbolRef.current,
      duration: tickDur,
      duration_unit: 't',
    }
    if (cur.barrier) base.barrier = barrier

    ws.send(JSON.stringify({ ...base, contract_type: cur.ctA }))
    ws.send(JSON.stringify({ ...base, contract_type: cur.ctB }))
  }, [stake, tickDur, barrier, currency, tt]) // eslint-disable-line

  useEffect(() => {
    let ws: WebSocket
    let alive = true

    const connect = async () => {
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) { setAuthErr('Not logged in'); return }
        const { wsUrl } = await r.json()
        ws = new WebSocket(wsUrl)
        authRef.current = ws

        ws.onopen = () => {
          if (!alive) return
          ws.send(JSON.stringify({ balance: 1, subscribe: 1 }))
          setAuthReady(true); setAuthErr(null)
        }

        ws.onmessage = (e) => {
          if (!alive) return
          const msg = JSON.parse(e.data)

          if (msg.balance) {
            setBalance(msg.balance.balance)
            setCurrency(msg.balance.currency ?? 'USD')
          }

          if (msg.proposal) {
            const p   = msg.proposal
            const cur = ttRef.current
            const isA = p.contract_type === cur.ctA
            const prop: Prop = { id: p.id, ask: p.ask_price, payout: p.payout }
            if (isA) setPropA(prop); else setPropB(prop)
          }

          if (msg.buy) {
            const b = msg.buy
            ws.send(JSON.stringify({ forget_all: 'proposal' }))
            const cur = ttRef.current
            const isA = buyingARef.current
            setPositions(ps => [...ps, {
              id: b.contract_id,
              ct: b.contract_type,
              side: isA ? 'A' : 'B', ttId: cur.id,
              lA: cur.lA, lB: cur.lB, cA: cur.cA, cB: cur.cB,
              stake: parseFloat(stake),
              payout: b.buy_price ?? 0,
              profit: 0, status: 'open',
              barrier: cur.barrier ? String(barrier) : undefined,
              ts: Date.now(),
            }])
            setBuyingA(false); setBuyingB(false)
            setTimeout(() => subscribeProposals(), 300)
            ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 }))
          }

          if (msg.proposal_open_contract) {
            const poc = msg.proposal_open_contract
            if (poc.is_sold || poc.status === 'sold') {
              const status = poc.profit >= 0 ? 'won' : 'lost'
              setPositions(ps => ps.map(p => p.id === poc.contract_id
                ? { ...p, status, profit: poc.profit ?? 0 } : p))
            } else {
              setPositions(ps => ps.map(p => p.id === poc.contract_id
                ? { ...p, profit: poc.profit ?? p.profit } : p))
            }
          }
        }

        ws.onclose = () => { if (alive) { setAuthReady(false); setTimeout(connect, 3000) } }
      } catch { setAuthErr('Auth error') }
    }

    connect()
    return () => { alive = false; ws?.close() }
  }, [authKey]) // eslint-disable-line

  // ── Subscribe proposals when ready / params change ────────────────────────
  useEffect(() => {
    if (!authReady) return
    if (propTimerRef.current) clearTimeout(propTimerRef.current)
    propTimerRef.current = setTimeout(subscribeProposals, 400)
  }, [authReady, subscribeProposals])

  // ── Buy ──────────────────────────────────────────────────────────────────
  const buy = useCallback((side: 'A'|'B') => {
    const ws   = authRef.current
    const prop = side === 'A' ? propA : propB
    if (!ws || !prop || buyingARef.current || buyingBRef.current) return
    if (side === 'A') setBuyingA(true); else setBuyingB(true)
    ws.send(JSON.stringify({ buy: prop.id, price: +(prop.ask * 1.02).toFixed(2) }))
  }, [propA, propB])

  // ── Derived ──────────────────────────────────────────────────────────────
  const openPos   = positions.filter(p => p.status === 'open')
  const closedPos = positions.filter(p => p.status !== 'open')
  const totalPnl  = closedPos.reduce((a, p) => a + p.profit, 0)

  const filteredSyms = syms.filter(s =>
    !symQ || s.name.toLowerCase().includes(symQ.toLowerCase()) ||
             s.symbol.toLowerCase().includes(symQ.toLowerCase())
  )
  const symGroups = filteredSyms.reduce<Record<string, Sym[]>>((acc, s) => {
    ;(acc[s.group] = acc[s.group] || []).push(s)
    return acc
  }, {})

  // ─── Colors ───────────────────────────────────────────────────────────────
  const bg0    = '#0d1117'
  const bg1    = '#161b22'
  const bg2    = '#21262d'
  const bdr    = '#30363d'
  const txt0   = '#f0f6fc'
  const txt1   = '#8b949e'
  const txt2   = '#484f58'
  const amber  = '#e6b429'
  const green  = '#3fb950'
  const red    = '#f85149'
  const blue   = '#58a6ff'
  const purple = '#bc8cff'

  // ═════════════════════════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: bg0, fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ══ TOP BAR ══════════════════════════════════════════════════════ */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 12px', height: 44, background: bg1,
        borderBottom: `1px solid ${bdr}`, flexShrink: 0, position: 'relative',
      }}>

        {/* Asset pill */}
        <button
          onClick={() => setSymOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 10px 5px 6px',
            background: symOpen ? bg2 : 'transparent',
            border: `1px solid ${symOpen ? amber : bdr}`,
            borderRadius: 8, cursor: 'pointer', color: txt0,
          }}
        >
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: amber, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontWeight: 800, color: '#000',
          }}>
            {(curSym?.name ?? symbol).slice(0, 3).toUpperCase()}
          </div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>
              {curSym?.name ?? symbol}
            </div>
            {price !== null && (
              <div style={{ fontSize: 11, lineHeight: 1.4, display: 'flex', gap: 4 }}>
                <span style={{ color: prevDelta && prevDelta > 0 ? '#4ade80' : prevDelta && prevDelta < 0 ? '#f87171' : txt1 }}>
                  {fdp(price, dp)}
                </span>
                {prevDelta !== null && prevDelta !== 0 && (
                  <span style={{ color: prevDelta > 0 ? '#4ade80' : '#f87171', fontSize: 10 }}>
                    {prevDelta > 0 ? '+' : ''}{fdp(prevDelta, dp)}
                  </span>
                )}
              </div>
            )}
          </div>
          <span style={{ color: txt2, fontSize: 10, marginLeft: 2 }}>▾</span>
        </button>

        {/* Symbol dropdown */}
        {symOpen && (
          <div style={{
            position: 'absolute', top: 48, left: 12, zIndex: 200,
            width: 280, background: bg1,
            border: `1px solid ${bdr}`, borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            maxHeight: 400, display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}`, flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: txt0, marginBottom: 8 }}>Select Market</div>
              <input
                autoFocus
                value={symQ}
                onChange={e => setSymQ(e.target.value)}
                placeholder="Search..."
                style={{
                  width: '100%', background: bg2, border: `1px solid ${bdr}`,
                  borderRadius: 6, padding: '6px 10px', color: txt0,
                  fontSize: 12, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {!pubReady ? (
                <div style={{ padding: '20px 12px', color: txt2, fontSize: 12, textAlign: 'center' }}>
                  Connecting to market data…
                </div>
              ) : syms.length === 0 ? (
                <div style={{ padding: '20px 12px', color: txt2, fontSize: 12, textAlign: 'center' }}>
                  Loading markets…
                </div>
              ) : filteredSyms.length === 0 ? (
                <div style={{ padding: '20px 12px', color: txt2, fontSize: 12, textAlign: 'center' }}>
                  No markets found
                </div>
              ) : (
                Object.entries(symGroups).map(([grp, items]) => (
                  <div key={grp}>
                    <div style={{ padding: '8px 12px 4px', fontSize: 10, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {grp}
                    </div>
                    {items.map(s => (
                      <button
                        key={s.symbol}
                        onClick={() => { setSymbol(s.symbol); setSymOpen(false); setSymQ('') }}
                        style={{
                          width: '100%', padding: '8px 12px',
                          background: s.symbol === symbol ? bg2 : 'transparent',
                          border: 'none', textAlign: 'left',
                          color: s.open ? txt0 : txt2, fontSize: 12,
                          cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
                        }}
                      >
                        <span>{s.name}</span>
                        {!s.open && <span style={{ fontSize: 10, color: red }}>closed</span>}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TF chips */}
        <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
          {TFS.map((t, i) => (
            <button
              key={t.label}
              onClick={() => setTfIdx(i)}
              style={{
                padding: '4px 9px', fontSize: 11, fontWeight: 600,
                background: tfIdx === i ? bg2 : 'transparent',
                border: `1px solid ${tfIdx === i ? amber : 'transparent'}`,
                borderRadius: 5, color: tfIdx === i ? amber : txt1,
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Chart type */}
        <div style={{ display: 'flex', gap: 2, marginLeft: 4, background: bg2, borderRadius: 6, padding: 2 }}>
          {(['area','line','candles'] as const).map(ct => (
            <button
              key={ct}
              onClick={() => setChartType(ct)}
              style={{
                padding: '3px 8px', fontSize: 10, fontWeight: 600,
                background: chartType === ct ? bdr : 'transparent',
                border: 'none', borderRadius: 4,
                color: chartType === ct ? txt0 : txt1, cursor: 'pointer',
              }}
            >
              {ct === 'area' ? '◿' : ct === 'line' ? '╱' : '▭'}
            </button>
          ))}
        </div>

        {/* MA toggle */}
        <button
          onClick={() => setMaOn(v => !v)}
          style={{
            padding: '3px 8px', fontSize: 10, fontWeight: 600,
            background: maOn ? '#f59e0b22' : 'transparent',
            border: `1px solid ${maOn ? '#f59e0b' : 'transparent'}`,
            borderRadius: 4, color: maOn ? '#f59e0b' : txt1, cursor: 'pointer',
          }}
        >
          MA
        </button>

        <div style={{ flex: 1 }} />

        {/* Balance */}
        {balance !== null && (
          <div style={{ fontSize: 12, color: txt1, marginRight: 8 }}>
            <span style={{ color: txt2 }}>{currency} </span>
            <span style={{ color: txt0, fontWeight: 600 }}>{f2(balance)}</span>
          </div>
        )}

        {/* Live dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: authReady ? green : amber,
            boxShadow: authReady ? `0 0 6px ${green}` : 'none',
          }} />
          <span style={{ fontSize: 10, color: txt1 }}>
            {authReady ? 'Live' : authErr ?? 'Connecting…'}
          </span>
        </div>
      </div>

      {/* ══ MAIN ROW ═════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

        {/* ── LEFT: POSITIONS PANEL ──────────────────────────────────── */}
        <aside style={{
          width: 220, minWidth: 220,
          background: bg1, borderRight: `1px solid ${bdr}`,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${bdr}`, flexShrink: 0, height: 38 }}>
            {(['open','history'] as const).map(tab => {
              const count = tab === 'open' ? openPos.length : closedPos.length
              return (
                <button
                  key={tab}
                  onClick={() => setPosTab(tab)}
                  style={{
                    flex: 1, height: '100%', fontSize: 11, fontWeight: 600,
                    background: 'transparent',
                    borderBottom: posTab === tab ? `2px solid ${amber}` : '2px solid transparent',
                    border: 'none', cursor: 'pointer',
                    color: posTab === tab ? txt0 : txt1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  }}
                >
                  <span style={{ textTransform: 'capitalize' }}>
                    {tab === 'open' ? 'Open' : 'History'}
                  </span>
                  {count > 0 && (
                    <span style={{
                      background: tab === 'open' ? amber : bg2,
                      color: tab === 'open' ? '#000' : txt1,
                      borderRadius: 10, padding: '0 5px', fontSize: 9, fontWeight: 700,
                    }}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* P&L strip */}
          {posTab === 'history' && closedPos.length > 0 && (
            <div style={{ padding: '6px 10px', borderBottom: `1px solid ${bdr}`, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: txt2 }}>Total P&L </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: totalPnl >= 0 ? green : red }}>
                {totalPnl >= 0 ? '+' : ''}{f2(totalPnl)} {currency}
              </span>
            </div>
          )}

          {/* Positions list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {(posTab === 'open' ? openPos : closedPos).length === 0 ? (
              <div style={{ textAlign: 'center', color: txt2, fontSize: 11, paddingTop: 32 }}>
                {posTab === 'open' ? 'No open positions' : 'No trade history'}
              </div>
            ) : (
              (posTab === 'open' ? openPos : closedPos).map(p => (
                <div key={p.id} style={{
                  padding: '8px 10px', borderBottom: `1px solid ${bdr}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                      background: p.side === 'A' ? p.cA + '22' : p.cB + '22',
                      color: p.side === 'A' ? p.cA : p.cB,
                    }}>
                      {p.side === 'A' ? p.lA : p.lB}{p.barrier ? ` ${p.barrier}` : ''}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
                      background:
                        p.status === 'open' ? '#1c2d40' :
                        p.status === 'won'  ? '#1a3a1a' : '#3a1a1a',
                      color:
                        p.status === 'open' ? blue :
                        p.status === 'won'  ? green : red,
                    }}>
                      {p.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: txt2 }}>Stake</span>
                    <span style={{ color: txt1 }}>{f2(p.stake)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: txt2 }}>P&L</span>
                    <span style={{ fontWeight: 600, color: p.profit >= 0 ? green : red }}>
                      {p.profit >= 0 ? '+' : ''}{f2(p.profit)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── CENTER: CHART ──────────────────────────────────────────── */}
        <div ref={chartEl} style={{ flex: 1, minWidth: 0, minHeight: 0 }} />

        {/* ── RIGHT: TRADE PANEL ─────────────────────────────────────── */}
        <aside style={{
          width: 290, minWidth: 290,
          background: bg1, borderLeft: `1px solid ${bdr}`,
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto', overflowX: 'hidden',
        }}>

          {/* TRADE TYPE */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}` }}>
            <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Trade Type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {TRADE_TYPES.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => { setTtIdx(i); setPropA(null); setPropB(null) }}
                  style={{
                    padding: '7px 4px', fontSize: 11, fontWeight: 600,
                    background: ttIdx === i ? bg2 : 'transparent',
                    border: `1px solid ${ttIdx === i ? amber : bdr}`,
                    borderRadius: 6, cursor: 'pointer',
                    color: ttIdx === i ? amber : txt1,
                    textAlign: 'center', lineHeight: 1.4,
                  }}
                >
                  <div>{t.lA} /</div>
                  <div>{t.lB}</div>
                </button>
              ))}
            </div>
          </div>

          {/* DIGIT barrier */}
          {tt.barrier && (
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}` }}>
              <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                Digit ({barrier})
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <button
                    key={d}
                    onClick={() => setBarrier(d)}
                    style={{
                      flex: 1, height: 28, fontSize: 11, fontWeight: 700,
                      background: barrier === d ? amber : bg2,
                      border: `1px solid ${barrier === d ? amber : bdr}`,
                      borderRadius: 4, color: barrier === d ? '#000' : txt1,
                      cursor: 'pointer',
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* DURATION + STAKE side by side */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}` }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Duration</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <input
                    type="number" min="1" max="10"
                    value={tickDur}
                    onChange={e => setTickDur(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                    style={{
                      width: '100%', background: bg0, border: `1px solid ${bdr}`,
                      borderRadius: '4px 0 0 4px', padding: '6px 8px',
                      color: txt0, fontSize: 13, fontWeight: 600, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <button onClick={() => setTickDur(d => Math.min(10, d+1))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderBottom: `0.5px solid ${bdr}`, borderRadius: '0 4px 0 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▲</button>
                    <button onClick={() => setTickDur(d => Math.max(1,  d-1))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderTop: `0.5px solid ${bdr}`,    borderRadius: '0 0 4px 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▼</button>
                  </div>
                </div>
                <div style={{ fontSize: 10, color: txt2, marginTop: 3 }}>ticks</div>
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Stake ({currency || 'USD'})</div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <input
                    type="number" min="0.35" step="0.01"
                    value={stake}
                    onChange={e => setStake(e.target.value)}
                    style={{
                      width: '100%', background: bg0, border: `1px solid ${bdr}`,
                      borderRadius: '4px 0 0 4px', padding: '6px 8px',
                      color: txt0, fontSize: 13, fontWeight: 600, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <button onClick={() => setStake(s => f2(+(+s+1)))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderBottom: `0.5px solid ${bdr}`, borderRadius: '0 4px 0 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▲</button>
                    <button onClick={() => setStake(s => f2(Math.max(0.35, +s-1)))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderTop: `0.5px solid ${bdr}`, borderRadius: '0 0 4px 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▼</button>
                  </div>
                </div>
                {/* Quick picks */}
                <div style={{ display: 'flex', gap: 2, marginTop: 5 }}>
                  {STAKE_PICKS.map(v => (
                    <button
                      key={v}
                      onClick={() => setStake(f2(v))}
                      style={{
                        flex: 1, padding: '3px 0', fontSize: 9, fontWeight: 700,
                        background: stake === f2(v) ? bg2 : 'transparent',
                        border: `1px solid ${bdr}`, borderRadius: 3,
                        color: stake === f2(v) ? txt0 : txt2, cursor: 'pointer',
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* BUY BUTTONS with proposal cards */}
          <div style={{ padding: '10px 12px', flex: 1 }}>
            <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {tt.label}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>

              {/* Side A */}
              <div style={{ flex: 1 }}>
                <div style={{
                  background: bg2, border: `1px solid ${bdr}`, borderRadius: 6,
                  padding: '8px 10px', marginBottom: 6,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: tt.cA, marginBottom: 5 }}>
                    {tt.lA.toUpperCase()}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontSize: 10, color: txt2 }}>Stake</span>
                    <span style={{ fontSize: 11, color: txt1, fontWeight: 600 }}>{stake}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 10, color: txt2 }}>Payout</span>
                    <span style={{ fontSize: 11, color: propA ? green : txt2, fontWeight: 700 }}>
                      {propA ? f2(propA.payout) : '—'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => buy('A')}
                  disabled={!propA || buyingA || buyingB}
                  style={{
                    width: '100%', padding: '9px 0', fontSize: 12, fontWeight: 700,
                    background: propA && !buyingA ? tt.cA : '#1a2e1a',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: propA && !buyingA ? 'pointer' : 'not-allowed',
                    opacity: propA ? 1 : 0.5,
                    transition: 'background 0.15s',
                  }}
                >
                  {buyingA ? '…' : `Buy ${tt.lA}`}
                </button>
              </div>

              {/* Side B */}
              <div style={{ flex: 1 }}>
                <div style={{
                  background: bg2, border: `1px solid ${bdr}`, borderRadius: 6,
                  padding: '8px 10px', marginBottom: 6,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: tt.cB, marginBottom: 5 }}>
                    {tt.lB.toUpperCase()}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontSize: 10, color: txt2 }}>Stake</span>
                    <span style={{ fontSize: 11, color: txt1, fontWeight: 600 }}>{stake}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 10, color: txt2 }}>Payout</span>
                    <span style={{ fontSize: 11, color: propB ? green : txt2, fontWeight: 700 }}>
                      {propB ? f2(propB.payout) : '—'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => buy('B')}
                  disabled={!propB || buyingA || buyingB}
                  style={{
                    width: '100%', padding: '9px 0', fontSize: 12, fontWeight: 700,
                    background: propB && !buyingB ? tt.cB : '#1a1a2e',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: propB && !buyingB ? 'pointer' : 'not-allowed',
                    opacity: propB ? 1 : 0.5,
                    transition: 'background 0.15s',
                  }}
                >
                  {buyingB ? '…' : `Buy ${tt.lB}`}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
