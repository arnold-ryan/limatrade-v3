'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts'

/* ─── API Constants ──────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'
const MAX_RECONNECT  = 5
const MAX_PRICES     = 1000

/* ─── Timeframes — valid granularities per ticks_history API schema ──────── */
const TIMEFRAMES = [
  { label: '1T',  granularity: 0     },  // style:'ticks'
  { label: '1m',  granularity: 60    },
  { label: '5m',  granularity: 300   },
  { label: '15m', granularity: 900   },
  { label: '30m', granularity: 1800  },
  { label: '1h',  granularity: 3600  },
  { label: '4h',  granularity: 14400 },
  { label: '1D',  granularity: 86400 },
]

const CHART_TYPES = [
  { id: 'area',    label: 'Area'    },
  { id: 'candles', label: 'Candles' },
  { id: 'line',    label: 'Line'    },
] as const
type ChartType = 'area' | 'candles' | 'line'

/* ─── Trading panel contract types ───────────────────────────────────────── */
// req_id 10 → side A, req_id 11 → side B
const TRADE_TYPES = [
  {
    id: 'OU', label: 'Over/Under',
    ctA: 'DIGITOVER',  ctB: 'DIGITUNDER',
    labelA: 'Over',    labelB: 'Under',
    colorA: '#22c55e', colorB: '#3b82f6',
    hasDigit: true,    durationUnit: 't' as const,
  },
  {
    id: 'EO', label: 'Even/Odd',
    ctA: 'DIGITEVEN',  ctB: 'DIGITODD',
    labelA: 'Even',    labelB: 'Odd',
    colorA: '#FCA311', colorB: '#6366f1',
    hasDigit: false,   durationUnit: 't' as const,
  },
  {
    id: 'MD', label: 'Match/Differ',
    ctA: 'DIGITMATCH', ctB: 'DIGITDIFF',
    labelA: 'Match',   labelB: 'Differ',
    colorA: '#ef4444', colorB: '#a855f7',
    hasDigit: true,    durationUnit: 't' as const,
  },
  {
    id: 'RF', label: 'Rise/Fall',
    ctA: 'CALL',       ctB: 'PUT',
    labelA: 'Rise',    labelB: 'Fall',
    colorA: '#22c55e', colorB: '#ef4444',
    hasDigit: false,   durationUnit: 't' as const,
  },
]

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface ActiveSymbol {
  underlying_symbol:      string
  underlying_symbol_name: string
  market:                 string
  submarket:              string
  pip_size:               number
  exchange_is_open:       0 | 1
}
interface SymbolGroup {
  submarket:   string
  displayName: string
  symbols:     ActiveSymbol[]
}
interface Proposal {
  id:        string
  ask_price: number
  payout:    number
  error?:    string
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function formatSubmarket(sub: string): string {
  const map: Record<string, string> = {
    random_1hz_index: 'Volatility (1s) Indices',
    random_index:     'Volatility Indices',
    crash_index:      'Crash/Boom Indices',
    jump_daily:       'Jump Indices',
    step_index:       'Step Indices',
    random_daily:     'Daily Reset Indices',
  }
  return map[sub] ?? sub.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function fmt(p: number, d: number) { return p.toFixed(d) }
function fmt2(n: number) { return n.toFixed(2) }

/** Compute last-digit frequency counts from an array of prices. */
function computeDigitCounts(prices: number[], pip: number): number[] {
  const counts = Array(10).fill(0) as number[]
  for (const p of prices) {
    const s = p.toFixed(pip)
    const d = parseInt(s[s.length - 1], 10)
    if (!isNaN(d) && d >= 0 && d <= 9) counts[d]++
  }
  return counts
}

const DEFAULT_SYMBOL = '1HZ100V'

/* ─── Shared styles ──────────────────────────────────────────────────────── */
const toolbarBtn: React.CSSProperties = {
  width: '44px', height: '44px', background: 'transparent', border: 'none',
  color: 'rgba(200,215,235,0.5)', cursor: 'pointer', outline: 'none',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', gap: '2px', borderRadius: '4px', flexShrink: 0,
}

/* ─── SVG Icons ──────────────────────────────────────────────────────────── */
function IcArea() {
  return (
    <svg width="22" height="20" viewBox="0 0 22 20" fill="none">
      <path d="M2 16 L6 10 L10 13 L15 5 L20 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2 16 L6 10 L10 13 L15 5 L20 8 L20 16 Z" fill="currentColor" fillOpacity="0.12"/>
    </svg>
  )
}
function IcCandles() {
  return (
    <svg width="22" height="20" viewBox="0 0 22 20" fill="none">
      <rect x="3" y="6" width="4" height="8" rx="0.5" fill="currentColor" fillOpacity="0.75"/>
      <line x1="5" y1="3" x2="5" y2="6" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="5" y1="14" x2="5" y2="17" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="9" y="4" width="4" height="6" rx="0.5" fill="currentColor" fillOpacity="0.45"/>
      <line x1="11" y1="2" x2="11" y2="4" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="11" y1="10" x2="11" y2="13" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="15" y="7" width="4" height="7" rx="0.5" fill="currentColor" fillOpacity="0.75"/>
      <line x1="17" y1="4" x2="17" y2="7" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="17" y1="14" x2="17" y2="17" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  )
}
function IcLine() {
  return (
    <svg width="22" height="20" viewBox="0 0 22 20" fill="none">
      <path d="M2 15 L7 8 L12 11 L17 5 L20 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IcIndicators() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M2 17 L6 11 L10 14 L14 7 L18 10 L20 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="18" cy="5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.3"/>
      <line x1="18" y1="7.5" x2="18" y2="10" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  )
}
function IcDrawing() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M14 3L19 8L7 20L2 20L2 15Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
      <path d="M11.5 5.5L16.5 10.5" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  )
}
function IcDownload() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M11 3V14M7 10L11 14L15 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 18L3 20L19 20L19 18" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  )
}
function IcDropdown({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d={open ? 'M3 8L6 5L9 8' : 'M3 4L6 7L9 4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

/* ─── Main Page ─────────────────────────────────────────────────────────── */
export default function ChartsPage() {

  /* ── Chart UI state ── */
  const [symbol,         setSymbol]         = useState(DEFAULT_SYMBOL)
  const [tfIdx,          setTfIdx]          = useState(0)
  const [chartType,      setChartType]      = useState<ChartType>('area')
  const [connected,      setConnected]      = useState(false)
  const [livePrice,      setLivePrice]      = useState<number | null>(null)
  const [priceChange,    setPriceChange]    = useState(0)
  const [priceDir,       setPriceDir]       = useState<'up' | 'down' | null>(null)
  const [pipSize,        setPipSize]        = useState(2)
  const [showMkt,        setShowMkt]        = useState(false)
  const [mktSearch,      setMktSearch]      = useState('')
  const [showChartMenu,  setShowChartMenu]  = useState(false)
  const [crosshair,      setCrosshair]      = useState(true)
  const [symbolGroups,   setSymbolGroups]   = useState<SymbolGroup[]>([])
  const [loadingSymbols, setLoadingSymbols] = useState(true)

  /* ── Digit analysis state ── */
  const [prices,   setPrices]   = useState<number[]>([])
  const [digitPip, setDigitPip] = useState(2)

  /* ── Trading panel state ── */
  const [tradeTypeIdx, setTradeTypeIdx] = useState(0)
  const [sideA,        setSideA]        = useState(true)
  const [digit,        setDigit]        = useState(5)
  const [stake,        setStake]        = useState('1.00')
  const [duration,     setDuration]     = useState(1)
  const [propA,        setPropA]        = useState<Proposal | null>(null)
  const [propB,        setPropB]        = useState<Proposal | null>(null)
  const [buying,       setBuying]       = useState<'A' | 'B' | null>(null)
  const [wsReady,      setWsReady]      = useState(false)
  const [wsError,      setWsError]      = useState<string | null>(null)
  const [currency,     setCurrency]     = useState('USD')

  /* ── Refs (chart) ── */
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef          = useRef<IChartApi | null>(null)
  const seriesRef         = useRef<ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null)
  const prevPriceRef      = useRef<number | null>(null)
  const firstPriceRef     = useRef<number | null>(null)

  /* ── Refs (auth WS) ── */
  const botWsRef          = useRef<WebSocket | null>(null)
  const reqIdRef          = useRef(500)
  const buyReqMap         = useRef<Map<number, 'A' | 'B'>>(new Map())
  const reconnectCount    = useRef(0)
  const reconnectTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalClose  = useRef(false)
  const propARef          = useRef<Proposal | null>(null)
  const propBRef          = useRef<Proposal | null>(null)

  /* ── Stable refs for WS callbacks (avoids stale closures) ── */
  const symbolRef        = useRef(DEFAULT_SYMBOL)
  const tradeTypeIdxRef  = useRef(0)
  const digitRef         = useRef(5)
  const stakeRef         = useRef('1.00')
  const durationRef      = useRef(1)
  const currencyRef      = useRef('USD')

  // Sync refs from state on every render
  symbolRef.current       = symbol
  tradeTypeIdxRef.current = tradeTypeIdx
  digitRef.current        = digit
  stakeRef.current        = stake
  durationRef.current     = duration
  currencyRef.current     = currency
  propARef.current        = propA
  propBRef.current        = propB

  /* ── Derived ── */
  const tf           = TIMEFRAMES[tfIdx]
  const isTickMode   = tf.granularity === 0
  const effectiveType: ChartType = isTickMode ? 'area' : chartType
  const allSymbols   = symbolGroups.flatMap(g => g.symbols)
  const activeSymbol = allSymbols.find(s => s.underlying_symbol === symbol)
  const pip          = activeSymbol?.pip_size ?? pipSize
  const currentTT    = TRADE_TYPES[tradeTypeIdx]
  const digitCounts  = computeDigitCounts(prices, digitPip)
  const digitTotal   = prices.length
  const activeProp   = sideA ? propA : propB
  const activeColor  = sideA ? currentTT.colorA : currentTT.colorB

  const priceColor  = priceDir === 'up' ? '#22c55e' : priceDir === 'down' ? '#ef4444' : 'rgba(229,229,229,0.9)'
  const changeColor = priceChange >= 0 ? '#22c55e' : '#ef4444'
  const changePct   = firstPriceRef.current ? (priceChange / firstPriceRef.current) * 100 : 0

  /* ────────────────────────────────────────────────────────────────────────
     Effect 1: Fetch active_symbols on mount (one-time WS)
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => ws.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 }))
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }
      if (msg.msg_type === 'active_symbols') {
        type AS = { active_symbols: ActiveSymbol[] }
        const syms = (msg as unknown as AS).active_symbols
        const grouped: Record<string, SymbolGroup> = {}
        for (const s of syms) {
          if (s.market !== 'synthetic_index') continue
          if (!grouped[s.submarket]) {
            grouped[s.submarket] = { submarket: s.submarket, displayName: formatSubmarket(s.submarket), symbols: [] }
          }
          grouped[s.submarket].symbols.push(s)
        }
        setSymbolGroups(Object.values(grouped))
        setLoadingSymbols(false)
        ws.close()
      }
    }
    ws.onerror = () => { setLoadingSymbols(false); try { ws.close() } catch { /**/ } }
    return () => { try { ws.close() } catch { /**/ } }
  }, [])

  /* ────────────────────────────────────────────────────────────────────────
     Effect 2: Chart instance (mount only — persists across symbol/TF changes)
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return
    const chart = createChart(container, {
      width: container.clientWidth, height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: '#060d18' },
        textColor: 'rgba(190,205,225,0.45)', fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.025)' },
        horzLines: { color: 'rgba(255,255,255,0.045)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        textColor: 'rgba(190,205,225,0.4)',
        scaleMargins: { top: 0.1, bottom: 0.08 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        timeVisible: true, secondsVisible: true, rightOffset: 10,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(252,163,17,0.3)', labelBackgroundColor: '#142035' },
        horzLine: { color: 'rgba(252,163,17,0.3)', labelBackgroundColor: '#142035' },
      },
      handleScroll: true, handleScale: true,
    })
    chartRef.current = chart
    const series = chart.addAreaSeries({
      lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.18)', bottomColor: 'rgba(252,163,17,0)',
      lineWidth: 2, priceLineColor: '#FCA311', priceLineStyle: 2,
    })
    seriesRef.current = series
    const obs = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    obs.observe(container)
    return () => { obs.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  /* ────────────────────────────────────────────────────────────────────────
     Effect 3: Chart data WebSocket — reruns on symbol / TF / chartType
     Follows manual-trader pattern: WS recreated on config change,
     forget_all sent on cleanup before close.
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    // Swap series to match effectiveType (remove old, add correct type)
    if (seriesRef.current) { try { chart.removeSeries(seriesRef.current) } catch { /**/ }; seriesRef.current = null }

    let series: ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>
    if (effectiveType === 'area') {
      series = chart.addAreaSeries({
        lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.18)', bottomColor: 'rgba(252,163,17,0)',
        lineWidth: 2, priceLineColor: '#FCA311', priceLineStyle: 2,
      })
    } else if (effectiveType === 'line') {
      series = chart.addLineSeries({ color: '#FCA311', lineWidth: 2, priceLineColor: '#FCA311', priceLineStyle: 2 })
    } else {
      series = chart.addCandlestickSeries({
        upColor: '#26a69a', downColor: '#ef5350',
        borderUpColor: '#26a69a', borderDownColor: '#ef5350',
        wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        priceLineStyle: 2,
      })
    }
    seriesRef.current = series
    chart.applyOptions({ timeScale: { secondsVisible: isTickMode } })

    // Reset live state
    setConnected(false); setLivePrice(null); setPriceDir(null); setPriceChange(0)
    prevPriceRef.current = null; firstPriceRef.current = null

    const ws = new WebSocket(PUBLIC_WS_URL)

    ws.onopen = () => {
      setConnected(true)
      if (isTickMode) {
        // Tick mode: style:'ticks' — granularity is NOT sent (not a valid param for ticks)
        ws.send(JSON.stringify({ ticks_history: symbol, end: 'latest', count: 1000, style: 'ticks', subscribe: 1, req_id: 10 }))
      } else {
        // Candle mode: valid granularity values: 60,120,180,300,600,900,1800,3600,7200,14400,28800,86400
        ws.send(JSON.stringify({ ticks_history: symbol, end: 'latest', count: 200, style: 'candles', granularity: tf.granularity, subscribe: 1, req_id: 10 }))
      }
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }
      const ps = (msg as { pip_size?: number }).pip_size
      if (ps != null) setPipSize(ps)

      // Initial tick history → msg_type:'history'
      if (msg.msg_type === 'history') {
        type H = { history: { prices: number[]; times: number[] } }
        const h = (msg as unknown as H).history
        const prices = h.prices.map(Number); const times = h.times.map(Number)
        const seen = new Set<number>()
        const data: { time: UTCTimestamp; value: number }[] = []
        for (let i = 0; i < prices.length; i++) {
          if (!seen.has(times[i])) { seen.add(times[i]); data.push({ time: times[i] as UTCTimestamp, value: prices[i] }) }
        }
        try { (seriesRef.current as ISeriesApi<'Area'>)?.setData(data) } catch { /**/ }
        if (prices.length > 0) {
          const last = prices[prices.length - 1]
          firstPriceRef.current = prices[0]; prevPriceRef.current = last
          setLivePrice(last); setPriceChange(last - prices[0])
        }
      }

      // Live tick → msg_type:'tick'
      if (msg.msg_type === 'tick') {
        type T = { tick: { quote: number; epoch: number } }
        const { quote: q, epoch: e } = (msg as unknown as T).tick
        const prev = prevPriceRef.current
        setPriceDir(prev == null ? null : q > prev ? 'up' : q < prev ? 'down' : null)
        prevPriceRef.current = q; setLivePrice(q)
        if (firstPriceRef.current != null) setPriceChange(q - firstPriceRef.current)
        try { (seriesRef.current as ISeriesApi<'Area'>)?.update({ time: e as UTCTimestamp, value: q }) } catch { /**/ }
      }

      // Initial candle batch → msg_type:'candles'
      if (msg.msg_type === 'candles') {
        type C = { candles: Array<{ epoch: number; open: string; high: string; low: string; close: string }> }
        const arr = (msg as unknown as C).candles
        const data = arr.map(c => ({ time: Number(c.epoch) as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
        try { (seriesRef.current as ISeriesApi<'Candlestick'>)?.setData(data) } catch { /**/ }
        if (arr.length > 0) {
          const last = Number(arr[arr.length - 1].close); const first = Number(arr[0].open)
          firstPriceRef.current = first; prevPriceRef.current = last
          setLivePrice(last); setPriceChange(last - first)
        }
      }

      // Live OHLC update → msg_type:'ohlc'
      // ohlc.open_time = candle start epoch; ohlc.close = current close price
      if (msg.msg_type === 'ohlc') {
        type O = { ohlc: { open: string; high: string; low: string; close: string; open_time: string } }
        const o = (msg as unknown as O).ohlc; const q = Number(o.close)
        const prev = prevPriceRef.current
        setPriceDir(prev == null ? null : q > prev ? 'up' : q < prev ? 'down' : null)
        prevPriceRef.current = q; setLivePrice(q)
        if (firstPriceRef.current != null) setPriceChange(q - firstPriceRef.current)
        try {
          (seriesRef.current as ISeriesApi<'Candlestick'>)?.update({
            time: Number(o.open_time) as UTCTimestamp,
            open: Number(o.open), high: Number(o.high), low: Number(o.low), close: q,
          })
        } catch { /**/ }
      }
    }

    ws.onerror = () => setConnected(false)
    ws.onclose = () => setConnected(false)

    return () => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget_all: isTickMode ? 'ticks' : 'candles', req_id: 99 })) } catch { /**/ }
      ws.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfIdx, chartType])

  /* ────────────────────────────────────────────────────────────────────────
     Effect 4: Digit analysis WS (always ticks, reruns on symbol change)
     Provides last-digit frequency data for the trading panel grid.
     Separate from chart WS so digit data is always available regardless of TF.
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    setPrices([])
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => {
      ws.send(JSON.stringify({ ticks_history: symbol, end: 'latest', count: MAX_PRICES, style: 'ticks', subscribe: 1, req_id: 50 }))
    }
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }
      if (msg.msg_type === 'history') {
        type H = { history: { prices: number[] }; pip_size?: number }
        const m = msg as unknown as H
        if (m.pip_size != null) setDigitPip(m.pip_size)
        setPrices(m.history.prices.map(Number))
      }
      if (msg.msg_type === 'tick') {
        type T = { tick: { quote: number; pip_size?: number } }
        const { quote: q, pip_size: ps } = (msg as unknown as T).tick
        if (ps != null) setDigitPip(ps)
        setPrices(prev => { const n = [...prev, q]; return n.length > MAX_PRICES ? n.slice(-MAX_PRICES) : n })
      }
    }
    ws.onerror = () => { /**/ }
    ws.onclose = () => { /**/ }
    return () => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 59 })) } catch { /**/ }
      ws.close()
    }
  }, [symbol])

  /* ────────────────────────────────────────────────────────────────────────
     Effect 5: Auth WebSocket — proposals + buy
     Pattern mirrors manual-trader exactly: stable useCallback reads from refs,
     auth WS reconnects on disconnection, debounced resubscription on param change.
  ─────────────────────────────────────────────────────────────────────────── */

  /** Forget current proposals and send fresh ones for current trade config. */
  const resubscribeProposals = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 998 }))
    setPropA(null); setPropB(null)

    const tt      = TRADE_TYPES[tradeTypeIdxRef.current]
    const sym     = symbolRef.current
    const dur     = durationRef.current
    const curr    = currencyRef.current
    const amount  = parseFloat(stakeRef.current) || 1
    const barrier = tt.hasDigit ? String(digitRef.current) : undefined
    const base    = { proposal: 1, subscribe: 1, basis: 'stake', amount, currency: curr, underlying_symbol: sym, duration: dur, duration_unit: 't' }

    ws.send(JSON.stringify({ ...base, contract_type: tt.ctA, ...(barrier ? { barrier } : {}), req_id: 10 }))
    ws.send(JSON.stringify({ ...base, contract_type: tt.ctB, ...(barrier ? { barrier } : {}), req_id: 11 }))
  }, []) // stable — reads from refs

  useEffect(() => {
    intentionalClose.current = false
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null

    function backoff(n: number) { return Math.min(2000 * 2 ** n, 30_000) }

    async function connect() {
      setWsError(null); setWsReady(false)

      // Fetch user currency (fails gracefully if not authenticated)
      try {
        const r = await fetch('/api/user/balance', { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json() as { activeAccountId: string; accounts: { accountId: string; currency: string }[] }
          const acc = d.accounts.find(a => a.accountId === d.activeAccountId)
          if (acc) { setCurrency(acc.currency); currencyRef.current = acc.currency }
        }
      } catch { /**/ }

      // Fetch authenticated WS URL
      let wsUrl = ''
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) {
          if (r.status === 401) { intentionalClose.current = true; setWsError('login'); return }
          setWsError('reconnecting'); scheduleReconnect(); return
        }
        ;({ wsUrl } = await r.json() as { wsUrl: string })
      } catch { setWsError('reconnecting'); scheduleReconnect(); return }

      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0; setWsError(null); setWsReady(true)
        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
        resubscribeProposals(ws!)
        ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })) }, 30_000)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          if (err.code && ['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(err.code)) {
            intentionalClose.current = true; setWsError('login'); return
          }
          const rid = msg.req_id as number
          if (rid === 10) setPropA({ id: '', ask_price: 0, payout: 0, error: err.message })
          if (rid === 11) setPropB({ id: '', ask_price: 0, payout: 0, error: err.message })
          const buyKey = buyReqMap.current.get(rid)
          if (buyKey) { buyReqMap.current.delete(rid); setBuying(null) }
          return
        }

        if (msg.msg_type === 'balance') {
          const b = (msg as { balance: { balance: number; currency: string } }).balance
          window.dispatchEvent(new CustomEvent('deriv-balance', { detail: b }))
        }

        if (msg.msg_type === 'proposal') {
          const p = (msg as { proposal: { id: string; ask_price: number; payout: number }; req_id: number }).proposal
          const prop: Proposal = { id: p.id, ask_price: p.ask_price, payout: p.payout }
          if (msg.req_id === 10) setPropA(prop)
          if (msg.req_id === 11) setPropB(prop)
        }

        if (msg.msg_type === 'buy') {
          const rid = msg.req_id as number
          const key = buyReqMap.current.get(rid)
          if (key) { buyReqMap.current.delete(rid); setBuying(null) }
          // Refresh proposals after purchase
          setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) resubscribeProposals(ws!) }, 300)
        }
      }

      ws.onerror = () => { /**/ }
      ws.onclose = () => {
        setWsReady(false); botWsRef.current = null; setBuying(null)
        if (ping) { clearInterval(ping); ping = null }
        if (!intentionalClose.current) {
          if (reconnectCount.current >= MAX_RECONNECT) { setWsError('lost'); return }
          reconnectCount.current++
          setWsError('reconnecting')
          scheduleReconnect(backoff(reconnectCount.current))
        }
      }
    }

    function scheduleReconnect(delay = 2000) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => { if (!intentionalClose.current) connect() }, delay)
    }

    connect()

    return () => {
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (ping) clearInterval(ping)
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 997 }))
      } catch { /**/ }
      ws?.close(); botWsRef.current = null
    }
  }, [resubscribeProposals])

  /* ── Debounced proposal resubscription on trading config changes ── */
  useEffect(() => {
    if (!botWsRef.current) return
    const t = setTimeout(() => {
      if (botWsRef.current?.readyState === WebSocket.OPEN) resubscribeProposals(botWsRef.current)
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tradeTypeIdx, digit, stake, duration, wsReady, resubscribeProposals])

  /* ── Buy handler ── */
  const doBuy = useCallback((isA: boolean) => {
    const ws = botWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || buying) return
    const prop = isA ? propARef.current : propBRef.current
    if (!prop?.id || prop.error) return
    setBuying(isA ? 'A' : 'B')
    const rid = ++reqIdRef.current
    buyReqMap.current.set(rid, isA ? 'A' : 'B')
    ws.send(JSON.stringify({ buy: prop.id, price: parseFloat((prop.ask_price * 1.02).toFixed(2)), req_id: rid }))
  }, [buying])

  /* ── Chart helpers ── */
  function toggleCrosshair() {
    const next = !crosshair; setCrosshair(next)
    chartRef.current?.applyOptions({ crosshair: { mode: next ? CrosshairMode.Normal : CrosshairMode.Hidden } })
  }
  function zoom(dir: 'in' | 'out') {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    const range = ts.getVisibleLogicalRange()
    if (!range) return
    const span = range.to - range.from; const delta = span * 0.2
    ts.setVisibleLogicalRange({ from: range.from + (dir === 'in' ? delta : -delta), to: range.to - (dir === 'in' ? delta : -delta) })
  }

  /* ── Filtered market groups ── */
  const filteredGroups = symbolGroups.map(g => ({
    ...g,
    symbols: g.symbols.filter(s =>
      !mktSearch ||
      s.underlying_symbol_name.toLowerCase().includes(mktSearch.toLowerCase()) ||
      s.underlying_symbol.toLowerCase().includes(mktSearch.toLowerCase())
    ),
  })).filter(g => g.symbols.length > 0)

  const ChartTypeIcon = effectiveType === 'candles' ? IcCandles : effectiveType === 'line' ? IcLine : IcArea
  const displayName   = activeSymbol?.underlying_symbol_name ?? symbol

  /* ── Input style ── */
  const inp: React.CSSProperties = {
    background: '#0a1628', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px', color: '#fff', fontSize: '0.8rem',
    padding: '0.35rem 0.5rem', outline: 'none', boxSizing: 'border-box',
  }

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    <div style={{ background: '#060d18', height: '100%', display: 'flex', overflow: 'hidden', position: 'relative' }}>

      {/* ══ LEFT TOOLBAR (sc-toolbar-widget) ══ */}
      <div style={{
        width: '44px', flexShrink: 0,
        background: '#07101f',
        borderRight: '1px solid rgba(255,255,255,0.055)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: '6px', paddingBottom: '8px',
        zIndex: 3, position: 'relative',
      }}>

        {/* TF + chart type button */}
        <div style={{ position: 'relative', width: '100%' }}>
          <button
            onClick={() => { setShowChartMenu(v => !v); setShowMkt(false) }}
            style={{
              ...toolbarBtn, width: '100%',
              color:      showChartMenu ? '#FCA311' : 'rgba(200,215,235,0.55)',
              background: showChartMenu ? 'rgba(252,163,17,0.1)' : 'transparent',
            }}
            title="Chart type &amp; timeframe"
          >
            <span style={{ fontSize: '0.58rem', fontWeight: 800, color: 'inherit', lineHeight: 1 }}>{tf.label}</span>
            <ChartTypeIcon />
            <span style={{ fontSize: '0.48rem', color: 'rgba(200,215,235,0.35)' }}>
              {effectiveType === 'area' ? 'Area' : effectiveType === 'candles' ? 'Candles' : 'Line'}
            </span>
          </button>

          {/* TF + chart type dropdown */}
          {showChartMenu && (
            <div style={{
              position: 'absolute', top: 0, left: '48px',
              background: '#0a1628', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px', padding: '14px', width: '200px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)', zIndex: 20,
            }}>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                  Timeframe
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {TIMEFRAMES.map((t, i) => (
                    <button key={t.label}
                      onClick={() => { setTfIdx(i); if (t.granularity === 0) setChartType('area') }}
                      style={{
                        padding: '4px 8px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                        background: tfIdx === i ? 'rgba(252,163,17,0.2)' : 'rgba(255,255,255,0.06)',
                        color:      tfIdx === i ? '#FCA311' : 'rgba(229,229,229,0.5)',
                        fontSize: '0.68rem', fontWeight: 700,
                        outline: tfIdx === i ? '1px solid rgba(252,163,17,0.4)' : 'none',
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              {!isTickMode && (
                <div>
                  <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                    Chart type
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {CHART_TYPES.map(ct => {
                      const Icon = ct.id === 'candles' ? IcCandles : ct.id === 'line' ? IcLine : IcArea
                      return (
                        <button key={ct.id} onClick={() => setChartType(ct.id as ChartType)} style={{
                          flex: 1, padding: '6px 4px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                          background: chartType === ct.id ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.05)',
                          color:      chartType === ct.id ? '#FCA311' : 'rgba(229,229,229,0.45)',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px',
                          outline: chartType === ct.id ? '1px solid rgba(252,163,17,0.4)' : 'none',
                        }}>
                          <Icon />
                          <span style={{ fontSize: '0.55rem', fontWeight: 600 }}>{ct.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ width: '28px', height: '1px', background: 'rgba(255,255,255,0.07)', margin: '6px 0' }} />

        <button style={toolbarBtn} title="Indicators"><IcIndicators /><span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Indicators</span></button>
        <button style={toolbarBtn} title="Drawing tools"><IcDrawing /><span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Drawing</span></button>
        <button style={toolbarBtn} title="Download"><IcDownload /><span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Download</span></button>
      </div>

      {/* ══ CHART AREA ══ */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>

        {/* Symbol selector + connection indicator */}
        <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 5, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => { setShowMkt(v => !v); setMktSearch(''); setShowChartMenu(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: 'rgba(6,13,24,0.88)',
              border: showMkt ? '1px solid rgba(252,163,17,0.5)' : '1px solid rgba(255,255,255,0.09)',
              borderRadius: '9px', padding: '7px 10px 7px 8px',
              cursor: 'pointer', outline: 'none',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
            }}
          >
            <span style={{
              width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg,#FCA311 0%,#c97000 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.5rem', fontWeight: 900, color: '#000',
            }}>
              {symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}
            </span>
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e5e5e5', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
                {displayName}
              </div>
              {livePrice != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '1px' }}>
                  <span style={{
                    fontSize: '0.82rem', fontWeight: 800, color: priceColor,
                    fontVariantNumeric: 'tabular-nums', transition: 'color 0.18s',
                    animation: priceDir ? 'pricePulse 0.25s ease' : 'none',
                  }}>
                    {fmt(livePrice, pip)}
                  </span>
                  <span style={{ color: 'rgba(229,229,229,0.3)', fontSize: '0.65rem' }}>-</span>
                  <span style={{ fontSize: '0.65rem', color: changeColor, fontVariantNumeric: 'tabular-nums' }}>
                    {priceChange >= 0 ? '+' : ''}{fmt(priceChange, pip)}
                    <span style={{ marginLeft: '3px' }}>({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)</span>
                  </span>
                </div>
              )}
            </div>
            <span style={{ color: 'rgba(229,229,229,0.35)', marginLeft: '2px' }}><IcDropdown open={showMkt} /></span>
          </button>

          <span style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            background: 'rgba(6,13,24,0.8)', borderRadius: '6px',
            padding: '4px 8px', border: '1px solid rgba(255,255,255,0.07)',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: connected ? '#22c55e' : '#444',
              boxShadow: connected ? '0 0 6px #22c55e88' : 'none',
              animation: connected ? 'pulse 2s ease infinite' : 'none',
            }} />
            <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.28)' }}>
              {connected ? 'Live' : 'Connecting'}
            </span>
          </span>
        </div>

        {/* Floating zoom / crosshair controls (bottom-left) */}
        <div style={{
          position: 'absolute', bottom: '38px', left: '12px', zIndex: 5,
          display: 'flex', flexDirection: 'column', gap: '2px',
        }}>
          {[
            { title: 'Zoom in',          icon: '+',  action: () => zoom('in'),  active: false },
            { title: crosshair ? 'Disable crosshair' : 'Enable crosshair', icon: '◇', action: toggleCrosshair, active: crosshair },
            { title: 'Zoom out',         icon: '−',  action: () => zoom('out'), active: false },
            { title: 'Scroll to latest', icon: '→|', action: () => chartRef.current?.timeScale().scrollToRealTime(), active: false },
          ].map(b => (
            <button key={b.title} title={b.title} onClick={b.action} style={{
              width: '26px', height: '26px', borderRadius: '5px',
              background: b.active ? 'rgba(252,163,17,0.15)' : 'rgba(6,13,24,0.8)',
              border: b.active ? '1px solid rgba(252,163,17,0.4)' : '1px solid rgba(255,255,255,0.07)',
              color:  b.active ? '#FCA311' : 'rgba(200,215,235,0.55)',
              fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              outline: 'none',
            }}>
              {b.icon}
            </button>
          ))}
        </div>

        {/* lightweight-charts canvas */}
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />

        {/* Market selector dialog */}
        {showMkt && (
          <>
            <div onClick={() => setShowMkt(false)} style={{ position: 'absolute', inset: 0, zIndex: 9, background: 'rgba(0,0,0,0.2)' }} />
            <div style={{
              position: 'absolute', top: 0, left: 0, bottom: 0, width: '520px',
              zIndex: 10, background: '#070f1e',
              borderRight: '1px solid rgba(255,255,255,0.07)',
              display: 'flex', boxShadow: '8px 0 40px rgba(0,0,0,0.65)',
            }}>
              {/* Left category filter */}
              <div style={{ width: '155px', flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '14px 14px 10px', fontSize: '0.8rem', fontWeight: 700, color: 'rgba(229,229,229,0.75)', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  Markets
                </div>
                {[
                  { icon: '★', label: 'Favorites' },
                  { icon: '◉', label: 'Derived', active: true },
                  { icon: '₿', label: 'Crypto' },
                  { icon: '⟲', label: 'Forex' },
                  { icon: '◈', label: 'Commodities' },
                ].map(cat => (
                  <div key={cat.label} style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 14px',
                    background: cat.active ? 'rgba(252,163,17,0.09)' : 'transparent',
                    borderLeft: cat.active ? '2px solid #FCA311' : '2px solid transparent', cursor: 'default',
                  }}>
                    <span style={{ fontSize: '0.7rem', color: cat.active ? '#FCA311' : 'rgba(229,229,229,0.4)' }}>{cat.icon}</span>
                    <span style={{ fontSize: '0.73rem', fontWeight: cat.active ? 700 : 400, color: cat.active ? '#FCA311' : 'rgba(229,229,229,0.5)' }}>{cat.label}</span>
                  </div>
                ))}
                <div style={{ paddingLeft: '22px' }}>
                  <div style={{ padding: '6px 14px', fontSize: '0.68rem', color: 'rgba(229,229,229,0.45)', cursor: 'default' }}>baskets</div>
                  <div style={{ padding: '6px 14px', fontSize: '0.68rem', fontWeight: 600, color: '#FCA311', borderLeft: '2px solid #FCA311', cursor: 'default' }}>synthetics</div>
                </div>
              </div>

              {/* Right search + list */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '8px', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="6" cy="6" r="4" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5"/>
                      <path d="M9 9L12 12" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <input autoFocus type="text" placeholder="Search..." value={mktSearch} onChange={e => setMktSearch(e.target.value)}
                      style={{ background: 'none', border: 'none', outline: 'none', color: '#e5e5e5', fontSize: '0.78rem', flex: 1 }} />
                    {mktSearch && (
                      <button onClick={() => setMktSearch('')} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1 }}>×</button>
                    )}
                  </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}>
                  {loadingSymbols && (
                    <div style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>Loading markets…</div>
                  )}
                  {!loadingSymbols && filteredGroups.map(group => (
                    <div key={group.submarket}>
                      <div style={{ padding: '10px 14px 4px', fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {group.displayName}
                      </div>
                      {group.symbols.map(sym => {
                        const isSel = sym.underlying_symbol === symbol
                        return (
                          <button key={sym.underlying_symbol}
                            onClick={() => { setSymbol(sym.underlying_symbol); setShowMkt(false) }}
                            style={{
                              width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                              padding: '8px 14px', background: isSel ? 'rgba(252,163,17,0.07)' : 'transparent',
                              border: 'none', borderLeft: isSel ? '2px solid #FCA311' : '2px solid transparent',
                              color: isSel ? '#FCA311' : 'rgba(229,229,229,0.75)', cursor: 'pointer', textAlign: 'left',
                              opacity: sym.exchange_is_open ? 1 : 0.45,
                            }}
                          >
                            <span style={{
                              width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                              background: isSel ? 'rgba(252,163,17,0.18)' : 'rgba(255,255,255,0.06)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '0.52rem', fontWeight: 800, color: isSel ? '#FCA311' : 'rgba(229,229,229,0.4)',
                            }}>
                              {sym.underlying_symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.75rem', fontWeight: isSel ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {sym.underlying_symbol_name}
                              </div>
                              {!sym.exchange_is_open && <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.3)' }}>Closed</div>}
                            </div>
                            {isSel && <span style={{ marginLeft: 'auto', color: '#FCA311', fontSize: '0.8rem' }}>✓</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {!loadingSymbols && filteredGroups.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '2.5rem', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>No markets found</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Chart menu dismiss backdrop */}
        {showChartMenu && (
          <div onClick={() => setShowChartMenu(false)} style={{ position: 'absolute', inset: 0, zIndex: 15 }} />
        )}
      </div>

      {/* ══ RIGHT TRADING PANEL ══ */}
      <div style={{
        width: '272px', flexShrink: 0,
        background: '#07101f',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* Contract type tabs: OU / EO / MD / RF */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          {TRADE_TYPES.map((tt, i) => (
            <button key={tt.id}
              onClick={() => { setTradeTypeIdx(i); setSideA(true); setPropA(null); setPropB(null) }}
              style={{
                flex: 1, padding: '9px 0',
                background: 'transparent', border: 'none',
                color:       tradeTypeIdx === i ? '#FCA311' : 'rgba(229,229,229,0.38)',
                borderBottom: tradeTypeIdx === i ? '2px solid #FCA311' : '2px solid transparent',
                fontSize: '0.6rem', fontWeight: 800, cursor: 'pointer',
                letterSpacing: '0.03em', outline: 'none',
              }}
            >
              {tt.id}
            </button>
          ))}
        </div>

        {/* Trading panel body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

          {/* Full contract type label */}
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'rgba(229,229,229,0.6)' }}>
            {currentTT.label}
          </div>

          {/* Side selector: A (Over/Even/Match/Rise) vs B (Under/Odd/Differ/Fall) */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {[true, false].map(isA => {
              const label = isA ? currentTT.labelA : currentTT.labelB
              const color = isA ? currentTT.colorA : currentTT.colorB
              return (
                <button key={String(isA)} onClick={() => setSideA(isA)} style={{
                  flex: 1, padding: '9px 4px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                  background: sideA === isA ? color : 'rgba(255,255,255,0.05)',
                  color:      sideA === isA ? '#fff' : 'rgba(229,229,229,0.45)',
                  fontSize: '0.78rem', fontWeight: 700,
                  transition: 'all 0.12s', outline: 'none',
                }}>
                  {label}
                </button>
              )
            })}
          </div>

          {/* Last digit prediction grid (digit contracts only) */}
          {currentTT.hasDigit && (
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '7px' }}>
                Last digit prediction
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '3px' }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => {
                  const pct   = digitTotal > 0 ? (digitCounts[d] / digitTotal) * 100 : 0
                  const isSel = digit === d
                  const color = sideA ? currentTT.colorA : currentTT.colorB
                  return (
                    <button key={d} onClick={() => setDigit(d)} style={{
                      padding: '8px 3px', borderRadius: '7px',
                      border: `1px solid ${isSel ? color : 'rgba(255,255,255,0.06)'}`,
                      background: isSel ? `${color}1a` : 'rgba(255,255,255,0.025)',
                      color: isSel ? color : 'rgba(229,229,229,0.65)',
                      cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                      transition: 'all 0.1s', outline: 'none',
                    }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 800, lineHeight: 1 }}>{d}</span>
                      <span style={{ fontSize: '0.56rem', lineHeight: 1, opacity: 0.85 }}>{pct.toFixed(1)}%</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Duration */}
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>
              Duration
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="number" min="1" max="10" value={duration}
                onChange={e => setDuration(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                style={{ ...inp, width: '60px' }} />
              <span style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.38)' }}>ticks</span>
            </div>
          </div>

          {/* Stake */}
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>
              Stake ({currency})
            </div>
            <input type="number" min="0.35" step="0.01" value={stake}
              onChange={e => setStake(e.target.value)}
              style={{ ...inp, width: '100%' }} />
          </div>

          {/* Proposal price display */}
          {activeProp && !activeProp.error && (
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '9px 11px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.32)' }}>Price</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt2(activeProp.ask_price)} {currency}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.32)' }}>Payout</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt2(activeProp.payout)} {currency}
                </span>
              </div>
            </div>
          )}

          {activeProp?.error && (
            <div style={{ fontSize: '0.65rem', color: '#ef4444', padding: '7px 9px', background: 'rgba(239,68,68,0.08)', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.15)' }}>
              {activeProp.error.slice(0, 60)}
            </div>
          )}

          {/* Spacer pushes buy button to bottom */}
          <div style={{ flex: 1, minHeight: '8px' }} />

          {/* Auth / connection status */}
          {wsError === 'login' && (
            <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.65rem', color: 'rgba(229,229,229,0.35)', background: 'rgba(255,255,255,0.03)', borderRadius: '7px' }}>
              Login to enable trading
            </div>
          )}
          {(wsError === 'reconnecting' || wsError === 'lost') && (
            <div style={{ fontSize: '0.62rem', color: '#ef4444', padding: '5px 8px', background: 'rgba(239,68,68,0.07)', borderRadius: '6px', textAlign: 'center' }}>
              ⚠ {wsError === 'lost' ? 'Connection lost — refresh' : 'Reconnecting…'}
            </div>
          )}

          {/* Buy button */}
          <button
            onClick={() => doBuy(sideA)}
            disabled={!wsReady || !!buying || !activeProp?.id || !!activeProp?.error}
            style={{
              width: '100%', padding: '14px 8px', borderRadius: '10px', border: 'none',
              background: wsReady && activeProp?.id && !activeProp.error && !buying
                ? activeColor
                : 'rgba(255,255,255,0.06)',
              color: wsReady && activeProp?.id && !activeProp.error ? '#fff' : 'rgba(229,229,229,0.2)',
              cursor: wsReady && activeProp?.id && !activeProp.error && !buying ? 'pointer' : 'not-allowed',
              transition: 'all 0.15s', outline: 'none', flexShrink: 0,
            }}
          >
            {buying ? (
              <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>…</div>
            ) : (
              <>
                <div style={{ fontSize: '0.88rem', fontWeight: 800 }}>
                  {wsError === 'login' ? 'Login to Trade' : `Buy ${sideA ? currentTT.labelA : currentTT.labelB}`}
                </div>
                {activeProp?.payout && !activeProp.error && (
                  <div style={{ fontSize: '0.68rem', fontWeight: 400, marginTop: '3px', opacity: 0.85 }}>
                    Payout {fmt2(activeProp.payout)} {currency}
                  </div>
                )}
                {!wsReady && !wsError && (
                  <div style={{ fontSize: '0.68rem', fontWeight: 400, marginTop: '3px', opacity: 0.6 }}>Connecting…</div>
                )}
              </>
            )}
          </button>
        </div>

        {/* Auth WS status indicator */}
        <div style={{
          flexShrink: 0, padding: '7px 12px',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}>
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
            background: wsReady ? '#22c55e' : wsError === 'reconnecting' ? '#FCA311' : '#444',
            boxShadow: wsReady ? '0 0 5px #22c55e88' : 'none',
            animation: wsReady ? 'pulse 2s ease infinite' : 'none',
          }} />
          <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.25)' }}>
            {wsReady ? `Authenticated · ${currency}` : wsError === 'login' ? 'Not logged in' : wsError === 'reconnecting' ? 'Reconnecting…' : wsError === 'lost' ? 'Disconnected' : 'Connecting…'}
          </span>
        </div>
      </div>

      <style>{`
        @keyframes pulse      { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes pricePulse { 0%{opacity:0.5} 100%{opacity:1} }
        input::placeholder    { color: rgba(229,229,229,0.25); }
        button:hover          { filter: brightness(1.15); }
        ::-webkit-scrollbar       { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
      `}</style>
    </div>
  )
}
