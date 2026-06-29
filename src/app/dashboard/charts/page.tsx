'use client'

/**
 * Lima Trade — Charts Page (v79)
 *
 * Architecture:
 *   PUBLIC WS  (wss://api.derivws.com/trading/v1/options/ws/public)
 *     active_symbols  req_id:1   → market list, pip/decimal info
 *     ticks           req_id:2   → live price + chart ticks
 *     ticks_history   req_id:3   → seed chart data + digit counts
 *     proposal A      req_id:10  → pricing for side A
 *     proposal B      req_id:11  → pricing for side B
 *
 *   AUTH WS    (from /api/user/ws-url — OTP-authenticated)
 *     balance         req_id:51  → live balance
 *     buy             req_id:dynamic → purchase contract
 *     proposal_open_contract  req_id:dynamic → monitor open contract
 *
 * Key rules (learned from Deriv API schemas):
 *   - proposal.id is the UUID passed to buy (schema: /schemas/buy_request.schema.json)
 *   - buy.price = maximum price (use ask_price * 1.02 as buffer)
 *   - Proposal subscription is consumed on buy → must resubscribe immediately
 *   - POC is_sold === 1 → contract settled (won/lost/sold)
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart, IChartApi, UTCTimestamp,
  ISeriesApi, LineData, CandlestickData, AreaData,
} from 'lightweight-charts'

// ─── Constants ──────────────────────────────────────────────────────────────────
const PUB_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'

const TRADE_TYPES = [
  { id: 'OU', label: 'Over / Under',   ctA: 'DIGITOVER',  ctB: 'DIGITUNDER', labelA: 'Over',  labelB: 'Under',  colorA: '#22c55e', colorB: '#3b82f6', hasDigit: true  },
  { id: 'EO', label: 'Even / Odd',     ctA: 'DIGITEVEN',  ctB: 'DIGITODD',   labelA: 'Even',  labelB: 'Odd',    colorA: '#22c55e', colorB: '#3b82f6', hasDigit: false },
  { id: 'MD', label: 'Match / Differ', ctA: 'DIGITMATCH', ctB: 'DIGITDIFF',  labelA: 'Match', labelB: 'Differ', colorA: '#22c55e', colorB: '#ef4444', hasDigit: true  },
  { id: 'RF', label: 'Rise / Fall',    ctA: 'CALL',       ctB: 'PUT',        labelA: 'Rise',  labelB: 'Fall',   colorA: '#22c55e', colorB: '#ef4444', hasDigit: false },
]

const TIMEFRAMES = [
  { label: '1T',  granularity: 0      },
  { label: '1m',  granularity: 60     },
  { label: '5m',  granularity: 300    },
  { label: '15m', granularity: 900    },
  { label: '1h',  granularity: 3600   },
  { label: '4h',  granularity: 14400  },
  { label: '1D',  granularity: 86400  },
]

const CHART_TYPES = [
  { id: 'area',    label: 'Area'    },
  { id: 'candles', label: 'Candles' },
  { id: 'line',    label: 'Line'    },
]

// ─── Types ───────────────────────────────────────────────────────────────────────
type ChartType = 'area' | 'candles' | 'line'

interface Proposal {
  id: string        // UUID from proposal.id → passed directly to buy
  ask_price: number
  payout: number
  error?: string
}

interface MarketSymbol {
  symbol: string
  display_name: string
  pip: number              // e.g. 0.01 → 2 decimal places
  decimalPlaces: number    // derived: -log10(pip)
  submarket_display_name: string
  exchange_is_open: boolean
}

interface Position {
  contractId: number
  contractType: string
  underlying: string
  side: 'A' | 'B'
  labelA: string
  labelB: string
  colorA: string
  colorB: string
  buyPrice: number
  payout: number
  bidPrice: number
  profit: number
  status: 'open' | 'won' | 'lost' | 'sold' | 'cancelled'
  purchaseTime: number
  barrier?: string
  duration: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────
const fmt  = (n: number, dp: number) => n.toFixed(dp)
const fmt2 = (n: number) => n.toFixed(2)

/** Compute MA values from price array */
function computeMA(prices: number[], period: number): (number | null)[] {
  return prices.map((_, i) => {
    if (i < period - 1) return null
    const slice = prices.slice(i - period + 1, i + 1)
    return slice.reduce((s, v) => s + v, 0) / period
  })
}

/** Extract last digit from price given decimal places */
function lastDigit(price: number, dp: number): number {
  return Math.abs(Math.round(price * 10 ** dp)) % 10
}

// ─── Inline Icons ─────────────────────────────────────────────────────────────────
const IcArea = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" fill="none">
    <path d="M1 12 L4 8 L7 9 L11 4 L15 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M1 12 L4 8 L7 9 L11 4 L15 7 L15 13 L1 13Z" fill="currentColor" opacity="0.25"/>
  </svg>
)
const IcCandles = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" fill="none">
    {[[2,2,10,4],[6,4,7,8],[10,1,11,10],[14,5,6,6]].map(([x,y,h,b],i)=>(
      <g key={i}>
        <rect x={x-1} y={y} width="3" height={b} rx="0.5" fill="currentColor"/>
        <line x1={x+0.5} y1={y-1} x2={x+0.5} y2={y} stroke="currentColor" strokeWidth="1"/>
        <line x1={x+0.5} y1={y+b} x2={x+0.5} y2={y+b+1.5} stroke="currentColor" strokeWidth="1"/>
      </g>
    ))}
  </svg>
)
const IcLine = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" fill="none">
    <path d="M1 11 L5 7 L9 9 L13 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const IcIndicators = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 12 Q5 4 8 8 Q11 12 14 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="8" cy="8" r="1.5" fill="currentColor" opacity="0.6"/>
  </svg>
)
const IcDrawing = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3 13 L12 4 L13 5 L4 14Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    <path d="M11 3 L13 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M2 14 L3 13 L4 14Z" fill="currentColor" opacity="0.5"/>
  </svg>
)
const IcDownload = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M8 3 L8 11 M5 8 L8 11 L11 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3 13 L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
)

// ─── Toolbar button style ──────────────────────────────────────────────────────
const toolbarBtn: React.CSSProperties = {
  width: '36px', height: '44px', borderRadius: '8px', border: 'none',
  background: 'transparent', cursor: 'pointer', outline: 'none',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', gap: '2px', color: 'rgba(200,215,235,0.55)',
  transition: 'all 0.12s',
}

// ─── Signal data for Over/Under trade type ────────────────────────────────────
const SIGNAL_DATA = [
  { label: 'O1', side: 'over'  as const, barrier: 1 },
  { label: 'O2', side: 'over'  as const, barrier: 2 },
  { label: 'O3', side: 'over'  as const, barrier: 3 },
  { label: 'O4', side: 'over'  as const, barrier: 4 },
  { label: 'O5', side: 'over'  as const, barrier: 5 },
  { label: 'U4', side: 'under' as const, barrier: 4 },
  { label: 'U5', side: 'under' as const, barrier: 5 },
  { label: 'U6', side: 'under' as const, barrier: 6 },
  { label: 'U7', side: 'under' as const, barrier: 7 },
  { label: 'U8', side: 'under' as const, barrier: 8 },
]

