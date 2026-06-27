'use client'

import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts'

/* ─── API ────────────────────────────────────────────────────────────────── */
// Public WebSocket — no auth required for market data
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'

// Valid granularities from ticks_history API schema
// Source: https://api.deriv.com/api-explorer/#ticks_history
// granularity 0 = our sentinel for tick mode (sends style:'ticks', no granularity param)
// Valid API values: 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400
const TIMEFRAMES = [
  { label: '1T',  granularity: 0     },  // style: 'ticks'
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

/* ─── active_symbols API types ───────────────────────────────────────────── */
// Source: https://api.deriv.com/api-explorer/#active_symbols
interface ActiveSymbol {
  underlying_symbol:      string  // e.g. "1HZ100V"
  underlying_symbol_name: string  // e.g. "Volatility 100 (1s) Index"
  market:                 string  // e.g. "synthetic_index"
  submarket:              string  // e.g. "random_1hz_index"
  pip_size:               number  // decimal places for price display
  exchange_is_open:       0 | 1   // live market open status
}

interface SymbolGroup {
  submarket:   string
  displayName: string
  symbols:     ActiveSymbol[]
}

/* ─── Submarket display names ────────────────────────────────────────────── */
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

const DEFAULT_SYMBOL = '1HZ100V'

/* ─── Shared button styles ───────────────────────────────────────────────── */
const toolbarBtn: React.CSSProperties = {
  width: '44px', height: '44px',
  background: 'transparent', border: 'none',
  color: 'rgba(200,215,235,0.5)', cursor: 'pointer', outline: 'none',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: '2px', borderRadius: '4px', flexShrink: 0,
}
const navBtn: React.CSSProperties = {
  width: '30px', height: '30px',
  background: 'transparent', border: 'none',
  color: 'rgba(200,215,235,0.5)', cursor: 'pointer', outline: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: '4px', flexShrink: 0,
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
function IcTemplates() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="12" y="2" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="2" y="12" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="12" y="12" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
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
function IcZoomIn() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M4.5 6.5H8.5M6.5 4.5V8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M10 10L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}
function IcZoomOut() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M4.5 6.5H8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M10 10L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}
function IcCrosshair() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="7.5" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M7.5 1V4.5M7.5 10.5V14M1 7.5H4.5M10.5 7.5H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}
function IcLatest() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 7H10M8 4L11 7L8 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1="12" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
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

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function fmt(p: number, pip: number) { return p.toFixed(pip) }

