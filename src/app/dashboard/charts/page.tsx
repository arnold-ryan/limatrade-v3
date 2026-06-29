'use client'

/**
 * Lima Trade — Charts Page v80
 *
 * Correct two-WebSocket architecture (modelled from dbtraders.com compiled source):
 *
 *   PUBLIC WS  wss://api.derivws.com/trading/v1/options/ws/public
 *     → active_symbols   (market list + pip sizes)
 *     → ticks            (live price stream)
 *     → ticks_history    (seed chart + digit counts)
 *
 *   AUTH WS    (OTP URL from /api/user/ws-url)
 *     → balance          (live balance)
 *     → proposal A/B     (price quotes — auth WS, not public)
 *     → buy              (purchase contract)
 *     → proposal_open_contract (monitor open contracts)
 *     → forget_all       (cleanup)
 *
 * Why proposals go on AUTH WS:
 *   The public WS is market-data only. Proposals need account context
 *   (currency, account type) which only the authenticated WS carries.
 *   This was confirmed from dbtraders.com source which uses api.send()
 *   on the authenticated connection for all trading operations.
 *
 * Deriv API rules (from schema docs + source):
 *   - proposal.id (UUID) is passed directly to buy.buy field
 *   - buy.price = max price willing to pay (use ask_price * 1.02 buffer)
 *   - Proposal UUID is consumed on buy → must forget_all + resubscribe immediately
 *   - POC is_sold === 1 means contract settled
 *   - Last digit = Math.abs(Math.round(price * 10**dp)) % 10
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  IChartApi,
  UTCTimestamp,
  ISeriesApi,
  LineData,
  CandlestickData,
  AreaData,
} from 'lightweight-charts'

// ─── Constants ───────────────────────────────────────────────────────────────
const PUB_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'

const TRADE_TYPES = [
  { id: 'OU', label: 'Over / Under',   ctA: 'DIGITOVER',  ctB: 'DIGITUNDER', labelA: 'Over',  labelB: 'Under',  colorA: '#22c55e', colorB: '#3b82f6', hasBarrier: true  },
  { id: 'EO', label: 'Even / Odd',     ctA: 'DIGITEVEN',  ctB: 'DIGITODD',   labelA: 'Even',  labelB: 'Odd',    colorA: '#22c55e', colorB: '#3b82f6', hasBarrier: false },
  { id: 'MD', label: 'Match / Differ', ctA: 'DIGITMATCH', ctB: 'DIGITDIFF',  labelA: 'Match', labelB: 'Differ', colorA: '#22c55e', colorB: '#ef4444', hasBarrier: true  },
  { id: 'RF', label: 'Rise / Fall',    ctA: 'CALL',       ctB: 'PUT',        labelA: 'Rise',  labelB: 'Fall',   colorA: '#22c55e', colorB: '#ef4444', hasBarrier: false },
]

const TIMEFRAMES = [
  { label: '1T',  granularity: 0     },
  { label: '1m',  granularity: 60    },
  { label: '5m',  granularity: 300   },
  { label: '15m', granularity: 900   },
  { label: '1h',  granularity: 3600  },
  { label: '4h',  granularity: 14400 },
  { label: '1D',  granularity: 86400 },
]

// ─── Types ────────────────────────────────────────────────────────────────────
interface MarketSymbol {
  symbol: string
  display_name: string
  pip: number
  dp: number                      // decimal places = -log10(pip)
  submarket: string
  isOpen: boolean
}

interface Proposal {
  id: string                      // UUID → passed to buy
  ask: number
  payout: number
  err?: string
}

interface Position {
  id: number
  contractType: string
  side: 'A' | 'B'
  tt: typeof TRADE_TYPES[number]
  buyPrice: number
  payout: number
  bidPrice: number
  profit: number
  status: 'open' | 'won' | 'lost' | 'sold' | 'cancelled'
  barrier?: string
  epoch: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const d2 = (n: number) => n.toFixed(2)
const df  = (n: number, dp: number) => n.toFixed(dp)

function lastDigit(price: number, dp: number): number {
  return Math.abs(Math.round(price * 10 ** dp)) % 10
}

function simpleMA(prices: number[], period: number): (number | null)[] {
  return prices.map((_, i) => {
    if (i < period - 1) return null
    const s = prices.slice(i - period + 1, i + 1)
    return s.reduce((a, b) => a + b, 0) / period
  })
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ChartsPage() {

  // ── Layout toggles ──────────────────────────────────────────────────────────
  const [showTfMenu,      setShowTfMenu]      = useState(false)
  const [showIndicators,  setShowIndicators]  = useState(false)
  const [showDrawing,     setShowDrawing]      = useState(false)
  const [showMarketDlg,  setShowMarketDlg]   = useState(false)
  const [mktSearch,      setMktSearch]       = useState('')

  const closeAllPanels = useCallback(() => {
    setShowTfMenu(false)
    setShowIndicators(false)
    setShowDrawing(false)
  }, [])

  // ── Chart config ─────────────────────────────────────────────────────────────
  const [tfIdx,      setTfIdx]      = useState(0)               // timeframe index
  const [chartType,  setChartType]  = useState<'area'|'candles'|'line'>('area')
  const [maOn,       setMaOn]       = useState(false)
  const [maPeriod,   setMaPeriod]   = useState(20)
  const [crosshair,  setCrosshair]  = useState(false)
  const tf = TIMEFRAMES[tfIdx]
  const isTickMode = tf.granularity === 0

  // ── Market ────────────────────────────────────────────────────────────────────
  const [symbol,    setSymbol]    = useState('R_100')
  const [markets,   setMarkets]   = useState<MarketSymbol[]>([])
  const [mktsLoaded,setMktsLoaded]= useState(false)

  const symbolRef = useRef(symbol)
  useEffect(() => { symbolRef.current = symbol }, [symbol])

  const curMarket = markets.find(m => m.symbol === symbol)
  const dp        = curMarket?.dp ?? 2
  const dpRef     = useRef(dp)
  useEffect(() => { dpRef.current = dp }, [dp])

  // ── Price ─────────────────────────────────────────────────────────────────────
  const [livePrice,  setLivePrice]  = useState<number | null>(null)
  const [priceDir,   setPriceDir]   = useState<'up'|'dn'|null>(null)
  const [priceDelta, setPriceDelta] = useState(0)
  const prevPriceRef = useRef<number | null>(null)

  // ── Digit counts ──────────────────────────────────────────────────────────────
  const [digits,     setDigits]     = useState<number[]>(new Array(10).fill(0))
  const [digitTotal, setDigitTotal] = useState(0)

  // ── Trade params ──────────────────────────────────────────────────────────────
  const [ttIdx,   setTtIdx]   = useState(0)          // trade type index
  const [sideA,   setSideA]   = useState(true)       // true = side A (Over/Even/Match/Rise)
  const [stake,   setStake]   = useState('1.00')
  const [dur,     setDur]     = useState(1)           // duration in ticks
  const [barrier, setBarrier] = useState(5)           // digit barrier 0-9
  const tt = TRADE_TYPES[ttIdx]
  const ttRef    = useRef(tt)
  const stakeRef = useRef(stake)
  const durRef   = useRef(dur)
  const barrierRef = useRef(barrier)
  useEffect(() => { ttRef.current     = tt      }, [tt])
  useEffect(() => { stakeRef.current  = stake   }, [stake])
  useEffect(() => { durRef.current    = dur     }, [dur])
  useEffect(() => { barrierRef.current = barrier }, [barrier])

  // ── Proposals (from AUTH WS) ──────────────────────────────────────────────────
  const [propA, setPropA] = useState<Proposal | null>(null)
  const [propB, setPropB] = useState<Proposal | null>(null)
  const propARef = useRef<Proposal | null>(null)
  const propBRef = useRef<Proposal | null>(null)
  useEffect(() => { propARef.current = propA }, [propA])
  useEffect(() => { propBRef.current = propB }, [propB])

  const activeProp = sideA ? propA : propB

  // ── Buy state ──────────────────────────────────────────────────────────────────
  const [buying,   setBuying]   = useState(false)
  const [buyErr,   setBuyErr]   = useState<string | null>(null)

  // ── Positions ──────────────────────────────────────────────────────────────────
  const [openPos,   setOpenPos]   = useState<Position[]>([])
  const [closedPos, setClosedPos] = useState<Position[]>([])

  // ── Auth WS state ─────────────────────────────────────────────────────────────
  const [authReady,   setAuthReady]   = useState(false)
  const [wsErr,       setWsErr]       = useState<string | null>(null)   // 'login' | 'reconnecting' | 'lost' | null
  const [balance,     setBalance]     = useState<number | null>(null)
  const [currency,    setCurrency]    = useState('USD')
  const currencyRef = useRef('USD')
  useEffect(() => { currencyRef.current = currency }, [currency])

  // ── Pub WS state ──────────────────────────────────────────────────────────────
  const [connected, setConnected] = useState(false)

  // ── WS refs ───────────────────────────────────────────────────────────────────
  const pubWsRef  = useRef<WebSocket | null>(null)
  const authWsRef = useRef<WebSocket | null>(null)

  // ── Chart refs ────────────────────────────────────────────────────────────────
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef          = useRef<IChartApi | null>(null)
  const areaRef    = useRef<ISeriesApi<'Area'>        | null>(null)
  const candleRef  = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRef    = useRef<ISeriesApi<'Line'>        | null>(null)
  const maRef      = useRef<ISeriesApi<'Line'>        | null>(null)

  const tickPrices = useRef<number[]>([])
  const tickTimes  = useRef<UTCTimestamp[]>([])
  const curCandle  = useRef<CandlestickData | null>(null)

  // ── Request ID counter + buy-request map ─────────────────────────────────────
  const reqId  = useRef(100)
  const buyMap = useRef<Map<number, { side: 'A'|'B', tt: typeof TRADE_TYPES[number], barrier?: string }>>(new Map())

  // ── Stable refs for WS callbacks ──────────────────────────────────────────────
  const tfIdxRef    = useRef(tfIdx)
  const maOnRef     = useRef(maOn)
  const maPeriodRef = useRef(maPeriod)
  const isTickRef   = useRef(isTickMode)
  useEffect(() => { tfIdxRef.current    = tfIdx      }, [tfIdx])
  useEffect(() => { maOnRef.current     = maOn       }, [maOn])
  useEffect(() => { maPeriodRef.current = maPeriod   }, [maPeriod])
  useEffect(() => { isTickRef.current   = isTickMode }, [isTickMode])

  // ── Market filter + groups ────────────────────────────────────────────────────
  const filteredMkts = mktSearch
    ? markets.filter(m =>
        m.display_name.toLowerCase().includes(mktSearch.toLowerCase()) ||
        m.symbol.toLowerCase().includes(mktSearch.toLowerCase())
      )
    : markets

  const mktGroups = filteredMkts.reduce<Record<string, MarketSymbol[]>>((acc, m) => {
    if (!acc[m.submarket]) acc[m.submarket] = []
    acc[m.submarket].push(m)
    return acc
  }, {})

  // ─── Chart helpers ────────────────────────────────────────────────────────────
  const clearSeries = useCallback(() => {
    const c = chartRef.current
    if (!c) return
    ;[areaRef, candleRef, lineRef, maRef].forEach(r => {
      if (r.current) { try { c.removeSeries(r.current) } catch {} ; r.current = null }
    })
  }, [])

  const addMA = useCallback(() => {
    if (!chartRef.current || !maOnRef.current) return
    maRef.current = chartRef.current.addLineSeries({
      color: '#3b82f6', lineWidth: 1, lastValueVisible: false, priceLineVisible: false,
    })
    const prices = tickPrices.current
    const times  = tickTimes.current
    if (!prices.length) return
    const vals = simpleMA(prices, maPeriodRef.current)
    const data = vals
      .map((v, i) => v !== null ? { time: times[i], value: v } as LineData : null)
      .filter(Boolean) as LineData[]
    if (data.length) maRef.current.setData(data)
  }, [])

  const buildSeries = useCallback(() => {
    clearSeries()
    const c = chartRef.current
    if (!c) return
    const type = isTickRef.current ? 'area' : chartType

    if (type === 'area') {
      areaRef.current = c.addAreaSeries({
        lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.22)',
        bottomColor: 'rgba(252,163,17,0)', lineWidth: 2,
      })
      const data = tickTimes.current.map((t, i) => ({ time: t, value: tickPrices.current[i] })) as AreaData[]
      if (data.length) areaRef.current.setData(data)
      addMA()
    } else if (type === 'line') {
      lineRef.current = c.addLineSeries({ color: '#FCA311', lineWidth: 2 })
      const data = tickTimes.current.map((t, i) => ({ time: t, value: tickPrices.current[i] })) as LineData[]
      if (data.length) lineRef.current.setData(data)
      addMA()
    } else {
      candleRef.current = c.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      })
      // candle data set by ticks_history handler
    }
  }, [chartType, clearSeries, addMA])

  // ─── Append one tick to active series ─────────────────────────────────────────
  const appendTick = useCallback((epoch: number, price: number) => {
    const t = epoch as UTCTimestamp
    if (isTickRef.current) {
      tickPrices.current.push(price)
      tickTimes.current.push(t)
      if (tickPrices.current.length > 2000) {
        tickPrices.current.shift()
        tickTimes.current.shift()
      }
      const pt = { time: t, value: price }
      areaRef.current?.update(pt as AreaData)
      lineRef.current?.update(pt as LineData)
      if (maRef.current && maOnRef.current) {
        const p = tickPrices.current
        const n = maPeriodRef.current
        if (p.length >= n) {
          const slice = p.slice(-n)
          const avg = slice.reduce((a, b) => a + b, 0) / n
          maRef.current.update({ time: t, value: avg } as LineData)
        }
      }
    } else {
      // Candle mode: bucket ticks into candle periods
      const gran = TIMEFRAMES[tfIdxRef.current].granularity
      const bucket = (Math.floor(epoch / gran) * gran) as UTCTimestamp
      const cur = curCandle.current
      if (cur && cur.time === bucket) {
        const updated: CandlestickData = {
          time: bucket, open: cur.open,
          high: Math.max(cur.high, price),
          low: Math.min(cur.low, price),
          close: price,
        }
        curCandle.current = updated
        candleRef.current?.update(updated)
      } else {
        const nc: CandlestickData = { time: bucket, open: price, high: price, low: price, close: price }
        curCandle.current = nc
        candleRef.current?.update(nc)
      }
    }
  }, [])

  // ─── Proposal subscription (AUTH WS) ─────────────────────────────────────────
  const subscribeProposals = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    // Cancel existing proposals first
    ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 998 }))
    setPropA(null)
    setPropB(null)

    const amount  = parseFloat(stakeRef.current) || 1
    const curTT   = ttRef.current
    const bar     = curTT.hasBarrier ? String(barrierRef.current) : undefined
    const base = {
      proposal: 1, subscribe: 1,
      basis: 'stake', amount,
      currency: currencyRef.current,
      underlying_symbol: symbolRef.current,
      duration: durRef.current,
      duration_unit: 't',
    }
    ws.send(JSON.stringify({ ...base, contract_type: curTT.ctA, ...(bar ? { barrier: bar } : {}), req_id: 10 }))
    ws.send(JSON.stringify({ ...base, contract_type: curTT.ctB, ...(bar ? { barrier: bar } : {}), req_id: 11 }))
  }, [])

  // ─── History request (PUBLIC WS) ─────────────────────────────────────────────
  const requestHistory = useCallback((ws: WebSocket, sym: string, granularity: number) => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (granularity === 0) {
      ws.send(JSON.stringify({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks', req_id: 3 }))
    } else {
      ws.send(JSON.stringify({ ticks_history: sym, count: 500, end: 'latest', style: 'candles', granularity, req_id: 3 }))
    }
  }, [])

  // ─── Tick subscription (PUBLIC WS) ───────────────────────────────────────────
  const subscribeTicks = useCallback((ws: WebSocket, sym: string) => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 999 }))
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1, req_id: 2 }))
  }, [])

  // ─── PUBLIC WebSocket ─────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket
    let ping: ReturnType<typeof setInterval>
    let dead = false

    function connect() {
      ws = new WebSocket(PUB_WS_URL)
      pubWsRef.current = ws

      ws.onopen = () => {
        if (dead) return
        setConnected(true)
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 }))
        subscribeTicks(ws, symbolRef.current)
        requestHistory(ws, symbolRef.current, TIMEFRAMES[tfIdxRef.current].granularity)
        ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1, req_id: 900 }))
        }, 25_000)
      }

      ws.onmessage = (ev: MessageEvent) => {
        if (dead) return
        let msg: any
        try { msg = JSON.parse(ev.data as string) } catch { return }

        // active_symbols
        if (msg.msg_type === 'active_symbols') {
          const list: MarketSymbol[] = (msg.active_symbols as any[]).map((s: any) => {
            const pip = s.pip as number
            const dp  = Math.round(-Math.log10(pip))
            return {
              symbol:   s.symbol,
              display_name: s.display_name,
              pip,
              dp,
              submarket: s.submarket_display_name,
              isOpen:   !!s.exchange_is_open,
            }
          })
          setMarkets(list)
          setMktsLoaded(true)
        }

        // live tick
        if (msg.msg_type === 'tick') {
          const tick = msg.tick as { symbol: string; quote: number; epoch: number }
          if (tick.symbol !== symbolRef.current) return
          const price = tick.quote
          const prev  = prevPriceRef.current
          setLivePrice(price)
          if (prev !== null) {
            setPriceDir(price > prev ? 'up' : price < prev ? 'dn' : null)
            setPriceDelta(price - prev)
          }
          prevPriceRef.current = price
          setConnected(true)

          // digit counting
          const d = lastDigit(price, dpRef.current)
          setDigits(prev => { const n = [...prev]; n[d]++; return n })
          setDigitTotal(t => t + 1)

          // chart
          appendTick(tick.epoch, price)
        }

        // ticks_history (style: ticks)
        if (msg.msg_type === 'history' && msg.req_id === 3) {
          const h = msg.history as { times: number[]; prices: number[] }
          if (!h?.times?.length) return
          tickPrices.current = [...h.prices]
          tickTimes.current  = h.times.map(t => t as UTCTimestamp)

          // seed digit counts
          const counts = new Array(10).fill(0)
          h.prices.forEach(p => { counts[lastDigit(p, dpRef.current)]++ })
          setDigits(counts)
          setDigitTotal(h.prices.length)

          // push to chart series
          const areaData = h.times.map((t, i) => ({ time: t as UTCTimestamp, value: h.prices[i] }))
          areaRef.current?.setData(areaData as AreaData[])
          lineRef.current?.setData(areaData as LineData[])

          // rebuild MA
          if (maOnRef.current && maRef.current) {
            const ma = simpleMA(h.prices, maPeriodRef.current)
            const maData = ma
              .map((v, i) => v !== null ? { time: h.times[i] as UTCTimestamp, value: v } as LineData : null)
              .filter(Boolean) as LineData[]
            maRef.current.setData(maData)
          }
        }

        // ticks_history (style: candles)
        if (msg.msg_type === 'candles' && msg.req_id === 3) {
          const candles = msg.candles as Array<{ epoch: number; open: number; high: number; low: number; close: number }>
          if (!candles?.length) return
          const data: CandlestickData[] = candles.map(c => ({
            time: c.epoch as UTCTimestamp,
            open: c.open, high: c.high, low: c.low, close: c.close,
          }))
          candleRef.current?.setData(data)
          curCandle.current = data[data.length - 1]
          // also store close prices for MA
          tickPrices.current = candles.map(c => c.close)
          tickTimes.current  = candles.map(c => c.epoch as UTCTimestamp)
        }
      }

      ws.onerror = () => setConnected(false)
      ws.onclose = () => {
        setConnected(false)
        if (!dead) setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      dead = true
      clearInterval(ping)
      ws?.close()
      pubWsRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── AUTH WebSocket ───────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval>
    let dead = false
    let retries = 0

    async function connect() {
      try {
        const r = await fetch('/api/user/ws-url', { cache: 'no-store' })
        if (!r.ok) { setWsErr('login'); return }
        const { wsUrl } = await r.json()
        if (!wsUrl) { setWsErr('login'); return }

        ws = new WebSocket(wsUrl)
        authWsRef.current = ws

        ws.onopen = () => {
          if (dead) return
          retries = 0
          setAuthReady(true)
          setWsErr(null)
          // subscribe to balance
          ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
          // subscribe to proposals once auth is ready
          subscribeProposals(ws!)
          // keep-alive
          ping = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1, req_id: 901 }))
          }, 25_000)
        }

        ws.onmessage = (ev: MessageEvent) => {
          if (dead) return
          let msg: any
          try { msg = JSON.parse(ev.data as string) } catch { return }

          if (msg.error?.code === 'AuthorizationRequired' || msg.error?.code === 'InvalidToken') {
            setWsErr('login'); ws?.close(); return
          }

          // balance
          if (msg.msg_type === 'balance') {
            const b = msg.balance as { balance: number; currency: string }
            setBalance(b.balance)
            if (b.currency) setCurrency(b.currency)
          }

          // proposal (req 10 = side A, req 11 = side B)
          if (msg.msg_type === 'proposal') {
            if (msg.error) {
              const err = msg.error.message ?? 'Proposal error'
              if (msg.req_id === 10) setPropA({ id: '', ask: 0, payout: 0, err })
              if (msg.req_id === 11) setPropB({ id: '', ask: 0, payout: 0, err })
              return
            }
            const p = msg.proposal as { id: string; ask_price: number; payout: number }
            const prop: Proposal = { id: p.id, ask: p.ask_price, payout: p.payout }
            if (msg.req_id === 10) setPropA(prop)
            if (msg.req_id === 11) setPropB(prop)
          }

          // buy response
          if (msg.msg_type === 'buy') {
            if (msg.error) {
              setBuying(false)
              setBuyErr(msg.error.message ?? 'Buy failed')
              // IMPORTANT: proposal UUID was consumed — must resubscribe even on error
              if (ws?.readyState === WebSocket.OPEN) subscribeProposals(ws)
              return
            }
            const b = msg.buy as {
              contract_id: number; buy_price: number; payout: number;
              balance_after: number; purchase_time: number
            }
            const meta = buyMap.current.get(msg.req_id as number)
            buyMap.current.delete(msg.req_id as number)
            setBuying(false)
            setBuyErr(null)
            setBalance(b.balance_after)

            if (meta) {
              const pos: Position = {
                id: b.contract_id,
                contractType: meta.side === 'A' ? meta.tt.ctA : meta.tt.ctB,
                side: meta.side,
                tt: meta.tt,
                buyPrice: b.buy_price,
                payout: b.payout,
                bidPrice: b.buy_price,
                profit: 0,
                status: 'open',
                barrier: meta.barrier,
                epoch: b.purchase_time,
              }
              setOpenPos(prev => [pos, ...prev])

              // subscribe to POC for this contract
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  proposal_open_contract: 1,
                  contract_id: b.contract_id,
                  subscribe: 1,
                  req_id: ++reqId.current,
                }))
              }
            }

            // CRITICAL: resubscribe proposals — old UUID is consumed
            if (ws?.readyState === WebSocket.OPEN) subscribeProposals(ws)
          }

          // proposal_open_contract updates
          if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
            const poc = msg.proposal_open_contract as {
              contract_id: number
              is_sold: number
              status: string
              bid_price: string
              profit: string
            }
            const cid    = poc.contract_id
            const settled = poc.is_sold === 1
            const status  = poc.status as Position['status']
            const bid    = parseFloat(poc.bid_price ?? '0')
            const profit = parseFloat(poc.profit ?? '0')

            if (settled) {
              setOpenPos(prev => prev.filter(p => p.id !== cid))
              setClosedPos(prev => {
                const orig = prev.find(p => p.id === cid) ?? null
                const updated: Position = orig
                  ? { ...orig, bidPrice: bid, profit, status }
                  : { id: cid, contractType: '', side: 'A', tt: TRADE_TYPES[0], buyPrice: 0, payout: 0, bidPrice: bid, profit, status, epoch: 0 }
                return [updated, ...prev.filter(p => p.id !== cid)].slice(0, 50)
              })
            } else {
              setOpenPos(prev => prev.map(p => p.id === cid ? { ...p, bidPrice: bid, profit, status } : p))
            }
          }
        }

        ws.onerror = () => setAuthReady(false)
        ws.onclose = () => {
          setAuthReady(false)
          authWsRef.current = null
          if (dead) return
          retries++
          if (retries > 5) { setWsErr('lost'); return }
          setWsErr('reconnecting')
          setTimeout(connect, Math.min(retries * 2000, 10_000))
        }
      } catch {
        if (!dead) setTimeout(connect, 5000)
      }
    }

    connect()
    return () => {
      dead = true
      clearInterval(ping)
      ws?.close()
      authWsRef.current = null
    }
  }, [subscribeProposals]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Symbol change ────────────────────────────────────────────────────────────
  useEffect(() => {
    // Reset chart + digit data
    tickPrices.current = []
    tickTimes.current  = []
    curCandle.current  = null
    setDigits(new Array(10).fill(0))
    setDigitTotal(0)
    setLivePrice(null)
    prevPriceRef.current = null

    const pub  = pubWsRef.current
    const auth = authWsRef.current
    if (pub?.readyState === WebSocket.OPEN) {
      subscribeTicks(pub, symbol)
      requestHistory(pub, symbol, TIMEFRAMES[tfIdxRef.current].granularity)
    }
    // Resubscribe proposals for new symbol on auth WS
    if (auth?.readyState === WebSocket.OPEN) subscribeProposals(auth)
  }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Timeframe change ─────────────────────────────────────────────────────────
  useEffect(() => {
    tickPrices.current = []
    tickTimes.current  = []
    curCandle.current  = null
    const pub = pubWsRef.current
    if (pub?.readyState === WebSocket.OPEN)
      requestHistory(pub, symbolRef.current, tf.granularity)
    // rebuild chart series for new mode
    buildSeries()
  }, [tfIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Chart type / MA change ───────────────────────────────────────────────────
  useEffect(() => {
    if (chartRef.current) buildSeries()
  }, [chartType, maOn, maPeriod, buildSeries])

  // ─── Trade params change → resubscribe proposals ─────────────────────────────
  useEffect(() => {
    setSideA(true)
    const auth = authWsRef.current
    if (auth?.readyState === WebSocket.OPEN) subscribeProposals(auth)
  }, [ttIdx, stake, dur, barrier, subscribeProposals])

  // ─── Chart init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartContainerRef.current) return
    const chart = createChart(chartContainerRef.current, {
      layout:     { background: { color: '#060d1b' }, textColor: 'rgba(229,229,229,0.5)' },
      grid:       { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair:  { mode: 0 },
      timeScale:  { borderColor: 'rgba(255,255,255,0.07)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.07)' },
      handleScroll: true, handleScale: true,
    })
    chartRef.current = chart
    // Initial area series
    areaRef.current = chart.addAreaSeries({
      lineColor: '#FCA311', topColor: 'rgba(252,163,17,0.22)',
      bottomColor: 'rgba(252,163,17,0)', lineWidth: 2,
    })

    const ro = new ResizeObserver(([e]) => {
      chart.applyOptions({ width: e.contentRect.width, height: e.contentRect.height })
    })
    ro.observe(chartContainerRef.current)

    return () => {
      ro.disconnect()
      try { chart.remove() } catch {}
      chartRef.current = null
      areaRef.current  = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Crosshair toggle ─────────────────────────────────────────────────────────
  const toggleCrosshair = useCallback(() => {
    setCrosshair(v => {
      chartRef.current?.applyOptions({ crosshair: { mode: !v ? 1 : 0 } })
      return !v
    })
  }, [])

  // ─── Zoom ─────────────────────────────────────────────────────────────────────
  const zoom = useCallback((dir: 'in'|'out') => {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    const range = ts.getVisibleLogicalRange()
    if (!range) return
    const d = (range.to - range.from) * (dir === 'in' ? 0.15 : -0.15)
    ts.setVisibleLogicalRange({ from: range.from + d, to: range.to - d })
  }, [])

  // ─── Buy ──────────────────────────────────────────────────────────────────────
  const doBuy = useCallback(() => {
    const ws = authWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || buying) return
    const prop = sideA ? propARef.current : propBRef.current
    if (!prop?.id || prop.err) { setBuyErr('Price not ready — please wait'); return }
    const ask = Number(prop.ask)
    if (!ask || isNaN(ask)) { setBuyErr('Invalid price'); return }

    setBuying(true)
    setBuyErr(null)

    const rid = ++reqId.current
    buyMap.current.set(rid, {
      side: sideA ? 'A' : 'B',
      tt: ttRef.current,
      barrier: ttRef.current.hasBarrier ? String(barrierRef.current) : undefined,
    })

    // price = max price willing to pay (2% buffer covers minor slippage)
    const maxPrice = parseFloat((ask * 1.02).toFixed(2))
    ws.send(JSON.stringify({ buy: prop.id, price: maxPrice, req_id: rid }))

    // Safety timeout
    setTimeout(() => {
      if (buyMap.current.has(rid)) {
        buyMap.current.delete(rid)
        setBuying(false)
        setBuyErr('No response from server')
      }
    }, 12_000)
  }, [buying, sideA])

  // ─── Style helpers ────────────────────────────────────────────────────────────
  const priceColor  = priceDir === 'up' ? '#22c55e' : priceDir === 'dn' ? '#ef4444' : '#e5e5e5'
  const deltaColor  = priceDelta >= 0 ? '#22c55e' : '#ef4444'
  const activeColor = sideA ? tt.colorA : tt.colorB
  const inp: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px', color: '#e5e5e5', padding: '6px 10px',
    fontSize: '0.78rem', outline: 'none',
  }
  const btnTool: React.CSSProperties = {
    width: '40px', height: '40px', borderRadius: '8px', border: 'none',
    background: 'transparent', cursor: 'pointer', outline: 'none',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: '2px', color: 'rgba(200,215,235,0.5)',
    transition: 'all 0.12s',
  }

  // ─── Digit signal for OU ──────────────────────────────────────────────────────
  const ouSignals: Array<{ label: string; barrier: number; side: 'A'|'B'; prob: number }> = [
    ...[1,2,3,4,5].map(b => {
      let w = 0; for (let d = b+1; d <= 9; d++) w += digits[d]
      return { label: `Over ${b}`, barrier: b, side: 'A' as const, prob: digitTotal > 0 ? w/digitTotal : 0 }
    }),
    ...[4,5,6,7,8].map(b => {
      let w = 0; for (let d = 0; d < b; d++) w += digits[d]
      return { label: `Under ${b}`, barrier: b, side: 'B' as const, prob: digitTotal > 0 ? w/digitTotal : 0 }
    }),
  ]

  const bestSignal = digitTotal >= 25
    ? ouSignals.reduce((best, s) => s.prob > best.prob ? s : best)
    : null

  // ─── Total P&L ────────────────────────────────────────────────────────────────
  const totalPL = [...openPos, ...closedPos].reduce((s, p) => s + p.profit, 0)

  // ──────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex', width: '100%', height: '100%', overflow: 'hidden',
      background: '#060d1b', color: '#e5e5e5',
      fontFamily: 'Inter, system-ui, sans-serif', fontSize: '14px',
    }}>

      {/* ── POSITIONS SIDEBAR ─────────────────────────────────────────────────── */}
      <div style={{
        width: '252px', flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        background: '#07101f', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Positions
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {openPos.length === 0 && closedPos.length === 0 && (
            <div style={{ padding: '28px 14px', textAlign: 'center', color: 'rgba(229,229,229,0.15)', fontSize: '0.7rem' }}>No positions yet</div>
          )}
          {openPos.map(p => (
            <div key={p.id} style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.015)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: p.side === 'A' ? p.tt.colorA : p.tt.colorB }}>
                  {p.side === 'A' ? p.tt.labelA : p.tt.labelB}{p.barrier ? ` ${p.barrier}` : ''}
                </span>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: p.profit >= 0 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                  {p.profit >= 0 ? '+' : ''}{d2(p.profit)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.28)' }}>{p.contractType}</span>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.28)', fontVariantNumeric: 'tabular-nums' }}>
                  ⏳ {d2(p.bidPrice)}
                </span>
              </div>
            </div>
          ))}
          {closedPos.slice(0, 25).map(p => (
            <div key={`c-${p.id}`} style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)', opacity: 0.55 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(229,229,229,0.55)' }}>
                  {p.side === 'A' ? p.tt.labelA : p.tt.labelB}{p.barrier ? ` ${p.barrier}` : ''}
                </span>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: p.status === 'won' ? '#22c55e' : p.status === 'lost' ? '#ef4444' : '#888', fontVariantNumeric: 'tabular-nums' }}>
                  {p.profit >= 0 ? '+' : ''}{d2(p.profit)}
                </span>
              </div>
              <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.22)', textTransform: 'uppercase' }}>{p.status}</span>
            </div>
          ))}
        </div>
        {(openPos.length + closedPos.length) > 0 && (
          <div style={{ flexShrink: 0, padding: '7px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.28)' }}>Total P&L</span>
            <span style={{ fontSize: '0.75rem', fontWeight: 800, color: totalPL >= 0 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
              {totalPL >= 0 ? '+' : ''}{d2(totalPL)}
            </span>
          </div>
        )}
      </div>

      {/* ── LEFT TOOLBAR ──────────────────────────────────────────────────────────
          zIndex: 20 establishes a stacking context at root level z=20.
          All dropdowns/panels inside are at z=25 within this context,
          which is above the chart backdrop at root z=15. ─────────────────────── */}
      <div style={{
        width: '44px', flexShrink: 0, background: '#07101f',
        borderRight: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: '80px', paddingBottom: '8px',
        position: 'relative', zIndex: 20,
      }}>

        {/* TF + Chart type button */}
        <div style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => { setShowTfMenu(v => !v); setShowIndicators(false); setShowDrawing(false) }}
            style={{ ...btnTool, color: showTfMenu ? '#FCA311' : undefined, background: showTfMenu ? 'rgba(252,163,17,0.1)' : 'transparent' }}
            title="Timeframe & chart type"
          >
            <span style={{ fontSize: '0.58rem', fontWeight: 800, lineHeight: 1, color: 'inherit' }}>{tf.label}</span>
            <span style={{ fontSize: '0.44rem', color: 'inherit', opacity: 0.7 }}>{isTickMode ? 'Area' : chartType}</span>
          </button>

          {/* TF / chart-type dropdown — z=25 within toolbar stacking context */}
          {showTfMenu && (
            <div style={{
              position: 'absolute', top: 0, left: '48px',
              background: '#0c1829', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px', padding: '14px', width: '210px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.7)', zIndex: 25,
            }}>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Timeframe</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '14px' }}>
                {TIMEFRAMES.map((t, i) => (
                  <button key={t.label}
                    onClick={() => { setTfIdx(i); setShowTfMenu(false) }}
                    style={{
                      padding: '5px 9px', borderRadius: '5px', border: 'none', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700,
                      background: tfIdx === i ? 'rgba(252,163,17,0.2)' : 'rgba(255,255,255,0.06)',
                      color:      tfIdx === i ? '#FCA311' : 'rgba(229,229,229,0.5)',
                      outline:    tfIdx === i ? '1px solid rgba(252,163,17,0.4)' : 'none',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {!isTickMode && (
                <>
                  <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Chart type</div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {(['area','candles','line'] as const).map(ct => (
                      <button key={ct}
                        onClick={() => { setChartType(ct); setShowTfMenu(false) }}
                        style={{
                          flex: 1, padding: '7px 4px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.62rem', fontWeight: 700,
                          background: chartType === ct ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.05)',
                          color:      chartType === ct ? '#FCA311' : 'rgba(229,229,229,0.4)',
                          outline:    chartType === ct ? '1px solid rgba(252,163,17,0.35)' : 'none',
                          textTransform: 'capitalize',
                        }}
                      >
                        {ct}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ width: '28px', height: '1px', background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />

        {/* Indicators button */}
        <div style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => { setShowIndicators(v => !v); setShowTfMenu(false); setShowDrawing(false) }}
            style={{ ...btnTool, color: showIndicators ? '#3b82f6' : undefined, background: showIndicators ? 'rgba(59,130,246,0.1)' : 'transparent' }}
            title="Indicators"
          >
            <svg width="15" height="13" viewBox="0 0 15 13" fill="none"><path d="M1 10 Q4 3 7 7 Q10 11 13 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span style={{ fontSize: '0.44rem', color: 'inherit', opacity: 0.7 }}>Indicat.</span>
          </button>

          {/* Indicators panel */}
          {showIndicators && (
            <div style={{
              position: 'absolute', top: 0, left: '48px',
              background: '#0c1829', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px', padding: '14px', width: '220px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)', zIndex: 25,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>Indicators</span>
                <button onClick={() => setShowIndicators(false)} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1 }}>×</button>
              </div>
              {/* MA toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '8px' }}>
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: maOn ? '#3b82f6' : '#e5e5e5' }}>Moving Average</div>
                  <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.3)', marginTop: '2px' }}>Simple MA overlay</div>
                </div>
                <div
                  onClick={() => setMaOn(v => !v)}
                  style={{ width: '34px', height: '18px', borderRadius: '9px', cursor: 'pointer', flexShrink: 0, background: maOn ? '#3b82f6' : 'rgba(255,255,255,0.1)', position: 'relative', transition: 'background 0.2s' }}
                >
                  <div style={{ position: 'absolute', top: '2px', width: '14px', height: '14px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', left: maOn ? '18px' : '2px' }} />
                </div>
              </div>
              {maOn && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.4)' }}>Period</span>
                  <input type="number" min={2} max={200} value={maPeriod}
                    onChange={e => setMaPeriod(Math.max(2, Math.min(200, parseInt(e.target.value) || 20)))}
                    style={{ ...inp, width: '60px' }}
                  />
                  <div style={{ width: '10px', height: '2px', background: '#3b82f6', flexShrink: 0, borderRadius: '1px' }} />
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ width: '28px', height: '1px', background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />

        {/* Crosshair */}
        <button
          onClick={toggleCrosshair}
          style={{ ...btnTool, color: crosshair ? '#FCA311' : undefined, background: crosshair ? 'rgba(252,163,17,0.1)' : 'transparent' }}
          title="Toggle crosshair"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2"/><line x1="7" y1="0" x2="7" y2="4" stroke="currentColor" strokeWidth="1.2"/><line x1="7" y1="10" x2="7" y2="14" stroke="currentColor" strokeWidth="1.2"/><line x1="0" y1="7" x2="4" y2="7" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="7" x2="14" y2="7" stroke="currentColor" strokeWidth="1.2"/></svg>
          <span style={{ fontSize: '0.44rem', color: 'inherit', opacity: 0.7 }}>Cross</span>
        </button>

        {/* Zoom in */}
        <button onClick={() => zoom('in')} style={btnTool} title="Zoom in">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><line x1="6" y1="4" x2="6" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          <span style={{ fontSize: '0.44rem', color: 'inherit', opacity: 0.7 }}>Zoom+</span>
        </button>

        {/* Zoom out */}
        <button onClick={() => zoom('out')} style={btnTool} title="Zoom out">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><line x1="3.5" y1="6" x2="8.5" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          <span style={{ fontSize: '0.44rem', color: 'inherit', opacity: 0.7 }}>Zoom−</span>
        </button>

        {/* Scroll to latest */}
        <button
          onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
          style={btnTool}
          title="Scroll to latest"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7 H11 M8 4 L11 7 L8 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span style={{ fontSize: '0.44rem', color: 'inherit', opacity: 0.7 }}>Latest</span>
        </button>
      </div>

      {/* ── CHART AREA ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>

        {/* Market selector card */}
        <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 5, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => { setShowMarketDlg(v => !v); setMktSearch(''); closeAllPanels() }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: 'rgba(6,13,27,0.9)', borderRadius: '9px', padding: '7px 10px',
              border: showMarketDlg ? '1px solid rgba(252,163,17,0.5)' : '1px solid rgba(255,255,255,0.08)',
              cursor: 'pointer', outline: 'none', backdropFilter: 'blur(8px)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
            }}
          >
            <span style={{ width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0, background: 'linear-gradient(135deg,#FCA311,#c97000)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.48rem', fontWeight: 900, color: '#000' }}>
              {symbol.replace(/[^A-Z0-9]/gi,'').slice(0,3).toUpperCase()}
            </span>
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e5e5e5', whiteSpace: 'nowrap' }}>
                {curMarket?.display_name ?? symbol}
              </div>
              {livePrice != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '1px' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 800, color: priceColor, fontVariantNumeric: 'tabular-nums' }}>
                    {df(livePrice, dp)}
                  </span>
                  <span style={{ fontSize: '0.62rem', color: deltaColor, fontVariantNumeric: 'tabular-nums' }}>
                    {priceDelta >= 0 ? '+' : ''}{df(priceDelta, dp)}
                  </span>
                </div>
              )}
            </div>
            <span style={{ color: 'rgba(229,229,229,0.3)', fontSize: '0.6rem', marginLeft: '2px' }}>▾</span>
          </button>

          {/* Live dot */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(6,13,27,0.85)', borderRadius: '6px', padding: '4px 8px', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: connected ? '#22c55e' : '#555', boxShadow: connected ? '0 0 6px #22c55e88' : 'none', animation: connected ? 'pulse 2s infinite' : 'none' }} />
            <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.28)' }}>{connected ? 'Live' : 'Connecting…'}</span>
          </div>
        </div>

        {/* Chart canvas */}
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />

        {/* Market dialog — root z=30 covers toolbar z=20 */}
        {showMarketDlg && (
          <>
            <div onClick={() => setShowMarketDlg(false)} style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.25)' }} />
            <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '500px', zIndex: 35, background: '#070f1e', borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', boxShadow: '8px 0 40px rgba(0,0,0,0.7)' }}>
              <div style={{ width: '140px', flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '13px 12px 8px', fontSize: '0.78rem', fontWeight: 700, color: 'rgba(229,229,229,0.7)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>Markets</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', borderLeft: '2px solid #FCA311' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#FCA311' }}>Derived</span>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '7px', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="rgba(229,229,229,0.3)" strokeWidth="1.3"/><path d="M8.5 8.5L11.5 11.5" stroke="rgba(229,229,229,0.3)" strokeWidth="1.3" strokeLinecap="round"/></svg>
                    <input autoFocus type="text" placeholder="Search markets…" value={mktSearch}
                      onChange={e => setMktSearch(e.target.value)}
                      style={{ background: 'none', border: 'none', outline: 'none', color: '#e5e5e5', fontSize: '0.78rem', flex: 1 }}
                    />
                    {mktSearch && <button onClick={() => setMktSearch('')} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', padding: 0, fontSize: '1rem' }}>×</button>}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}>
                  {!mktsLoaded && <div style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.75rem' }}>Loading markets…</div>}
                  {mktsLoaded && Object.entries(mktGroups).map(([group, syms]) => (
                    <div key={group}>
                      <div style={{ padding: '9px 14px 3px', fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{group}</div>
                      {syms.map(m => {
                        const sel = m.symbol === symbol
                        return (
                          <button key={m.symbol}
                            onClick={() => { setSymbol(m.symbol); setShowMarketDlg(false) }}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '9px', padding: '8px 14px', background: sel ? 'rgba(252,163,17,0.07)' : 'transparent', border: 'none', borderLeft: sel ? '2px solid #FCA311' : '2px solid transparent', color: sel ? '#FCA311' : 'rgba(229,229,229,0.7)', cursor: 'pointer', textAlign: 'left', opacity: m.isOpen ? 1 : 0.45 }}
                          >
                            <span style={{ width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0, background: sel ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>
                              {m.symbol.replace(/[^A-Z0-9]/gi,'').slice(0,3).toUpperCase()}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.73rem', fontWeight: sel ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.display_name}</div>
                              {!m.isOpen && <div style={{ fontSize: '0.56rem', color: 'rgba(229,229,229,0.28)' }}>Closed</div>}
                            </div>
                            {sel && <span style={{ color: '#FCA311', fontSize: '0.75rem' }}>✓</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {mktsLoaded && Object.keys(mktGroups).length === 0 && (
                    <div style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.75rem' }}>No markets found</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Click-outside backdrop — root z=15, below toolbar z=20 so toolbar panels still receive clicks */}
        {(showTfMenu || showIndicators || showDrawing) && (
          <div onClick={closeAllPanels} style={{ position: 'absolute', inset: 0, zIndex: 15 }} />
        )}
      </div>

      {/* ── TRADING PANEL ────────────────────────────────────────────────────────── */}
      <div style={{ width: '268px', flexShrink: 0, background: '#07101f', borderLeft: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>

        {/* Trade type tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          {TRADE_TYPES.map((t, i) => (
            <button key={t.id}
              onClick={() => { setTtIdx(i); setSideA(true); setPropA(null); setPropB(null) }}
              style={{ flex: 1, padding: '10px 0', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.6rem', fontWeight: 800, outline: 'none', letterSpacing: '0.03em', color: ttIdx === i ? '#FCA311' : 'rgba(229,229,229,0.33)', borderBottom: ttIdx === i ? '2px solid #FCA311' : '2px solid transparent' }}
            >
              {t.id}
            </button>
          ))}
        </div>

        {/* Panel body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'rgba(229,229,229,0.55)' }}>{tt.label}</div>

          {/* Side selector */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {([true, false] as const).map(isA => {
              const label = isA ? tt.labelA : tt.labelB
              const color = isA ? tt.colorA : tt.colorB
              const active = sideA === isA
              return (
                <button key={String(isA)}
                  onClick={() => setSideA(isA)}
                  style={{ flex: 1, padding: '10px 4px', borderRadius: '7px', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, outline: 'none', transition: 'all 0.12s', background: active ? color : 'rgba(255,255,255,0.05)', color: active ? '#fff' : 'rgba(229,229,229,0.4)' }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* OU Signal analyzer */}
          {tt.id === 'OU' && (
            <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '9px', padding: '9px 10px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.4)', letterSpacing: '0.05em', marginBottom: '7px' }}>
                SIGNAL ({digitTotal} ticks)
              </div>
              {bestSignal && (
                <div style={{ background: 'rgba(252,163,17,0.07)', border: '1px solid rgba(252,163,17,0.18)', borderRadius: '7px', padding: '6px 9px', marginBottom: '7px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)' }}>Best signal</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#FCA311' }}>{bestSignal.label}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)' }}>Win rate</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: bestSignal.prob > 0.8 ? '#22c55e' : '#FCA311' }}>{(bestSignal.prob * 100).toFixed(1)}%</div>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                {ouSignals.map(s => {
                  const isOver  = s.label.startsWith('Over')
                  const color   = isOver ? '#22c55e' : '#3b82f6'
                  const isBest  = bestSignal?.label === s.label
                  const pct     = digitTotal >= 10 ? `${(s.prob * 100).toFixed(0)}%` : '–'
                  return (
                    <button key={s.label}
                      onClick={() => { setBarrier(s.barrier); setSideA(s.side === 'A') }}
                      style={{
                        padding: '4px 6px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                        background: isBest ? `${color}18` : 'rgba(255,255,255,0.04)',
                        color: isBest ? color : 'rgba(229,229,229,0.38)',
                        fontSize: '0.6rem', fontWeight: 700,
                        outline: isBest ? `1px solid ${color}55` : 'none',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                      }}
                    >
                      <span>{s.label.split(' ')[1]}{isOver ? '↑' : '↓'}</span>
                      <span style={{ fontSize: '0.48rem', opacity: 0.75 }}>{pct}</span>
                    </button>
                  )
                })}
              </div>
              {digitTotal < 10 && <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.2)', marginTop: '5px' }}>Collecting data…</div>}
            </div>
          )}

          {/* Digit grid (OU + MD) */}
          {tt.hasBarrier && (
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>
                Digit ({barrier})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '3px' }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => {
                  const pct  = digitTotal > 0 ? (digits[d] / digitTotal) * 100 : 0
                  const sel  = barrier === d
                  const col  = sideA ? tt.colorA : tt.colorB
                  return (
                    <button key={d}
                      onClick={() => setBarrier(d)}
                      style={{
                        padding: '8px 2px', borderRadius: '7px', border: `1px solid ${sel ? col : 'rgba(255,255,255,0.06)'}`,
                        background: sel ? `${col}1a` : 'rgba(255,255,255,0.025)',
                        color: sel ? col : 'rgba(229,229,229,0.6)', cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', outline: 'none', transition: 'all 0.1s',
                      }}
                    >
                      <span style={{ fontSize: '0.85rem', fontWeight: 800, lineHeight: 1 }}>{d}</span>
                      <span style={{ fontSize: '0.54rem', lineHeight: 1, opacity: 0.8 }}>{pct.toFixed(1)}%</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Duration */}
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>Duration</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="number" min={1} max={10} value={dur}
                onChange={e => setDur(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                style={{ ...inp, width: '60px' }}
              />
              <span style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.35)' }}>ticks</span>
            </div>
          </div>

          {/* Stake */}
          <div>
            <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>
              Stake ({currency})
            </div>
            <input type="number" min="0.35" step="0.01" value={stake}
              onChange={e => setStake(e.target.value)}
              style={{ ...inp, width: '100%' }}
            />
          </div>

          {/* Proposal info */}
          {activeProp && !activeProp.err && (
            <div style={{ background: 'rgba(255,255,255,0.025)', borderRadius: '8px', padding: '9px 11px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)' }}>Price</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{d2(activeProp.ask)} {currency}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)' }}>Payout</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>{d2(activeProp.payout)} {currency}</span>
              </div>
            </div>
          )}

          {activeProp?.err && (
            <div style={{ fontSize: '0.65rem', color: '#ef4444', padding: '7px 9px', background: 'rgba(239,68,68,0.07)', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.15)' }}>
              {activeProp.err.slice(0, 90)}
            </div>
          )}

          {buyErr && (
            <div style={{ fontSize: '0.65rem', color: '#ef4444', padding: '7px 9px', background: 'rgba(239,68,68,0.07)', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.2)' }}>
              ⚠ {buyErr}
            </div>
          )}

          <div style={{ flex: 1 }} />

          {/* Status notes */}
          {wsErr === 'login' && (
            <div style={{ textAlign: 'center', padding: '7px', fontSize: '0.63rem', color: 'rgba(229,229,229,0.3)', background: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
              Login to enable trading
            </div>
          )}
          {wsErr === 'reconnecting' && (
            <div style={{ textAlign: 'center', fontSize: '0.62rem', color: '#FCA311' }}>Reconnecting…</div>
          )}
          {wsErr === 'lost' && (
            <div style={{ textAlign: 'center', fontSize: '0.62rem', color: '#ef4444' }}>Connection lost — please refresh</div>
          )}

          {/* Buy button */}
          <button
            onClick={doBuy}
            disabled={!authReady || buying || !activeProp?.id || !!activeProp?.err}
            style={{
              width: '100%', padding: '14px 8px', borderRadius: '10px', border: 'none', outline: 'none',
              background: authReady && activeProp?.id && !activeProp?.err ? activeColor : 'rgba(255,255,255,0.06)',
              color:      authReady && activeProp?.id && !activeProp?.err ? '#fff' : 'rgba(229,229,229,0.18)',
              cursor:     authReady && activeProp?.id && !activeProp?.err && !buying ? 'pointer' : 'not-allowed',
              transition: 'all 0.15s', flexShrink: 0,
            }}
          >
            <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>
              {buying ? 'Placing order…'
               : wsErr === 'login' ? 'Login to Trade'
               : `Buy ${sideA ? tt.labelA : tt.labelB}`}
            </div>
            {activeProp?.payout && !activeProp.err && !buying && (
              <div style={{ fontSize: '0.68rem', marginTop: '3px', opacity: 0.8 }}>
                Payout {d2(activeProp.payout)} {currency}
              </div>
            )}
            {!authReady && !wsErr && (
              <div style={{ fontSize: '0.65rem', marginTop: '3px', opacity: 0.5 }}>Connecting…</div>
            )}
          </button>
        </div>

        {/* Auth status bar */}
        <div style={{ flexShrink: 0, padding: '7px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: authReady ? '#22c55e' : wsErr ? '#ef4444' : '#555', boxShadow: authReady ? '0 0 5px #22c55e88' : 'none', animation: authReady ? 'pulse 2s infinite' : 'none' }} />
          <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.22)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {authReady
              ? `Auth · ${currency}${balance != null ? ` · ${d2(balance)}` : ''}`
              : wsErr === 'login' ? 'Not logged in'
              : wsErr ? wsErr
              : 'Connecting…'}
          </span>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { opacity: 0.4 }
        input::placeholder { color: rgba(229,229,229,0.2) }
        button:hover:not(:disabled) { filter: brightness(1.12) }
        ::-webkit-scrollbar { width: 3px }
        ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px }
      `}</style>
    </div>
  )
}