// ─── Component ────────────────────────────────────────────────────────────────
export default function ChartsPage() {
  // ── UI toggles ──────────────────────────────────────────────────────────────
  const [showChartMenu,   setShowChartMenu]   = useState(false)
  const [showIndicators,  setShowIndicators]  = useState(false)
  const [showDrawingPanel,setShowDrawingPanel] = useState(false)
  const [showMkt,         setShowMkt]         = useState(false)
  const [mktSearch,       setMktSearch]       = useState('')
  const closeAll = useCallback(() => {
    setShowChartMenu(false); setShowIndicators(false); setShowDrawingPanel(false)
  }, [])

  // ── Chart configuration ──────────────────────────────────────────────────────
  const [tfIdx,      setTfIdx]      = useState(0)
  const [chartType,  setChartType]  = useState<ChartType>('area')
  const tf = TIMEFRAMES[tfIdx]
  const isTickMode = tf.granularity === 0
  const effectiveType = isTickMode ? 'area' : chartType

  // ── Market ────────────────────────────────────────────────────────────────────
  const [symbol,      setSymbol]      = useState('R_100')
  const [markets,     setMarkets]     = useState<MarketSymbol[]>([])
  const [loadingMkts, setLoadingMkts] = useState(true)

  const currentMarket = markets.find(m => m.symbol === symbol)
  const displayName   = currentMarket?.display_name  ?? symbol
  const pip           = currentMarket?.pip            ?? 0.01
  const decimalPlaces = currentMarket?.decimalPlaces  ?? 2

  // ── Live price ────────────────────────────────────────────────────────────────
  const [livePrice,   setLivePrice]   = useState<number | null>(null)
  const [priceDir,    setPriceDir]    = useState<'up' | 'dn' | null>(null)
  const [priceChange, setPriceChange] = useState(0)
  const prevPriceRef = useRef<number | null>(null)
  const priceColor   = priceDir === 'up' ? '#22c55e' : priceDir === 'dn' ? '#ef4444' : '#e5e5e5'
  const changeColor  = priceChange >= 0 ? '#22c55e' : '#ef4444'

  // ── Digit stats ───────────────────────────────────────────────────────────────
  const [digitCounts, setDigitCounts] = useState<number[]>(new Array(10).fill(0))
  const [digitTotal,  setDigitTotal]  = useState(0)

  // ── Indicators ────────────────────────────────────────────────────────────────
  const [maOn,     setMaOn]     = useState(false)
  const [maPeriod, setMaPeriod] = useState(20)
  const [crosshair, setCrosshair] = useState(false)

  // ── Trade ─────────────────────────────────────────────────────────────────────
  const [tradeTypeIdx, setTradeTypeIdx] = useState(0)
  const [sideA,        setSideA]        = useState(true)
  const [stake,        setStake]        = useState('1.00')
  const [duration,     setDuration]     = useState(1)
  const [digit,        setDigit]        = useState(5)

  const currentTT  = TRADE_TYPES[tradeTypeIdx]
  const activeColor = sideA ? currentTT.colorA : currentTT.colorB

  // ── Proposals ─────────────────────────────────────────────────────────────────
  const [propA, setPropA] = useState<Proposal | null>(null)
  const [propB, setPropB] = useState<Proposal | null>(null)
  const propARef = useRef<Proposal | null>(null)
  const propBRef = useRef<Proposal | null>(null)
  useEffect(() => { propARef.current = propA }, [propA])
  useEffect(() => { propBRef.current = propB }, [propB])

  const activeProp = sideA ? propA : propB

  // ── Buying ────────────────────────────────────────────────────────────────────
  const [buying,   setBuying]   = useState<'A' | 'B' | null>(null)
  const [buyError, setBuyError] = useState<string | null>(null)

  // ── Positions ─────────────────────────────────────────────────────────────────
  const [openPos,   setOpenPos]   = useState<Position[]>([])
  const [closedPos, setClosedPos] = useState<Position[]>([])

  // ── Auth WS ───────────────────────────────────────────────────────────────────
  const [authReady, setAuthReady] = useState(false)
  const [wsError,   setWsError]   = useState<string | null>(null)
  const [balance,   setBalance]   = useState<number | null>(null)
  const [currency,  setCurrency]  = useState('USD')

  // ── Public WS ────────────────────────────────────────────────────────────────
  const [pubReady,  setPubReady]  = useState(false)
  const [connected, setConnected] = useState(false)   // for the live indicator dot

  // ── Signal filter (OU only) ──────────────────────────────────────────────────
  const [sigFilter, setSigFilter] = useState<string>('All')
  const [autoOn,    setAutoOn]    = useState(false)

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const pubWsRef         = useRef<WebSocket | null>(null)
  const authWsRef        = useRef<WebSocket | null>(null)
  const chartContainerRef= useRef<HTMLDivElement>(null)
  const chartRef         = useRef<IChartApi | null>(null)
  const areaSeriesRef    = useRef<ISeriesApi<'Area'>   | null>(null)
  const candleSeriesRef  = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineSeriesRef    = useRef<ISeriesApi<'Line'>   | null>(null)
  const maSeriesRef      = useRef<ISeriesApi<'Line'>   | null>(null)
  const tickPricesRef    = useRef<number[]>([])           // for MA calculation
  const tickTimesRef     = useRef<UTCTimestamp[]>([])
  const currentCandleRef = useRef<CandlestickData | null>(null)  // for candle mode
  const reqIdRef         = useRef<number>(100)
  // Stable refs so WS callbacks don't get stale values
  const symbolRef        = useRef(symbol)
  const tradeTypeIdxRef  = useRef(tradeTypeIdx)
  const durationRef      = useRef(duration)
  const currencyRef      = useRef(currency)
  const stakeRef         = useRef(stake)
  const digitRef         = useRef(digit)
  const tfIdxRef         = useRef(tfIdx)
  const chartTypeRef     = useRef(chartType)
  const maOnRef          = useRef(maOn)
  const maPeriodRef      = useRef(maPeriod)
  // Buy tracking
  const buyReqMap = useRef<Map<number, { side: 'A'|'B', contractType: string, underlying: string, barrier?: string, duration: number }>>(new Map())
  // Position map for fast POC updates
  const posMapRef = useRef<Map<number, Position>>(new Map())
  // Subscription IDs for cleanup
  const tickSubIdRef = useRef<string | null>(null)
  const pocSubIdsRef = useRef<Map<number, string>>(new Map())

  // Keep refs in sync
  useEffect(() => { symbolRef.current        = symbol       }, [symbol])
  useEffect(() => { tradeTypeIdxRef.current  = tradeTypeIdx }, [tradeTypeIdx])
  useEffect(() => { durationRef.current      = duration     }, [duration])
  useEffect(() => { currencyRef.current      = currency     }, [currency])
  useEffect(() => { stakeRef.current         = stake        }, [stake])
  useEffect(() => { digitRef.current         = digit        }, [digit])
  useEffect(() => { tfIdxRef.current         = tfIdx        }, [tfIdx])
  useEffect(() => { chartTypeRef.current     = chartType    }, [chartType])
  useEffect(() => { maOnRef.current          = maOn         }, [maOn])
  useEffect(() => { maPeriodRef.current      = maPeriod     }, [maPeriod])

  // ── Filtered markets for search ──────────────────────────────────────────────
  const filteredMarkets = mktSearch
    ? markets.filter(m =>
        m.display_name.toLowerCase().includes(mktSearch.toLowerCase()) ||
        m.symbol.toLowerCase().includes(mktSearch.toLowerCase())
      )
    : markets

  // Group by submarket
  const marketGroups = filteredMarkets.reduce<Record<string, MarketSymbol[]>>((acc, m) => {
    const g = m.submarket_display_name
    if (!acc[g]) acc[g] = []
    acc[g].push(m)
    return acc
  }, {})

  // ── Signal win probability ────────────────────────────────────────────────────
  const signalData = SIGNAL_DATA.map(s => {
    let wins = 0
    if (s.side === 'over') {
      for (let d = s.barrier + 1; d <= 9; d++) wins += digitCounts[d]
    } else {
      for (let d = 0; d < s.barrier; d++) wins += digitCounts[d]
    }
    return { ...s, prob: digitTotal > 0 ? wins / digitTotal : 0 }
  })

  const bestSignal = digitTotal >= 20
    ? signalData.reduce((best, s) => s.prob > best.prob ? s : best, signalData[0])
    : null

  // ── Chart helpers ─────────────────────────────────────────────────────────────
  const removeSeries = useCallback(() => {
    if (!chartRef.current) return
    if (areaSeriesRef.current)   { try { chartRef.current.removeSeries(areaSeriesRef.current)   } catch {} ; areaSeriesRef.current   = null }
    if (candleSeriesRef.current) { try { chartRef.current.removeSeries(candleSeriesRef.current) } catch {} ; candleSeriesRef.current = null }
    if (lineSeriesRef.current)   { try { chartRef.current.removeSeries(lineSeriesRef.current)   } catch {} ; lineSeriesRef.current   = null }
    if (maSeriesRef.current)     { try { chartRef.current.removeSeries(maSeriesRef.current)     } catch {} ; maSeriesRef.current     = null }
  }, [])

  const addMASeries = useCallback(() => {
    if (!chartRef.current || !maOnRef.current) return
    maSeriesRef.current = chartRef.current.addLineSeries({
      color: '#3b82f6', lineWidth: 1, lastValueVisible: false, priceLineVisible: false,
    })
    // Set MA data from current tick prices
    const prices = tickPricesRef.current
    const times  = tickTimesRef.current
    if (prices.length > 0) {
      const maVals = computeMA(prices, maPeriodRef.current)
      const maSeries: LineData[] = maVals
        .map((v, i) => v !== null ? { time: times[i], value: v } as LineData : null)
        .filter(Boolean) as LineData[]
      if (maSeries.length > 0) maSeriesRef.current.setData(maSeries)
    }
  }, [])

  const buildAreaSeries = useCallback(() => {
    if (!chartRef.current) return
    areaSeriesRef.current = chartRef.current.addAreaSeries({
      lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.25)', bottomColor: 'rgba(252,163,17,0)',
      lineWidth: 2, crosshairMarkerVisible: true,
    })
    const data: AreaData[] = tickTimesRef.current.map((t, i) => ({ time: t, value: tickPricesRef.current[i] } as AreaData))
    if (data.length > 0) areaSeriesRef.current.setData(data)
    addMASeries()
  }, [addMASeries])

  const buildCandleSeries = useCallback(() => {
    if (!chartRef.current) return
    candleSeriesRef.current = chartRef.current.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
  }, [])

  const buildLineSeries = useCallback(() => {
    if (!chartRef.current) return
    lineSeriesRef.current = chartRef.current.addLineSeries({
      color: '#FCA311', lineWidth: 2, crosshairMarkerVisible: true,
    })
    const data: LineData[] = tickTimesRef.current.map((t, i) => ({ time: t, value: tickPricesRef.current[i] } as LineData))
    if (data.length > 0) lineSeriesRef.current.setData(data)
    addMASeries()
  }, [addMASeries])

  /** Rebuild the active series after chart type or MA toggle changes */
  const rebuildSeries = useCallback(() => {
    removeSeries()
    const type = isTickMode ? 'area' : chartTypeRef.current
    if (type === 'area')    buildAreaSeries()
    if (type === 'candles') buildCandleSeries()
    if (type === 'line')    buildLineSeries()
  }, [isTickMode, removeSeries, buildAreaSeries, buildCandleSeries, buildLineSeries])

  // ── Append one tick to chart series ──────────────────────────────────────────
  const appendTick = useCallback((epoch: number, price: number) => {
    const t = epoch as UTCTimestamp

    if (isTickMode) {
      // Tick/area mode
      tickPricesRef.current.push(price)
      tickTimesRef.current.push(t)
      // Keep last 2000
      if (tickPricesRef.current.length > 2000) {
        tickPricesRef.current.shift(); tickTimesRef.current.shift()
      }
      const pt = { time: t, value: price }
      areaSeriesRef.current?.update(pt as AreaData)
      lineSeriesRef.current?.update(pt as LineData)
      // MA update
      if (maSeriesRef.current && maOnRef.current) {
        const prices = tickPricesRef.current
        const period = maPeriodRef.current
        if (prices.length >= period) {
          const slice = prices.slice(-period)
          const ma = slice.reduce((s,v) => s+v, 0) / period
          maSeriesRef.current.update({ time: t, value: ma } as LineData)
        }
      }
    } else {
      // Candle mode: update or create current candle
      const gran = TIMEFRAMES[tfIdxRef.current].granularity
      const candleEpoch = Math.floor(epoch / gran) * gran as UTCTimestamp
      const cur = currentCandleRef.current

      if (cur && cur.time === candleEpoch) {
        // Update current candle
        const updated: CandlestickData = {
          time:  candleEpoch,
          open:  cur.open,
          high:  Math.max(cur.high, price),
          low:   Math.min(cur.low,  price),
          close: price,
        }
        currentCandleRef.current = updated
        candleSeriesRef.current?.update(updated)
      } else {
        // New candle period
        const newCandle: CandlestickData = { time: candleEpoch, open: price, high: price, low: price, close: price }
        currentCandleRef.current = newCandle
        candleSeriesRef.current?.update(newCandle)
      }
    }
  }, [isTickMode])

  // ── Proposal subscription ────────────────────────────────────────────────────
  const resubscribeProposals = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return

    // Cancel all existing proposals first
    ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 998 }))

    // Clear immediately so buy button disables while awaiting fresh UUIDs
    setPropA(null); setPropB(null)

    const tt      = TRADE_TYPES[tradeTypeIdxRef.current]
    const sym     = symbolRef.current
    const dur     = durationRef.current
    const curr    = currencyRef.current
    const amount  = parseFloat(stakeRef.current) || 1
    const barrier = tt.hasDigit ? String(digitRef.current) : undefined

    const base = {
      proposal: 1, subscribe: 1,
      basis: 'stake', amount, currency: curr,
      underlying_symbol: sym, duration: dur, duration_unit: 't',
    }
    ws.send(JSON.stringify({ ...base, contract_type: tt.ctA, ...(barrier ? { barrier } : {}), req_id: 10 }))
    ws.send(JSON.stringify({ ...base, contract_type: tt.ctB, ...(barrier ? { barrier } : {}), req_id: 11 }))
  }, [])

  // ── Request ticks history for current symbol ─────────────────────────────────
  const requestHistory = useCallback((ws: WebSocket, sym: string, gran: number) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (gran === 0) {
      // Tick mode: get 1000 ticks for digit seeding + chart
      ws.send(JSON.stringify({
        ticks_history: sym, count: 1000, end: 'latest', style: 'ticks',
        req_id: 3,
      }))
    } else {
      // Candle mode: get 500 candles
      ws.send(JSON.stringify({
        ticks_history: sym, count: 500, end: 'latest', style: 'candles',
        granularity: gran, req_id: 3,
      }))
    }
  }, [])

  // ── Subscribe to live ticks for a symbol ─────────────────────────────────────
  const subscribeTicks = useCallback((ws: WebSocket, sym: string) => {
    if (ws.readyState !== WebSocket.OPEN) return
    // Forget previous tick subscription
    ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 999 }))
    tickSubIdRef.current = null
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1, req_id: 2 }))
  }, [])

  // ── Public WebSocket setup ───────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket
    let pingTimer: ReturnType<typeof setInterval>
    let dead = false

    function connect() {
      ws = new WebSocket(PUB_WS)
      pubWsRef.current = ws

      ws.onopen = () => {
        if (dead) return
        setPubReady(true); setConnected(true)
        // Get active markets
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 }))
        // Subscribe to ticks for initial symbol
        subscribeTicks(ws, symbolRef.current)
        // Load chart history
        requestHistory(ws, symbolRef.current, TIMEFRAMES[tfIdxRef.current].granularity)
        // Subscribe to proposals (proposals don't require auth)
        resubscribeProposals(ws)
        // Keep-alive
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ ping: 1, req_id: 900 }))
        }, 30_000)
      }

      ws.onmessage = (ev: MessageEvent) => {
        if (dead) return
        let msg: any
        try { msg = JSON.parse(ev.data as string) } catch { return }

        // ── active_symbols ───────────────────────────────────────────────────
        if (msg.msg_type === 'active_symbols') {
          const syms: MarketSymbol[] = (msg.active_symbols as any[]).map((s: any) => {
            const p   = s.pip as number
            const dp  = Math.round(-Math.log10(p))
            return {
              symbol:                   s.symbol,
              display_name:             s.display_name,
              pip:                      p,
              decimalPlaces:            dp,
              submarket_display_name:   s.submarket_display_name,
              exchange_is_open:         !!s.exchange_is_open,
            }
          })
          setMarkets(syms)
          setLoadingMkts(false)
        }

        // ── tick (live price) ─────────────────────────────────────────────────
        if (msg.msg_type === 'tick') {
          const tick = msg.tick as { quote: number; epoch: number; symbol: string }
          if (tick.symbol !== symbolRef.current) return

          const price = tick.quote
          const prev  = prevPriceRef.current
          setLivePrice(price)
          if (prev !== null) {
            setPriceDir(price > prev ? 'up' : price < prev ? 'dn' : null)
            setPriceChange(price - prev)
          }
          prevPriceRef.current = price
          setConnected(true)

          // Digit count (only useful for digit trade types)
          const dp = currentMarket?.decimalPlaces ?? decimalPlaces
          const d  = lastDigit(price, dp)
          setDigitCounts(prev => { const n = [...prev]; n[d]++; return n })
          setDigitTotal(t => t + 1)

          // Chart update
          appendTick(tick.epoch, price)
        }

        // ── history (ticks_history style:ticks) ──────────────────────────────
        if (msg.msg_type === 'history' && msg.req_id === 3) {
          const hist = msg.history as { times: number[]; prices: number[] }
          if (!hist?.times || !hist?.prices) return

          // Reset tick arrays
          tickPricesRef.current = [...hist.prices]
          tickTimesRef.current  = hist.times.map(t => t as UTCTimestamp)

          // Seed digit counts from history
          const dp  = currentMarket?.decimalPlaces ?? decimalPlaces
          const counts = new Array(10).fill(0)
          hist.prices.forEach(p => { counts[lastDigit(p, dp)]++ })
          setDigitCounts(counts)
          setDigitTotal(hist.prices.length)

          // Feed into area/line series
          const data = hist.times.map((t, i) => ({
            time: t as UTCTimestamp, value: hist.prices[i],
          }))
          areaSeriesRef.current?.setData(data as AreaData[])
          lineSeriesRef.current?.setData(data as LineData[])

          // Rebuild MA
          if (maOnRef.current && maSeriesRef.current) {
            const maVals = computeMA(hist.prices, maPeriodRef.current)
            const maDat: LineData[] = maVals
              .map((v, i) => v !== null ? { time: hist.times[i] as UTCTimestamp, value: v } as LineData : null)
              .filter(Boolean) as LineData[]
            maSeriesRef.current.setData(maDat)
          }
        }

        // ── candles (ticks_history style:candles) ─────────────────────────────
        if (msg.msg_type === 'candles' && msg.req_id === 3) {
          const candles = msg.candles as Array<{ epoch: number; open: number; high: number; low: number; close: number }>
          if (!candles?.length) return

          const data: CandlestickData[] = candles.map(c => ({
            time:  c.epoch as UTCTimestamp,
            open:  c.open, high: c.high, low: c.low, close: c.close,
          }))
          candleSeriesRef.current?.setData(data)
          // Track last candle as current
          currentCandleRef.current = data[data.length - 1]
          // Seed tick arrays with close prices for MA
          tickPricesRef.current = candles.map(c => c.close)
          tickTimesRef.current  = candles.map(c => c.epoch as UTCTimestamp)
        }

        // ── proposal (req_id 10 = side A, req_id 11 = side B) ────────────────
        if (msg.msg_type === 'proposal') {
          if (msg.error) {
            const errMsg = msg.error.message ?? 'Proposal error'
            if (msg.req_id === 10) setPropA({ id: '', ask_price: 0, payout: 0, error: errMsg })
            if (msg.req_id === 11) setPropB({ id: '', ask_price: 0, payout: 0, error: errMsg })
            return
          }
          const p = msg.proposal as { id: string; ask_price: number; payout: number }
          // Use proposal.id — this is the UUID passed directly to buy
          const prop: Proposal = { id: p.id, ask_price: p.ask_price, payout: p.payout }
          if (msg.req_id === 10) setPropA(prop)
          if (msg.req_id === 11) setPropB(prop)
        }
      }

      ws.onerror = () => { setConnected(false) }
      ws.onclose = () => {
        setConnected(false); setPubReady(false)
        if (!dead) setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      dead = true
      clearInterval(pingTimer)
      ws?.close()
      pubWsRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth WebSocket setup ─────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null
    let pingTimer: ReturnType<typeof setInterval>
    let dead = false
    let reconnectCount = 0

    async function connect() {
      try {
        const r = await fetch('/api/user/ws-url', { cache: 'no-store' })
        if (!r.ok) {
          setWsError('login')
          return
        }
        const { wsUrl } = await r.json()
        if (!wsUrl) { setWsError('login'); return }

        ws = new WebSocket(wsUrl)
        authWsRef.current = ws

        ws.onopen = () => {
          if (dead) return
          reconnectCount = 0
          setAuthReady(true); setWsError(null)
          ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
          pingTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ ping: 1, req_id: 901 }))
          }, 30_000)
        }

        ws.onmessage = (ev: MessageEvent) => {
          if (dead) return
          let msg: any
          try { msg = JSON.parse(ev.data as string) } catch { return }

          if (msg.error?.code === 'AuthorizationRequired' || msg.error?.code === 'InvalidToken') {
            setWsError('login'); ws?.close(); return
          }

          // ── balance ────────────────────────────────────────────────────────
          if (msg.msg_type === 'balance') {
            const b = msg.balance as { balance: number; currency: string }
            setBalance(b.balance)
            if (b.currency) { setCurrency(b.currency); currencyRef.current = b.currency }
          }

          // ── buy response ──────────────────────────────────────────────────
          if (msg.msg_type === 'buy') {
            if (msg.error) {
              setBuying(null)
              setBuyError(msg.error.message ?? 'Buy failed')
              // Even on error, resubscribe (proposal UUID was consumed)
              const pw = pubWsRef.current
              if (pw?.readyState === WebSocket.OPEN) resubscribeProposals(pw)
              return
            }
            const b = msg.buy as {
              contract_id: number; buy_price: number; payout: number;
              balance_after: number; purchase_time: number
            }
            const rid  = msg.req_id as number
            const meta = buyReqMap.current.get(rid)
            if (meta) {
              buyReqMap.current.delete(rid)
              setBuying(null)
              setBuyError(null)

              // Update balance immediately from buy receipt
              setBalance(b.balance_after)

              // Register the position
              const tt = TRADE_TYPES[tradeTypeIdxRef.current]
              const pos: Position = {
                contractId:   b.contract_id,
                contractType: meta.contractType,
                underlying:   meta.underlying,
                side:         meta.side,
                labelA:       tt.labelA,
                labelB:       tt.labelB,
                colorA:       tt.colorA,
                colorB:       tt.colorB,
                buyPrice:     b.buy_price,
                payout:       b.payout,
                bidPrice:     b.buy_price,
                profit:       0,
                status:       'open',
                purchaseTime: b.purchase_time,
                barrier:      meta.barrier,
                duration:     meta.duration,
              }
              posMapRef.current.set(b.contract_id, pos)
              setOpenPos(prev => [pos, ...prev])

              // Subscribe to contract updates on auth WS
              if (ws?.readyState === WebSocket.OPEN) {
                const pocReqId = ++reqIdRef.current
                ws.send(JSON.stringify({
                  proposal_open_contract: 1, contract_id: b.contract_id,
                  subscribe: 1, req_id: pocReqId,
                }))
              }
            }

            // CRITICAL: Proposal UUID consumed on buy → resubscribe immediately
            const pw = pubWsRef.current
            if (pw?.readyState === WebSocket.OPEN) resubscribeProposals(pw)
          }

          // ── proposal_open_contract (POC) ──────────────────────────────────
          if (msg.msg_type === 'proposal_open_contract') {
            if (!msg.proposal_open_contract) return
            const poc = msg.proposal_open_contract as {
              contract_id: number; status: string; is_sold: number;
              bid_price: string; profit: string; profit_percentage: number;
              buy_price: string; payout: string; contract_type: string;
              barrier?: string | null;
            }
            const cid     = poc.contract_id
            const isSold  = poc.is_sold === 1
            const status  = poc.status as Position['status']
            const bid     = parseFloat(poc.bid_price ?? '0')
            const profit  = parseFloat(poc.profit ?? '0')

            if (isSold) {
              // Contract is settled — move to closed positions
              posMapRef.current.delete(cid)
              setOpenPos(prev => prev.filter(p => p.contractId !== cid))
              setClosedPos(prev => {
                const original = prev.find(p => p.contractId === cid) ??
                                 posMapRef.current.get(cid)
                if (!original) {
                  // Build from POC data
                  const newClosed: Position = {
                    contractId:   cid,
                    contractType: poc.contract_type,
                    underlying:   symbolRef.current,
                    side:         'A',
                    labelA: 'A', labelB: 'B', colorA: '#22c55e', colorB: '#ef4444',
                    buyPrice:  parseFloat(poc.buy_price ?? '0'),
                    payout:    parseFloat(poc.payout ?? '0'),
                    bidPrice:  bid,
                    profit:    profit,
                    status:    status,
                    purchaseTime: Date.now() / 1000,
                    barrier:   poc.barrier ?? undefined,
                    duration:  durationRef.current,
                  }
                  return [newClosed, ...prev].slice(0, 50)
                }
                const closed = { ...original, bidPrice: bid, profit, status }
                return [closed, ...prev.filter(p => p.contractId !== cid)].slice(0, 50)
              })
            } else {
              // Still open — update live bid/profit
              posMapRef.current.set(cid, {
                ...posMapRef.current.get(cid)!,
                bidPrice: bid, profit, status,
              })
              setOpenPos(prev =>
                prev.map(p => p.contractId === cid ? { ...p, bidPrice: bid, profit, status } : p)
              )
            }
          }
        }

        ws.onerror = () => { setAuthReady(false) }
        ws.onclose = () => {
          setAuthReady(false)
          authWsRef.current = null
          if (dead) return
          reconnectCount++
          if (reconnectCount > 5) { setWsError('lost'); return }
          setWsError('reconnecting')
          setTimeout(connect, Math.min(reconnectCount * 2000, 10_000))
        }
      } catch {
        setWsError('reconnecting')
        if (!dead) setTimeout(connect, 5000)
      }
    }

    connect()
    return () => {
      dead = true
      clearInterval(pingTimer)
      ws?.close()
      authWsRef.current = null
    }
  }, [resubscribeProposals]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Symbol change: re-subscribe ticks, reload history, refresh proposals ─────
  useEffect(() => {
    const pw = pubWsRef.current
    if (!pw || pw.readyState !== WebSocket.OPEN) return

    // Reset chart data
    tickPricesRef.current = []; tickTimesRef.current = []; currentCandleRef.current = null
    setDigitCounts(new Array(10).fill(0)); setDigitTotal(0)
    setLivePrice(null); prevPriceRef.current = null

    subscribeTicks(pw, symbol)
    requestHistory(pw, symbol, TIMEFRAMES[tfIdx].granularity)
    resubscribeProposals(pw)
  }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Timeframe change: reload history, rebuild series ─────────────────────────
  useEffect(() => {
    const pw = pubWsRef.current
    if (!pw || pw.readyState !== WebSocket.OPEN) return
    tickPricesRef.current = []; tickTimesRef.current = []; currentCandleRef.current = null
    requestHistory(pw, symbolRef.current, TIMEFRAMES[tfIdx].granularity)
  }, [tfIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Chart type change: rebuild series without reloading data ─────────────────
  useEffect(() => {
    if (!chartRef.current) return
    rebuildSeries()
  }, [chartType, isTickMode, rebuildSeries])

  // ── MA toggle/period change ───────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return
    if (maSeriesRef.current) {
      try { chartRef.current.removeSeries(maSeriesRef.current) } catch {}
      maSeriesRef.current = null
    }
    if (maOn) addMASeries()
  }, [maOn, maPeriod, addMASeries])

  // ── Trade type / stake / duration / digit change: resubscribe proposals ──────
  useEffect(() => {
    const pw = pubWsRef.current
    if (!pw || pw.readyState !== WebSocket.OPEN) return
    setSideA(true)
    resubscribeProposals(pw)
  }, [tradeTypeIdx, stake, duration, digit, resubscribeProposals])

  // ── Chart initialization ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartContainerRef.current) return
    const chart = createChart(chartContainerRef.current, {
      layout:     { background: { color: '#060d1b' }, textColor: 'rgba(229,229,229,0.55)' },
      grid:       { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.035)' } },
      crosshair:  { mode: 0 },
      timeScale:  { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      handleScroll: true, handleScale: true,
    })
    chartRef.current = chart

    // Initial series
    buildAreaSeries()

    const ro = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    ro.observe(chartContainerRef.current)

    return () => {
      ro.disconnect()
      try { chart.remove() } catch {}
      chartRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Crosshair toggle ─────────────────────────────────────────────────────────
  const toggleCrosshair = useCallback(() => {
    setCrosshair(v => {
      const next = !v
      chartRef.current?.applyOptions({ crosshair: { mode: next ? 1 : 0 } })
      return next
    })
  }, [])

  // ── Download chart ────────────────────────────────────────────────────────────
  const downloadChart = useCallback(() => {
    const canvas = chartContainerRef.current?.querySelector('canvas')
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `lima-chart-${symbol}-${Date.now()}.png`
    a.click()
  }, [symbol])

  // ── Zoom helpers ──────────────────────────────────────────────────────────────
  const zoom = useCallback((dir: 'in' | 'out') => {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    const range = ts.getVisibleLogicalRange()
    if (!range) return
    const delta = (range.to - range.from) * (dir === 'in' ? 0.15 : -0.15)
    ts.setVisibleLogicalRange({ from: range.from + delta, to: range.to - delta })
  }, [])

  // ── Buy handler ───────────────────────────────────────────────────────────────
  const doBuy = useCallback((isA: boolean) => {
    const ws = authWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || buying) return

    const prop = isA ? propARef.current : propBRef.current
    if (!prop?.id || prop.error) { setBuyError('Waiting for price — please retry'); return }

    const askPrice = Number(prop.ask_price)
    if (!askPrice || isNaN(askPrice)) { setBuyError('Invalid price — please retry'); return }

    setBuying(isA ? 'A' : 'B')
    setBuyError(null)

    const rid = ++reqIdRef.current
    const tt  = TRADE_TYPES[tradeTypeIdxRef.current]
    buyReqMap.current.set(rid, {
      side:         isA ? 'A' : 'B',
      contractType: isA ? tt.ctA : tt.ctB,
      underlying:   symbolRef.current,
      barrier:      tt.hasDigit ? String(digitRef.current) : undefined,
      duration:     durationRef.current,
    })

    // price = maximum price (ask * 1.02 buffer to absorb minor price movement)
    const maxPrice = parseFloat((askPrice * 1.02).toFixed(2))
    ws.send(JSON.stringify({ buy: prop.id, price: maxPrice, req_id: rid }))

    // Safety timeout
    setTimeout(() => {
      if (buyReqMap.current.has(rid)) {
        buyReqMap.current.delete(rid)
        setBuying(null)
        setBuyError('No response — please retry')
      }
    }, 10_000)
  }, [buying])

  // ── Input style ───────────────────────────────────────────────────────────────
  const inp: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px', color: '#e5e5e5', padding: '6px 10px',
    fontSize: '0.78rem', outline: 'none', fontVariantNumeric: 'tabular-nums',
  }

  // ── Best signal for OU ────────────────────────────────────────────────────────
  const filteredSignals = sigFilter === 'All' ? signalData : signalData.filter(s => s.label === sigFilter)

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex', width: '100%', height: '100%', overflow: 'hidden',
      background: '#060d1b', color: '#e5e5e5', fontFamily: 'Inter, system-ui, sans-serif',
    }}>

      {/* ══ POSITIONS PANEL ══════════════════════════════════════════════════ */}
      <div style={{
        width: '260px', flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column',
        background: '#07101f',
      }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '0.65rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Positions
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {openPos.length === 0 && closedPos.length === 0 && (
            <div style={{ padding: '24px 14px', textAlign: 'center', color: 'rgba(229,229,229,0.18)', fontSize: '0.7rem' }}>
              No positions yet
            </div>
          )}
          {openPos.map(p => (
            <div key={p.contractId} style={{
              padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)',
              background: 'rgba(255,255,255,0.015)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: p.side === 'A' ? p.colorA : p.colorB }}>
                  {p.side === 'A' ? p.labelA : p.labelB}
                  {p.barrier !== undefined ? ` ${p.barrier}` : ''}
                </span>
                <span style={{
                  fontSize: '0.68rem', fontWeight: 700,
                  color: p.profit >= 0 ? '#22c55e' : '#ef4444',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {p.profit >= 0 ? '+' : ''}{fmt2(p.profit)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)' }}>{p.underlying}</span>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)', fontVariantNumeric: 'tabular-nums' }}>
                  ⏳ {fmt2(p.bidPrice)}
                </span>
              </div>
            </div>
          ))}
          {closedPos.slice(0, 20).map(p => (
            <div key={`c-${p.contractId}`} style={{
              padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)',
              opacity: 0.6,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'rgba(229,229,229,0.55)' }}>
                  {p.side === 'A' ? p.labelA : p.labelB}
                  {p.barrier !== undefined ? ` ${p.barrier}` : ''}
                </span>
                <span style={{
                  fontSize: '0.68rem', fontWeight: 700,
                  color: p.status === 'won' ? '#22c55e' : p.status === 'lost' ? '#ef4444' : '#aaa',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {p.status === 'won' ? '+' : p.status === 'lost' ? '' : ''}{fmt2(p.profit)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.25)' }}>{p.status.toUpperCase()}</span>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.25)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt2(p.buyPrice)} → {fmt2(p.payout)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {(openPos.length + closedPos.length) > 0 && (() => {
          const totalPL = [...openPos, ...closedPos].reduce((s, p) => s + p.profit, 0)
          return (
            <div style={{ flexShrink: 0, padding: '7px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.28)' }}>Total P&L</span>
              <span style={{ fontSize: '0.72rem', fontWeight: 800, color: totalPL >= 0 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                {totalPL >= 0 ? '+' : ''}{fmt2(totalPL)}
              </span>
            </div>
          )
        })()}
      </div>

      {/* ══ LEFT TOOLBAR ════════════════════════════════════════════════════════
          zIndex: 20 → toolbar stacking context is at root z=20
          This ensures:
          - Dropdown (z=25 within toolbar) has effective root z=20 > backdrop root z=15
          - Panels (z=25 within toolbar) are clickable (above backdrop z=15)
          - Market dialog (root z=30,35) still covers the toolbar
      ═══════════════════════════════════════════════════════════════════════════*/}
      <div style={{
        width: '44px', flexShrink: 0,
        background: '#07101f',
        borderRight: '1px solid rgba(255,255,255,0.055)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: '80px', paddingBottom: '8px',
        zIndex: 20, position: 'relative',
      }}>

        {/* TF + chart type button */}
        <div style={{ position: 'relative', width: '100%' }}>
          <button
            onClick={() => { setShowChartMenu(v => !v); setShowMkt(false); setShowIndicators(false); setShowDrawingPanel(false) }}
            style={{
              ...toolbarBtn, width: '100%',
              color:      showChartMenu ? '#FCA311' : 'rgba(200,215,235,0.55)',
              background: showChartMenu ? 'rgba(252,163,17,0.1)' : 'transparent',
            }}
            title="Chart type & timeframe"
          >
            <span style={{ fontSize: '0.58rem', fontWeight: 800, color: 'inherit', lineHeight: 1 }}>{tf.label}</span>
            {effectiveType === 'candles' ? <IcCandles /> : effectiveType === 'line' ? <IcLine /> : <IcArea />}
            <span style={{ fontSize: '0.44rem', color: 'rgba(200,215,235,0.3)' }}>
              {effectiveType === 'area' ? 'Area' : effectiveType === 'candles' ? 'Candles' : 'Line'}
            </span>
          </button>

          {/* Dropdown — inside toolbar stacking context (z=20 root), dropdown itself at z=25 within */}
          {showChartMenu && (
            <div style={{
              position: 'absolute', top: '48px', left: '48px',
              background: '#0a1628', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px', padding: '14px', width: '200px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.65)', zIndex: 25,
            }}>
              {/* Timeframes */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                  Timeframe
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {TIMEFRAMES.map((t, i) => (
                    <button key={t.label}
                      onClick={() => {
                        setTfIdx(i)
                        if (t.granularity === 0) setChartType('area')
                        setShowChartMenu(false)
                      }}
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
              {/* Chart types (hidden in tick mode) */}
              {!isTickMode && (
                <div>
                  <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                    Chart type
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {CHART_TYPES.map(ct => {
                      const Icon = ct.id === 'candles' ? IcCandles : ct.id === 'line' ? IcLine : IcArea
                      return (
                        <button key={ct.id}
                          onClick={() => { setChartType(ct.id as ChartType); setShowChartMenu(false) }}
                          style={{
                            flex: 1, padding: '6px 4px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                            background: chartType === ct.id ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.05)',
                            color:      chartType === ct.id ? '#FCA311' : 'rgba(229,229,229,0.45)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px',
                            outline: chartType === ct.id ? '1px solid rgba(252,163,17,0.4)' : 'none',
                          }}
                        >
                          <Icon />
                          <span style={{ fontSize: '0.5rem', fontWeight: 600 }}>{ct.label}</span>
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

        <button
          onClick={() => { setShowIndicators(v => !v); setShowDrawingPanel(false); setShowChartMenu(false) }}
          style={{ ...toolbarBtn, color: showIndicators ? '#3b82f6' : undefined, background: showIndicators ? 'rgba(59,130,246,0.1)' : 'transparent' }}
          title="Indicators"
        >
          <IcIndicators />
          <span style={{ fontSize: '0.44rem', color: 'inherit' }}>Indicators</span>
        </button>

        <button
          onClick={() => { setShowDrawingPanel(v => !v); setShowIndicators(false); setShowChartMenu(false) }}
          style={{ ...toolbarBtn, color: showDrawingPanel ? '#a855f7' : undefined, background: showDrawingPanel ? 'rgba(168,85,247,0.1)' : 'transparent' }}
          title="Drawing tools"
        >
          <IcDrawing />
          <span style={{ fontSize: '0.44rem', color: 'inherit' }}>Drawing</span>
        </button>

        <button onClick={downloadChart} style={toolbarBtn} title="Download chart">
          <IcDownload />
          <span style={{ fontSize: '0.44rem', color: 'rgba(200,215,235,0.3)' }}>Download</span>
        </button>

        {/* ── Indicators panel ──────────────────────────────────────────────── */}
        {showIndicators && (
          <div style={{
            position: 'absolute', left: '44px', top: 0, bottom: 0, width: '240px',
            background: '#07101f', borderRight: '1px solid rgba(255,255,255,0.08)',
            zIndex: 25, display: 'flex', flexDirection: 'column',
            boxShadow: '4px 0 24px rgba(0,0,0,0.5)',
          }}>
            <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e5e5e5' }}>Indicators</span>
              <button onClick={() => setShowIndicators(false)} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 2px' }}>×</button>
            </div>
            {/* MA */}
            <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div>
                  <div style={{ fontSize: '0.73rem', fontWeight: 700, color: maOn ? '#3b82f6' : '#e5e5e5' }}>Moving Average (MA)</div>
                  <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)', marginTop: '2px' }}>Simple moving average overlay</div>
                </div>
                <div onClick={() => setMaOn(v => !v)} style={{ width: '36px', height: '20px', borderRadius: '10px', cursor: 'pointer', flexShrink: 0, background: maOn ? '#3b82f6' : 'rgba(255,255,255,0.1)', position: 'relative', transition: 'background 0.2s' }}>
                  <div style={{ position: 'absolute', top: '2px', width: '16px', height: '16px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', left: maOn ? '18px' : '2px' }} />
                </div>
              </div>
              {maOn && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.45)' }}>Period</span>
                  <input type="number" min={2} max={200} value={maPeriod}
                    onChange={e => setMaPeriod(Math.max(2, Math.min(200, parseInt(e.target.value) || 20)))}
                    style={{ ...inp, width: '60px' }} />
                  <div style={{ width: '10px', height: '2px', background: '#3b82f6', flexShrink: 0 }} />
                </div>
              )}
            </div>
            {[{ name: 'Bollinger Bands' }, { name: 'RSI' }, { name: 'MACD' }].map(ind => (
              <div key={ind.name} style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: 0.4 }}>
                <div style={{ fontSize: '0.73rem', fontWeight: 700, color: '#e5e5e5' }}>{ind.name}</div>
                <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)', marginTop: '2px' }}>Coming soon</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Drawing panel ─────────────────────────────────────────────────── */}
        {showDrawingPanel && (
          <div style={{
            position: 'absolute', left: '44px', top: 0, bottom: 0, width: '220px',
            background: '#07101f', borderRight: '1px solid rgba(255,255,255,0.08)',
            zIndex: 25, display: 'flex', flexDirection: 'column',
            boxShadow: '4px 0 24px rgba(0,0,0,0.5)',
          }}>
            <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e5e5e5' }}>Drawing Tools</span>
              <button onClick={() => setShowDrawingPanel(false)} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 2px' }}>×</button>
            </div>
            <div style={{ padding: '12px 14px' }}>
              {[
                { icon: '—', label: 'Trend Line' }, { icon: '↔', label: 'Horizontal Line' },
                { icon: '↗', label: 'Ray' },         { icon: '▭', label: 'Rectangle' },
                { icon: '◯', label: 'Circle' },       { icon: '✎', label: 'Text Annotation' },
              ].map(t => (
                <div key={t.label} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: 0.45, cursor: 'default' }}>
                  <span style={{ width: '28px', height: '28px', borderRadius: '6px', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color: '#a855f7', flexShrink: 0 }}>{t.icon}</span>
                  <div>
                    <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#e5e5e5' }}>{t.label}</div>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)' }}>Coming soon</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ══ CHART AREA ════════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>

        {/* Market selector card */}
        <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 5, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => {
              setShowMkt(v => !v); setMktSearch('')
              setShowChartMenu(false); setShowIndicators(false); setShowDrawingPanel(false)
            }}
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
            <span style={{ width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0, background: 'linear-gradient(135deg,#FCA311 0%,#c97000 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 900, color: '#000' }}>
              {symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}
            </span>
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e5e5e5', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
                {displayName}
              </div>
              {livePrice != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '1px' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 800, color: priceColor, fontVariantNumeric: 'tabular-nums', transition: 'color 0.18s', animation: priceDir ? 'pricePulse 0.25s ease' : 'none' }}>
                    {fmt(livePrice, decimalPlaces)}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: changeColor, fontVariantNumeric: 'tabular-nums' }}>
                    {priceChange >= 0 ? '+' : ''}{fmt(priceChange, decimalPlaces)}
                  </span>
                </div>
              )}
            </div>
            <span style={{ color: 'rgba(229,229,229,0.35)', fontSize: '0.65rem', marginLeft: '2px' }}>▾</span>
          </button>

          {/* Live/connecting dot */}
          <span style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(6,13,24,0.8)', borderRadius: '6px', padding: '4px 8px', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: connected ? '#22c55e' : '#444', boxShadow: connected ? '0 0 6px #22c55e88' : 'none', animation: connected ? 'pulse 2s ease infinite' : 'none' }} />
            <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.28)' }}>{connected ? 'Live' : 'Connecting'}</span>
          </span>
        </div>

        {/* Zoom / crosshair controls */}
        <div style={{ position: 'absolute', bottom: '38px', left: '12px', zIndex: 5, display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {[
            { title: 'Zoom in',          icon: '+',  action: () => zoom('in'),  active: false },
            { title: crosshair ? 'Disable crosshair' : 'Enable crosshair', icon: '◇', action: toggleCrosshair, active: crosshair },
            { title: 'Zoom out',         icon: '−',  action: () => zoom('out'), active: false },
            { title: 'Scroll to latest', icon: '→|', action: () => chartRef.current?.timeScale().scrollToRealTime(), active: false },
          ].map(b => (
            <button key={b.title} title={b.title} onClick={b.action} style={{ width: '26px', height: '26px', borderRadius: '5px', background: b.active ? 'rgba(252,163,17,0.15)' : 'rgba(6,13,24,0.8)', border: b.active ? '1px solid rgba(252,163,17,0.4)' : '1px solid rgba(255,255,255,0.07)', color: b.active ? '#FCA311' : 'rgba(200,215,235,0.55)', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none' }}>
              {b.icon}
            </button>
          ))}
        </div>

        {/* Lightweight-charts canvas */}
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />

        {/* Market selector dialog — zIndex 30/35 so it covers toolbar (z=20) */}
        {showMkt && (
          <>
            <div onClick={() => setShowMkt(false)} style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.2)' }} />
            <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '520px', zIndex: 35, background: '#070f1e', borderRight: '1px solid rgba(255,255,255,0.07)', display: 'flex', boxShadow: '8px 0 40px rgba(0,0,0,0.65)' }}>
              {/* Category sidebar */}
              <div style={{ width: '155px', flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '14px 14px 10px', fontSize: '0.8rem', fontWeight: 700, color: 'rgba(229,229,229,0.75)', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>Markets</div>
                {[{ icon: '◉', label: 'Derived', active: true }].map(cat => (
                  <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 14px', background: cat.active ? 'rgba(252,163,17,0.09)' : 'transparent', borderLeft: cat.active ? '2px solid #FCA311' : '2px solid transparent', cursor: 'default' }}>
                    <span style={{ fontSize: '0.7rem', color: cat.active ? '#FCA311' : 'rgba(229,229,229,0.4)' }}>{cat.icon}</span>
                    <span style={{ fontSize: '0.73rem', fontWeight: cat.active ? 700 : 400, color: cat.active ? '#FCA311' : 'rgba(229,229,229,0.5)' }}>{cat.label}</span>
                  </div>
                ))}
              </div>
              {/* Symbol list */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '8px', padding: '8px 12px', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5"/><path d="M9 9L12 12" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    <input autoFocus type="text" placeholder="Search markets…" value={mktSearch}
                      onChange={e => setMktSearch(e.target.value)}
                      style={{ background: 'none', border: 'none', outline: 'none', color: '#e5e5e5', fontSize: '0.78rem', flex: 1 }} />
                    {mktSearch && <button onClick={() => setMktSearch('')} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', padding: 0, fontSize: '1rem' }}>×</button>}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}>
                  {loadingMkts && <div style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>Loading markets…</div>}
                  {!loadingMkts && Object.entries(marketGroups).map(([group, syms]) => (
                    <div key={group}>
                      <div style={{ padding: '10px 14px 4px', fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{group}</div>
                      {syms.map(m => {
                        const isSel = m.symbol === symbol
                        return (
                          <button key={m.symbol}
                            onClick={() => { setSymbol(m.symbol); setShowMkt(false) }}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px', background: isSel ? 'rgba(252,163,17,0.07)' : 'transparent', border: 'none', borderLeft: isSel ? '2px solid #FCA311' : '2px solid transparent', color: isSel ? '#FCA311' : 'rgba(229,229,229,0.75)', cursor: 'pointer', textAlign: 'left', opacity: m.exchange_is_open ? 1 : 0.45 }}
                          >
                            <span style={{ width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0, background: isSel ? 'rgba(252,163,17,0.18)' : 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.52rem', fontWeight: 800, color: isSel ? '#FCA311' : 'rgba(229,229,229,0.4)' }}>
                              {m.symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.75rem', fontWeight: isSel ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.display_name}</div>
                              {!m.exchange_is_open && <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.3)' }}>Closed</div>}
                            </div>
                            {isSel && <span style={{ color: '#FCA311', fontSize: '0.8rem' }}>✓</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {!loadingMkts && Object.keys(marketGroups).length === 0 && (
                    <div style={{ textAlign: 'center', padding: '2.5rem', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>No markets found</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Click-outside backdrop: closes all toolbar panels when clicking the chart.
            At root z=15 (below toolbar z=20), so panel elements still receive clicks. */}
        {(showChartMenu || showIndicators || showDrawingPanel) && (
          <div
            onClick={closeAll}
            style={{ position: 'absolute', inset: 0, zIndex: 15 }}
          />
        )}
      </div>

      {/* ══ TRADING PANEL ═══════════════════════════════════════════════════════ */}
      <div style={{ width: '272px', flexShrink: 0, background: '#07101f', borderLeft: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>

        {/* Contract type tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          {TRADE_TYPES.map((tt, i) => (
            <button key={tt.id}
              onClick={() => { setTradeTypeIdx(i); setSideA(true); setPropA(null); setPropB(null) }}
              style={{ flex: 1, padding: '9px 0', background: 'transparent', border: 'none', color: tradeTypeIdx === i ? '#FCA311' : 'rgba(229,229,229,0.38)', borderBottom: tradeTypeIdx === i ? '2px solid #FCA311' : '2px solid transparent', fontSize: '0.6rem', fontWeight: 800, cursor: 'pointer', letterSpacing: '0.03em', outline: 'none' }}
            >
              {tt.id}
            </button>
          ))}
        </div>

        {/* Panel body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'rgba(229,229,229,0.6)' }}>{currentTT.label}</div>

          {/* Side selector A / B */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {([true, false] as const).map(isA => {
              const label = isA ? currentTT.labelA : currentTT.labelB
              const color = isA ? currentTT.colorA : currentTT.colorB
              return (
                <button key={String(isA)} onClick={() => setSideA(isA)} style={{ flex: 1, padding: '9px 4px', borderRadius: '7px', border: 'none', cursor: 'pointer', background: sideA === isA ? color : 'rgba(255,255,255,0.05)', color: sideA === isA ? '#fff' : 'rgba(229,229,229,0.45)', fontSize: '0.78rem', fontWeight: 700, transition: 'all 0.12s', outline: 'none' }}>
                  {label}
                </button>
              )
            })}
          </div>

          {/* Signal analyzer (OU only) */}
          {currentTT.id === 'OU' && (
            <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '9px', padding: '9px 10px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '7px' }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.45)', letterSpacing: '0.05em' }}>SIGNAL</span>
                <button onClick={() => setAutoOn(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', background: autoOn ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.05)', border: `1px solid ${autoOn ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '5px', padding: '3px 8px', outline: 'none', transition: 'all 0.15s' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: autoOn ? '#22c55e' : 'rgba(229,229,229,0.25)', boxShadow: autoOn ? '0 0 5px #22c55e88' : 'none', animation: autoOn ? 'pulse 2s ease infinite' : 'none' }} />
                  <span style={{ fontSize: '0.58rem', fontWeight: 700, color: autoOn ? '#22c55e' : 'rgba(229,229,229,0.35)' }}>Auto {autoOn ? 'ON' : 'OFF'}</span>
                </button>
              </div>
              {bestSignal && digitTotal >= 20 && (
                <div style={{ background: 'rgba(252,163,17,0.07)', border: '1px solid rgba(252,163,17,0.18)', borderRadius: '7px', padding: '7px 9px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)', marginBottom: '2px' }}>Recommended</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#FCA311' }}>
                      {bestSignal.side === 'over' ? 'Over' : 'Under'} {bestSignal.barrier}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)', marginBottom: '2px' }}>Win rate</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: bestSignal.prob > 0.8 ? '#22c55e' : bestSignal.prob > 0.7 ? '#FCA311' : '#aaa' }}>
                      {(bestSignal.prob * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                <button onClick={() => setSigFilter('All')} style={{ padding: '4px 7px', borderRadius: '5px', border: 'none', cursor: 'pointer', background: sigFilter === 'All' ? 'rgba(252,163,17,0.18)' : 'rgba(255,255,255,0.05)', color: sigFilter === 'All' ? '#FCA311' : 'rgba(229,229,229,0.45)', fontSize: '0.62rem', fontWeight: 700, outline: sigFilter === 'All' ? '1px solid rgba(252,163,17,0.35)' : 'none' }}>All</button>
                {signalData.map(s => {
                  const isOver = s.side === 'over'
                  const isBest = bestSignal?.label === s.label
                  const isSel  = sigFilter === s.label
                  const baseColor = isOver ? '#22c55e' : '#3b82f6'
                  const pctText = digitTotal >= 20 ? `${(s.prob * 100).toFixed(0)}%` : '--'
                  return (
                    <button key={s.label}
                      title={`${s.side === 'over' ? 'Over' : 'Under'} ${s.barrier} — ${pctText}`}
                      onClick={() => { setSigFilter(s.label); setDigit(s.barrier); setSideA(s.side === 'over') }}
                      style={{ padding: '4px 6px', borderRadius: '5px', border: 'none', cursor: 'pointer', background: isSel ? `${baseColor}22` : isBest ? 'rgba(252,163,17,0.1)' : 'rgba(255,255,255,0.04)', color: isSel ? baseColor : isBest ? '#FCA311' : 'rgba(229,229,229,0.4)', fontSize: '0.6rem', fontWeight: 700, outline: isBest && !isSel ? '1px solid rgba(252,163,17,0.3)' : isSel ? `1px solid ${baseColor}55` : 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', transition: 'all 0.1s' }}
                    >
                      <span>{s.label}</span>
                      <span style={{ fontSize: '0.48rem', opacity: 0.75 }}>{pctText}</span>
                    </button>
                  )
                })}
              </div>
              {digitTotal < 20 && <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.2)', marginTop: '6px' }}>Collecting tick data…</div>}
            </div>
          )}

          {/* Digit selector (OU and MD only) */}
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
                    <button key={d} onClick={() => setDigit(d)} style={{ padding: '8px 3px', borderRadius: '7px', border: `1px solid ${isSel ? color : 'rgba(255,255,255,0.06)'}`, background: isSel ? `${color}1a` : 'rgba(255,255,255,0.025)', color: isSel ? color : 'rgba(229,229,229,0.65)', cursor: 'pointer', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', transition: 'all 0.1s', outline: 'none' }}>
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
            <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>Duration</div>
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

          {/* Proposal display */}
          {activeProp && !activeProp.error && (
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '9px 11px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.32)' }}>Price</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{fmt2(activeProp.ask_price)} {currency}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.32)' }}>Payout</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>{fmt2(activeProp.payout)} {currency}</span>
              </div>
            </div>
          )}

          {activeProp?.error && (
            <div style={{ fontSize: '0.65rem', color: '#ef4444', padding: '7px 9px', background: 'rgba(239,68,68,0.08)', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.15)' }}>
              {activeProp.error.slice(0, 80)}
            </div>
          )}

          {buyError && (
            <div style={{ fontSize: '0.65rem', color: '#ef4444', padding: '7px 9px', background: 'rgba(239,68,68,0.08)', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.2)', animation: 'lossFlash 0.4s ease' }}>
              ⚠ {buyError}
            </div>
          )}

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
            disabled={!authReady || !!buying || !activeProp?.id || !!activeProp?.error}
            style={{ width: '100%', padding: '14px 8px', borderRadius: '10px', border: 'none', background: authReady && activeProp?.id && !activeProp.error && !buying ? activeColor : 'rgba(255,255,255,0.06)', color: authReady && activeProp?.id && !activeProp.error ? '#fff' : 'rgba(229,229,229,0.2)', cursor: authReady && activeProp?.id && !activeProp.error && !buying ? 'pointer' : 'not-allowed', transition: 'all 0.15s', outline: 'none', flexShrink: 0 }}
          >
            {buying ? (
              <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>Placing order…</div>
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
                {!authReady && !wsError && (
                  <div style={{ fontSize: '0.68rem', fontWeight: 400, marginTop: '3px', opacity: 0.6 }}>Connecting…</div>
                )}
              </>
            )}
          </button>
        </div>

        {/* Auth WS status bar */}
        <div style={{ flexShrink: 0, padding: '7px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: authReady ? '#22c55e' : wsError === 'reconnecting' ? '#FCA311' : '#444', boxShadow: authReady ? '0 0 5px #22c55e88' : 'none', animation: authReady ? 'pulse 2s ease infinite' : 'none' }} />
          <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.25)' }}>
            {authReady
              ? `Authenticated · ${currency}${balance != null ? ` · ${fmt2(balance)}` : ''}`
              : wsError === 'login' ? 'Not logged in'
              : wsError === 'reconnecting' ? 'Reconnecting…'
              : wsError === 'lost' ? 'Disconnected'
              : 'Connecting…'}
          </span>
        </div>
      </div>

      <style>{`
        @keyframes pulse      { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes pricePulse { 0%{opacity:0.5} 100%{opacity:1} }
        @keyframes winFlash   { 0%{background:rgba(34,197,94,0.2)} 100%{background:transparent} }
        @keyframes lossFlash  { 0%{background:rgba(239,68,68,0.2)} 100%{background:transparent} }
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