/* ─── Main Page ─────────────────────────────────────────────────────────── */
export default function ChartsPage() {

  /* ── UI state ── */
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

  /* ── Refs ── */
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef          = useRef<IChartApi | null>(null)
  const seriesRef         = useRef<ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null)
  const wsRef             = useRef<WebSocket | null>(null)
  const prevPriceRef      = useRef<number | null>(null)
  const firstPriceRef     = useRef<number | null>(null)

  /* ── Derived ── */
  const tf           = TIMEFRAMES[tfIdx]
  const isTickMode   = tf.granularity === 0
  // In tick mode always render as area (candles need OHLC data)
  const effectiveType: ChartType = isTickMode ? 'area' : chartType
  const allSymbols   = symbolGroups.flatMap(g => g.symbols)
  const activeSymbol = allSymbols.find(s => s.underlying_symbol === symbol)
  const pip          = activeSymbol?.pip_size ?? pipSize

  const priceColor  = priceDir === 'up' ? '#22c55e' : priceDir === 'down' ? '#ef4444' : 'rgba(229,229,229,0.9)'
  const changeColor = priceChange >= 0 ? '#22c55e' : '#ef4444'
  const changePct   = firstPriceRef.current ? (priceChange / firstPriceRef.current) * 100 : 0

  /* ────────────────────────────────────────────────────────────────────────
     Effect 1: Fetch active_symbols on mount (one-time)
     Matches Deriv API docs: active_symbols request with brief subset.
     Source: https://api.deriv.com/api-explorer/#active_symbols
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)

    ws.onopen = () => {
      // 'brief' returns a subset of fields sufficient for our selector
      ws.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 }))
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.msg_type === 'active_symbols') {
        type AS = { active_symbols: ActiveSymbol[] }
        const symbols = (msg as unknown as AS).active_symbols

        // Group by submarket; focus on synthetic_index (chartable 24/7)
        const grouped: Record<string, SymbolGroup> = {}
        for (const s of symbols) {
          if (s.market !== 'synthetic_index') continue
          const key = s.submarket
          if (!grouped[key]) {
            grouped[key] = { submarket: key, displayName: formatSubmarket(key), symbols: [] }
          }
          grouped[key].symbols.push(s)
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
     Effect 2: Create chart instance (mount only)
     Chart is kept alive across symbol / TF / chartType changes — only the
     series is swapped in Effect 3. This preserves the chart layout and
     avoids expensive DOM recreation on every user interaction.
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return

    const chart = createChart(container, {
      width:  container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: '#060d18' },
        textColor:   'rgba(190,205,225,0.45)',
        fontSize:    11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.025)' },
        horzLines: { color: 'rgba(255,255,255,0.045)' },
      },
      rightPriceScale: {
        borderColor:  'rgba(255,255,255,0.06)',
        textColor:    'rgba(190,205,225,0.4)',
        scaleMargins: { top: 0.1, bottom: 0.08 },
      },
      timeScale: {
        borderColor:    'rgba(255,255,255,0.06)',
        timeVisible:    true,
        secondsVisible: true,
        rightOffset:    10,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(252,163,17,0.3)', labelBackgroundColor: '#142035' },
        horzLine: { color: 'rgba(252,163,17,0.3)', labelBackgroundColor: '#142035' },
      },
      handleScroll: true,
      handleScale:  true,
    })
    chartRef.current = chart

    // Create initial area series — Effect 3 will swap as needed
    const series = chart.addAreaSeries({
      lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.18)', bottomColor: 'rgba(252,163,17,0)',
      lineWidth: 2, priceLineColor: '#FCA311', priceLineStyle: 2,
    })
    seriesRef.current = series

    // Responsive: resize chart to match container
    const obs = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    obs.observe(container)

    return () => {
      obs.disconnect()
      chart.remove()
      chartRef.current  = null
      seriesRef.current = null
    }
  }, [])

  /* ────────────────────────────────────────────────────────────────────────
     Effect 3: Chart data WebSocket — reruns on symbol / TF / chartType change
     Pattern mirrors manual-trader: one WS per session config, cleaned up
     with forget_all before close.

     ticks_history API:
       - style: 'ticks'                      → msg_type: 'history' (initial), 'tick' (live)
       - style: 'candles', granularity: G   → msg_type: 'candles' (initial), 'ohlc' (live)
     Source: https://api.deriv.com/api-explorer/#ticks_history
  ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    // ── 1. Swap series to match effectiveType ──────────────────────────────
    // Remove the old series and add the correct type for this session.
    if (seriesRef.current) {
      try { chart.removeSeries(seriesRef.current) } catch { /**/ }
      seriesRef.current = null
    }

    let series: ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>
    if (effectiveType === 'area') {
      series = chart.addAreaSeries({
        lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.18)', bottomColor: 'rgba(252,163,17,0)',
        lineWidth: 2, priceLineColor: '#FCA311', priceLineStyle: 2,
      })
    } else if (effectiveType === 'line') {
      series = chart.addLineSeries({
        color: '#FCA311', lineWidth: 2, priceLineColor: '#FCA311', priceLineStyle: 2,
      })
    } else {
      series = chart.addCandlestickSeries({
        upColor: '#26a69a', downColor: '#ef5350',
        borderUpColor: '#26a69a', borderDownColor: '#ef5350',
        wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        priceLineStyle: 2,
      })
    }
    seriesRef.current = series

    // Show seconds for tick mode (ticks arrive every ~1s)
    chart.applyOptions({ timeScale: { secondsVisible: isTickMode } })

    // ── 2. Reset live state ───────────────────────────────────────────────
    setConnected(false)
    setLivePrice(null)
    setPriceDir(null)
    setPriceChange(0)
    prevPriceRef.current  = null
    firstPriceRef.current = null

    // ── 3. Open WebSocket ─────────────────────────────────────────────────
    const ws = new WebSocket(PUBLIC_WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)

      if (isTickMode) {
        // Tick mode: style 'ticks' — do NOT send granularity (not a valid param for ticks)
        ws.send(JSON.stringify({
          ticks_history: symbol, end: 'latest', count: 1000,
          style: 'ticks', subscribe: 1, req_id: 10,
        }))
      } else {
        // Candle mode: style 'candles' with a valid granularity value
        // Valid values: 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400
        ws.send(JSON.stringify({
          ticks_history: symbol, end: 'latest', count: 200,
          style: 'candles', granularity: tf.granularity, subscribe: 1, req_id: 10,
        }))
      }
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      // pip_size: number of decimal places for this symbol's price
      const ps = (msg as { pip_size?: number }).pip_size
      if (ps != null) setPipSize(ps)

      // ── Initial tick history (style: 'ticks') ───────────────────────────
      // Response msg_type: 'history' — full batch of historical tick prices
      if (msg.msg_type === 'history') {
        type H = { history: { prices: number[]; times: number[] } }
        const h      = (msg as unknown as H).history
        const prices = h.prices.map(Number)
        const times  = h.times.map(Number)

        // Deduplicate: API may return consecutive ticks with identical epoch
        const seen = new Set<number>()
        const data: { time: UTCTimestamp; value: number }[] = []
        for (let i = 0; i < prices.length; i++) {
          if (!seen.has(times[i])) {
            seen.add(times[i])
            data.push({ time: times[i] as UTCTimestamp, value: prices[i] })
          }
        }
        try { (seriesRef.current as ISeriesApi<'Area'>)?.setData(data) } catch { /**/ }

        if (prices.length > 0) {
          const last = prices[prices.length - 1]
          firstPriceRef.current = prices[0]
          prevPriceRef.current  = last
          setLivePrice(last)
          setPriceChange(last - prices[0])
        }
      }

      // ── Live tick update ─────────────────────────────────────────────────
      // Response msg_type: 'tick' — one live price update
      if (msg.msg_type === 'tick') {
        type T = { tick: { quote: number; epoch: number } }
        const { quote: q, epoch: e } = (msg as unknown as T).tick
        const prev = prevPriceRef.current
        setPriceDir(prev == null ? null : q > prev ? 'up' : q < prev ? 'down' : null)
        prevPriceRef.current = q
        setLivePrice(q)
        if (firstPriceRef.current != null) setPriceChange(q - firstPriceRef.current)
        try { (seriesRef.current as ISeriesApi<'Area'>)?.update({ time: e as UTCTimestamp, value: q }) } catch { /**/ }
      }

      // ── Initial candles batch (style: 'candles') ─────────────────────────
      // Response msg_type: 'candles' — full OHLC history
      // candle.epoch = candle open time (start of the granularity period)
      if (msg.msg_type === 'candles') {
        type C = { candles: Array<{ epoch: number; open: string; high: string; low: string; close: string }> }
        const arr  = (msg as unknown as C).candles
        const data = arr.map(c => ({
          time:  Number(c.epoch) as UTCTimestamp,
          open:  Number(c.open),
          high:  Number(c.high),
          low:   Number(c.low),
          close: Number(c.close),
        }))
        try { (seriesRef.current as ISeriesApi<'Candlestick'>)?.setData(data) } catch { /**/ }

        if (arr.length > 0) {
          const last  = Number(arr[arr.length - 1].close)
          const first = Number(arr[0].open)
          firstPriceRef.current = first
          prevPriceRef.current  = last
          setLivePrice(last)
          setPriceChange(last - first)
        }
      }

      // ── Live OHLC candle update ──────────────────────────────────────────
      // Response msg_type: 'ohlc' — live update to the current open candle
      // ohlc.open_time = candle start epoch (matches candle.epoch in the batch)
      // ohlc.close     = current closing price of the live candle
      if (msg.msg_type === 'ohlc') {
        type O = { ohlc: { open: string; high: string; low: string; close: string; open_time: string } }
        const o    = (msg as unknown as O).ohlc
        const q    = Number(o.close)
        const prev = prevPriceRef.current
        setPriceDir(prev == null ? null : q > prev ? 'up' : q < prev ? 'down' : null)
        prevPriceRef.current = q
        setLivePrice(q)
        if (firstPriceRef.current != null) setPriceChange(q - firstPriceRef.current)
        try {
          (seriesRef.current as ISeriesApi<'Candlestick'>)?.update({
            time:  Number(o.open_time) as UTCTimestamp,
            open:  Number(o.open),
            high:  Number(o.high),
            low:   Number(o.low),
            close: q,
          })
        } catch { /**/ }
      }
    }

    ws.onerror = () => setConnected(false)
    ws.onclose = () => { setConnected(false); wsRef.current = null }

    // ── Cleanup: forget subscription before closing (Deriv API best practice) ──
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
  }, [symbol, tfIdx, chartType])

  /* ── Crosshair toggle ── */
  function toggleCrosshair() {
    const next = !crosshair
    setCrosshair(next)
    chartRef.current?.applyOptions({
      crosshair: { mode: next ? CrosshairMode.Normal : CrosshairMode.Hidden },
    })
  }

  /* ── Zoom helpers ── */
  function zoom(dir: 'in' | 'out') {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    const range = ts.getVisibleLogicalRange()
    if (!range) return
    const span  = range.to - range.from
    const delta = span * 0.2
    ts.setVisibleLogicalRange({
      from: range.from + (dir === 'in' ?  delta : -delta),
      to:   range.to   - (dir === 'in' ?  delta : -delta),
    })
  }

  /* ── Filtered market groups for search ── */
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

  /* ── Render ── */
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

        {/* Chart-type / Timeframe button */}
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
            <span style={{ fontSize: '0.58rem', fontWeight: 800, color: 'inherit', lineHeight: 1 }}>
              {tf.label}
            </span>
            <ChartTypeIcon />
            <span style={{ fontSize: '0.48rem', color: 'rgba(200,215,235,0.35)', letterSpacing: '0.01em' }}>
              {effectiveType === 'area' ? 'Area' : effectiveType === 'candles' ? 'Candles' : 'Line'}
            </span>
          </button>

          {/* Dropdown panel: TF pills + chart type buttons */}
          {showChartMenu && (
            <div style={{
              position: 'absolute', top: 0, left: '48px',
              background: '#0a1628',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px',
              padding: '14px',
              width: '200px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              zIndex: 20,
            }}>
              {/* Timeframe section */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                  Timeframe
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {TIMEFRAMES.map((t, i) => (
                    <button
                      key={t.label}
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

              {/* Chart type section (only for non-tick modes) */}
              {!isTickMode && (
                <div>
                  <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                    Chart type
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {CHART_TYPES.map(ct => {
                      const Icon = ct.id === 'candles' ? IcCandles : ct.id === 'line' ? IcLine : IcArea
                      return (
                        <button
                          key={ct.id}
                          onClick={() => setChartType(ct.id as ChartType)}
                          style={{
                            flex: 1, padding: '6px 4px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                            background: chartType === ct.id ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.05)',
                            color:      chartType === ct.id ? '#FCA311' : 'rgba(229,229,229,0.45)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px',
                            outline: chartType === ct.id ? '1px solid rgba(252,163,17,0.4)' : 'none',
                          }}
                        >
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

        {/* Divider */}
        <div style={{ width: '28px', height: '1px', background: 'rgba(255,255,255,0.07)', margin: '6px 0' }} />

        {/* Indicators */}
        <button style={toolbarBtn} title="Indicators">
          <IcIndicators />
          <span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Indicators</span>
        </button>

        {/* Templates */}
        <button style={toolbarBtn} title="Templates">
          <IcTemplates />
          <span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Templates</span>
        </button>

        {/* Drawing tools */}
        <button style={toolbarBtn} title="Drawing tools">
          <IcDrawing />
          <span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Drawing</span>
        </button>

        {/* Download */}
        <button style={toolbarBtn} title="Download chart">
          <IcDownload />
          <span style={{ fontSize: '0.45rem', color: 'rgba(200,215,235,0.3)' }}>Download</span>
        </button>
      </div>

      {/* ══ MAIN CHART AREA ══ */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>

        {/* cq-top-ui-widgets: symbol selector + live price overlay */}
        <div style={{
          position: 'absolute', top: '10px', left: '10px',
          zIndex: 5, display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          {/* cq-symbol-select-btn */}
          <button
            onClick={() => { setShowMkt(v => !v); setMktSearch(''); setShowChartMenu(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: 'rgba(6,13,24,0.88)',
              border: showMkt ? '1px solid rgba(252,163,17,0.5)' : '1px solid rgba(255,255,255,0.09)',
              borderRadius: '9px',
              padding: '7px 10px 7px 8px',
              cursor: 'pointer', outline: 'none',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
            }}
          >
            {/* Market icon */}
            <span style={{
              width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg,#FCA311 0%,#c97000 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.5rem', fontWeight: 900, color: '#000', letterSpacing: '-0.02em',
            }}>
              {symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}
            </span>

            {/* Symbol name + live price */}
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e5e5e5', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
                {displayName}
              </div>
              {livePrice != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '1px' }}>
                  {/* cq-animated-price */}
                  <span style={{
                    fontSize: '0.82rem', fontWeight: 800,
                    color: priceColor, fontVariantNumeric: 'tabular-nums',
                    transition: 'color 0.18s',
                    animation: priceDir ? 'pricePulse 0.25s ease' : 'none',
                  }}>
                    {fmt(livePrice, pip)}
                  </span>
                  <span style={{ color: 'rgba(229,229,229,0.3)', fontSize: '0.65rem' }}>-</span>
                  {/* cq-change */}
                  <span style={{ fontSize: '0.65rem', color: changeColor, fontVariantNumeric: 'tabular-nums' }}>
                    {priceChange >= 0 ? '+' : ''}{fmt(priceChange, pip)}
                    <span style={{ marginLeft: '3px' }}>
                      ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
                    </span>
                  </span>
                </div>
              )}
            </div>

            {/* cq-symbol-dropdown arrow */}
            <span style={{ color: 'rgba(229,229,229,0.35)', marginLeft: '2px' }}>
              <IcDropdown open={showMkt} />
            </span>
          </button>

          {/* Connection indicator */}
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

        {/* lightweight-charts canvas mount */}
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />

        {/* ── sc-mcd: Market Selector Dialog (overlaid on chart) ── */}
        {showMkt && (
          <>
            {/* Backdrop */}
            <div
              onClick={() => setShowMkt(false)}
              style={{ position: 'absolute', inset: 0, zIndex: 9, background: 'rgba(0,0,0,0.2)' }}
            />

            {/* Dialog panel */}
            <div style={{
              position: 'absolute', top: 0, left: 0, bottom: 0,
              width: '520px', zIndex: 10,
              background: '#070f1e',
              borderRight: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              boxShadow: '8px 0 40px rgba(0,0,0,0.65)',
            }}>

              {/* sc-mcd__tabs: LEFT category filter */}
              <div style={{
                width: '155px', flexShrink: 0,
                borderRight: '1px solid rgba(255,255,255,0.06)',
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={{
                  padding: '14px 14px 10px',
                  fontSize: '0.8rem', fontWeight: 700, color: 'rgba(229,229,229,0.75)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  flexShrink: 0,
                }}>
                  Markets
                </div>

                {[
                  { icon: '★', label: 'Favorites'   },
                  { icon: '◉', label: 'Derived',    active: true },
                  { icon: '₿', label: 'Crypto'      },
                  { icon: '⟲', label: 'Forex'       },
                  { icon: '◈', label: 'Commodities' },
                ].map(cat => (
                  <div key={cat.label} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '9px 14px',
                    background: cat.active ? 'rgba(252,163,17,0.09)' : 'transparent',
                    borderLeft: cat.active ? '2px solid #FCA311' : '2px solid transparent',
                    cursor: 'default',
                  }}>
                    <span style={{ fontSize: '0.7rem', color: cat.active ? '#FCA311' : 'rgba(229,229,229,0.4)' }}>
                      {cat.icon}
                    </span>
                    <span style={{ fontSize: '0.73rem', fontWeight: cat.active ? 700 : 400, color: cat.active ? '#FCA311' : 'rgba(229,229,229,0.5)' }}>
                      {cat.label}
                    </span>
                    {cat.active && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginLeft: 'auto' }}>
                        <path d="M2 7L5 4L8 7" stroke="#FCA311" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    )}
                  </div>
                ))}

                {/* Sub-items for Derived */}
                <div style={{ paddingLeft: '22px' }}>
                  <div style={{ padding: '6px 14px', fontSize: '0.68rem', color: 'rgba(229,229,229,0.45)', cursor: 'default' }}>
                    baskets
                  </div>
                  <div style={{
                    padding: '6px 14px', fontSize: '0.68rem', fontWeight: 600,
                    color: '#FCA311', borderLeft: '2px solid #FCA311', cursor: 'default',
                  }}>
                    synthetics
                  </div>
                </div>
              </div>

              {/* sc-mcd__content: RIGHT search + symbol list */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

                {/* Search */}
                <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    background: 'rgba(255,255,255,0.06)', borderRadius: '8px',
                    padding: '8px 12px', border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="6" cy="6" r="4" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5"/>
                      <path d="M9 9L12 12" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <input
                      autoFocus
                      type="text"
                      placeholder="Search..."
                      value={mktSearch}
                      onChange={e => setMktSearch(e.target.value)}
                      style={{ background: 'none', border: 'none', outline: 'none', color: '#e5e5e5', fontSize: '0.78rem', flex: 1 }}
                    />
                    {mktSearch && (
                      <button onClick={() => setMktSearch('')} style={{
                        background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)',
                        cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1,
                      }}>×</button>
                    )}
                  </div>
                </div>

                {/* sc-mcd__content__body: symbol list from active_symbols API */}
                <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}>
                  {loadingSymbols && (
                    <div style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>
                      Loading markets…
                    </div>
                  )}

                  {!loadingSymbols && filteredGroups.map(group => (
                    <div key={group.submarket}>
                      {/* Submarket group header */}
                      <div style={{
                        padding: '10px 14px 4px',
                        fontSize: '0.6rem', fontWeight: 700,
                        color: 'rgba(229,229,229,0.28)',
                        textTransform: 'uppercase', letterSpacing: '0.08em',
                      }}>
                        {group.displayName}
                      </div>

                      {group.symbols.map(sym => {
                        const isSel = sym.underlying_symbol === symbol
                        return (
                          <button
                            key={sym.underlying_symbol}
                            onClick={() => { setSymbol(sym.underlying_symbol); setShowMkt(false) }}
                            style={{
                              width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                              padding: '8px 14px',
                              background: isSel ? 'rgba(252,163,17,0.07)' : 'transparent',
                              border: 'none',
                              borderLeft: isSel ? '2px solid #FCA311' : '2px solid transparent',
                              color: isSel ? '#FCA311' : 'rgba(229,229,229,0.75)',
                              cursor: 'pointer', textAlign: 'left',
                              opacity: sym.exchange_is_open ? 1 : 0.45,
                            }}
                          >
                            {/* Symbol icon */}
                            <span style={{
                              width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                              background: isSel ? 'rgba(252,163,17,0.18)' : 'rgba(255,255,255,0.06)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '0.52rem', fontWeight: 800,
                              color: isSel ? '#FCA311' : 'rgba(229,229,229,0.4)',
                              letterSpacing: '-0.03em',
                            }}>
                              {sym.underlying_symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}
                            </span>

                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.75rem', fontWeight: isSel ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {sym.underlying_symbol_name}
                              </div>
                              {!sym.exchange_is_open && (
                                <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.3)' }}>Closed</div>
                              )}
                            </div>

                            {isSel && (
                              <span style={{ marginLeft: 'auto', color: '#FCA311', fontSize: '0.8rem', flexShrink: 0 }}>✓</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ))}

                  {!loadingSymbols && filteredGroups.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '2.5rem', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>
                      No markets found
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Close chart-menu when clicking outside */}
        {showChartMenu && (
          <div
            onClick={() => setShowChartMenu(false)}
            style={{ position: 'absolute', inset: 0, zIndex: 15 }}
          />
        )}
      </div>

      {/* ══ RIGHT NAVIGATION WIDGET (sc-navigation-widget) ══ */}
      <div style={{
        width: '32px', flexShrink: 0,
        background: '#07101f',
        borderLeft: '1px solid rgba(255,255,255,0.055)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'flex-end', paddingBottom: '42px', gap: '3px',
      }}>
        <button title="Zoom in" style={navBtn} onClick={() => zoom('in')}>
          <IcZoomIn />
        </button>
        <button
          title={crosshair ? 'Disable crosshair' : 'Enable crosshair'}
          onClick={toggleCrosshair}
          style={{
            ...navBtn,
            background: crosshair ? 'rgba(252,163,17,0.12)' : 'transparent',
            color:      crosshair ? '#FCA311' : 'rgba(200,215,235,0.5)',
            outline:    crosshair ? '1px solid rgba(252,163,17,0.3)' : 'none',
          }}
        >
          <IcCrosshair />
        </button>
        <button title="Zoom out" style={navBtn} onClick={() => zoom('out')}>
          <IcZoomOut />
        </button>
        <button title="Scroll to latest" style={navBtn} onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>
          <IcLatest />
        </button>
      </div>

      <style>{`
        @keyframes pulse     { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes pricePulse{ 0%{opacity:0.5} 100%{opacity:1} }
        input::placeholder   { color: rgba(229,229,229,0.28); }
        button:hover         { filter: brightness(1.2); }
        ::-webkit-scrollbar       { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
      `}</style>
    </div>
  )
}
