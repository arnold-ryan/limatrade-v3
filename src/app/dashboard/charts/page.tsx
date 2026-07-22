'use client'

/**
 * Lima Trade — Charts Page v167
 *
 * All fixes consolidated:
 *  - proposal request uses `underlying_symbol` (required by new API, not `symbol`)
 *  - passthrough + echo_req + req_id three-layer proposal routing (new API has no contract_type in response body)
 *  - immediate propARef/propBRef clear on market switch (prevents stale-ref buy)
 *  - buy-time sym guard (rejects stale proposal from previous market)
 *  - priceFormat on all chart series + live update on symbol change (digit/chart sync)
 *
 * Backend/WS logic: IDENTICAL to v82 (the last known-working version).
 * Only cosmetic changes applied on top:
 *   - Positions panel moved from bottom → left sidebar (220px)
 *   - Market pill shows "Volatility 100" instead of "R_100" via normalizeName()
 *   - Smooth tick animation: Date.now()/1000 timestamp + scrollToRealTime()
 *
 * Layout:
 *   ┌──────────────────────┬──────────────────────┬────────────────────┐
 *   │  [R_100▼ price] [TFs] [chart type] [MA]     │           • Live   │  ← top bar
 *   ├──────────────┬───────┴──────────────────────┴────────────────────┤
 *   │              │                              │  TRADE TYPE         │
 *   │  POSITIONS   │        CHART                 │  (2×2 grid)         │
 *   │  Open / Hist │                              │  DIGIT (0-9)        │
 *   │  (220px)     │                              │  DUR | STAKE        │
 *   │              │                              │  quick picks        │
 *   │              │                              │  [BUY A] [BUY B]    │
 *   └──────────────┴──────────────────────────────┴─────────────────────┘
 *
 * Two-WebSocket architecture (unchanged from v82):
 *   PUBLIC  wss://api.derivws.com/trading/v1/options/ws/public
 *   AUTH    OTP URL from /api/user/ws-url
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart, IChartApi, UTCTimestamp,
  ISeriesApi, LineData, CandlestickData, AreaData,
} from 'lightweight-charts'
import { bg0, bg1, bg2, bdr, txt0, txt1, txt2, green, red, amber, blue } from '@/lib/colors'

// ─── Constants (unchanged from v82) ──────────────────────────────────────────
const PUB_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'

const TT = [
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

// ─── Types (unchanged from v82) ───────────────────────────────────────────────
interface Sym  { symbol: string; name: string; pip: number; dp: number; group: string; open: boolean }
interface Prop { id: string; ask: number; payout: number; sym?: string; err?: string }
interface Pos  {
  id: number; ct: string; side: 'A'|'B'; ttId: string
  lA: string; lB: string; cA: string; cB: string
  stake: number; payout: number; bid: number; profit: number
  status: 'open'|'won'|'lost'|'sold'; barrier?: string; ts: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const f2  = (n: number) => n.toFixed(2)
const fdp = (n: number, dp: number) => n.toFixed(dp)
const lastDigit = (p: number, dp: number) => Math.abs(Math.round(p * 10 ** dp)) % 10
const sma = (arr: number[], n: number) =>
  arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n)

/** COSMETIC ONLY: R_100 → "Volatility 100", 1HZ100V → "Volatility 100 (1s)" */
function normalizeName(symbol: string, apiName: string): string {
  const clean = (apiName ?? '').trim()
  if (clean && !/^R_\d+$/.test(clean) && !/^1HZ\d+V$/.test(clean)) return clean
  const rMatch = symbol.match(/^R_(\d+)$/)
  if (rMatch) return `Volatility ${rMatch[1]}`
  const hzMatch = symbol.match(/^1HZ(\d+)V$/)
  if (hzMatch) return `Volatility ${hzMatch[1]} (1s)`
  return clean || symbol
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ChartsPage() {

  // ── Market (unchanged from v82) ───────────────────────────────────────────
  const [symbol,  setSymbol]  = useState('R_100')
  const [syms,    setSyms]    = useState<Sym[]>([])
  const [symOpen, setSymOpen] = useState(false)
  const [mktQ,    setMktQ]    = useState('')
  const symbolRef = useRef(symbol)
  useEffect(() => { symbolRef.current = symbol }, [symbol])
  const curSym = syms.find(s => s.symbol === symbol)
  const dp     = curSym?.dp ?? 2
  const dpRef  = useRef(dp)
  useEffect(() => { dpRef.current = dp }, [dp])
  // COSMETIC: always show clean name even before syms loads
  const displayName = curSym?.name ?? normalizeName(symbol, symbol)

  // ── Chart config (unchanged from v82) ─────────────────────────────────────
  const [tfIdx,     setTfIdx]     = useState(0)
  const [chartType, setChartType] = useState<'area'|'line'|'candles'>('area')
  const [maOn,      setMaOn]      = useState(false)
  const [maPeriod]                = useState(20)
  const tf      = TFS[tfIdx]
  const isTick  = tf.gran === 0
  const tfIdxRef    = useRef(tfIdx)
  const maOnRef     = useRef(maOn)
  const maPeriodRef = useRef(maPeriod)
  const isTickRef   = useRef(isTick)
  useEffect(() => { tfIdxRef.current    = tfIdx    }, [tfIdx])
  useEffect(() => { maOnRef.current     = maOn     }, [maOn])
  useEffect(() => { maPeriodRef.current = maPeriod }, [maPeriod])
  useEffect(() => { isTickRef.current   = isTick   }, [isTick])

  // ── Price (unchanged from v82) ────────────────────────────────────────────
  const [price,    setPrice]    = useState<number|null>(null)
  const [priceDir, setPriceDir] = useState<'up'|'dn'|null>(null)
  const prevPriceRef = useRef<number|null>(null)

  // ── Trade state (unchanged from v82) ──────────────────────────────────────
  const [ttIdx,   setTtIdx]   = useState(0)
  const [barrier, setBarrier] = useState(5)
  const [tickDur, setTickDur] = useState(1)
  const [stake,   setStake]   = useState('10.00')
  const tt = TT[ttIdx]

  // ── Proposals ─────────────────────────────────────────────────────────────
  const [propA,   setPropA]   = useState<Prop|null>(null)
  const [propB,   setPropB]   = useState<Prop|null>(null)
  const [buyingA, setBuyingA] = useState(false)
  const [buyingB, setBuyingB] = useState(false)
  // Refs for stable closures (avoid stale values in WS callbacks)
  const propARef    = useRef<Prop|null>(null)
  const propBRef    = useRef<Prop|null>(null)

  // ── Auth / Balance (unchanged from v82) ───────────────────────────────────
  const [balance,   setBalance]   = useState<number|null>(null)
  const [currency,  setCurrency]  = useState('USD')
  const [authReady, setAuthReady] = useState(false)
  const [authErr,   setAuthErr]   = useState<string|null>(null)
  const [authKey,   setAuthKey]   = useState(0)   // bump to force WS reconnect

  // ── Positions ─────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<Pos[]>([])
  const [posTab,    setPosTab]    = useState<'open'|'history'>('open')

  // ── Refs ──────────────────────────────────────────────────────────────────
  const chartEl      = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi|null>(null)
  const seriesRef    = useRef<ISeriesApi<any>|null>(null)
  const maRef        = useRef<ISeriesApi<'Line'>|null>(null)
  const pubRef       = useRef<WebSocket|null>(null)
  const authRef      = useRef<WebSocket|null>(null)
  const pricesRef    = useRef<number[]>([])
  const tsRef        = useRef<number[]>([])
  const propTimerRef = useRef<ReturnType<typeof setTimeout>|null>(null)
  // Stable refs for trade params (read inside WS callbacks without stale-closure issues)
  const stakeRef    = useRef(stake)
  const ttRef       = useRef(tt)
  const barrierRef  = useRef(barrier)
  const currencyRef = useRef(currency)
  const durRef      = useRef(tickDur)
  useEffect(() => { stakeRef.current    = stake    }, [stake])
  useEffect(() => { ttRef.current       = tt       }, [tt])
  useEffect(() => { barrierRef.current  = barrier  }, [barrier])
  useEffect(() => { currencyRef.current = currency }, [currency])
  useEffect(() => { durRef.current      = tickDur  }, [tickDur])
  // Keep propA/B refs in sync with state (for buy-time sym guard)
  useEffect(() => { propARef.current = propA }, [propA])
  useEffect(() => { propBRef.current = propB }, [propB])
  // Track which side was bought — read inside WS onmessage which has a stale buyingA/B closure
  const buyingSideRef  = useRef<'A'|'B'|null>(null)
  // Auto-reset buying state if buy confirmation never arrives (lost response, server error, etc.)
  const buyTimeoutRef  = useRef<ReturnType<typeof setTimeout>|null>(null)

  // ── Signal Analyzer ───────────────────────────────────────────────────────
  const [sigState,  setSigState]  = useState<'analyzing'|'waiting'|'enter'|'cooloff'>('analyzing')
  const [sigRec,    setSigRec]    = useState<{type:'OVER'|'UNDER'|'EVEN'|'ODD'|'MATCH'|'DIFFER'|'RISE'|'FALL'; barrier?:number; edge:number; rsi?:number; channelPos?:number}|null>(null)
  const [digitFreq, setDigitFreq] = useState<number[]>(Array(10).fill(0.1))
  const [sigEdges,  setSigEdges]  = useState<Record<string, number>>({})
  const sigDigitsRef = useRef<number[]>([])
  const sigStateRef  = useRef<'analyzing'|'waiting'|'enter'|'cooloff'>('analyzing')
  const sigTimerRef  = useRef<ReturnType<typeof setTimeout>|null>(null)
  // Keep sigStateRef in sync with React state so WS closure reads fresh value
  useEffect(() => { sigStateRef.current = sigState }, [sigState])
  // Stable refs so settlement handler can read signal state without stale closure
  const sigRecRef        = useRef<{type:'OVER'|'UNDER'|'EVEN'|'ODD'|'MATCH'|'DIFFER'|'RISE'|'FALL'; barrier?:number; edge:number; rsi?:number; channelPos?:number}|null>(null)
  const sigConsecLossRef = useRef(0)
  useEffect(() => { sigRecRef.current = sigRec }, [sigRec])
  // Rise/Fall indicator readings (updated every tick for live panel display)
  const [rfSigData, setRfSigData] = useState<{emaVote:number; rsi:number; rsiVote:number; streak:number; streakVote:number; channelPos:number; channelVote:number; score:number; dir:'RISE'|'FALL'|null}|null>(null)
  const rfPricesRef = useRef<number[]>([])
  // Background recs: best signal for each trade type, kept current every tick
  type BgRec  = { type: 'OVER'|'UNDER'|'EVEN'|'ODD'|'DIFFER'; barrier?: number; edge: number; z: number } | null
  type RFRec  = { type: 'RISE'|'FALL'; score: number; rsi: number; channelPos: number; emaVote: number; streakVote: number; channelVote: number } | null
  const bgRecsRef = useRef<{ OU: BgRec; EO: BgRec; MD: BgRec; RF: RFRec }>({ OU: null, EO: null, MD: null, RF: null })
  // Signal scoring is now a server round trip (see /api/signals/charts) — this
  // guards against firing a second scan request while one is still in flight.
  const sigScanningRef = useRef(false)

  // ── Account-switch listener (unchanged from v82) ──────────────────────────
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

  // ── Visibility: clear stuck buying state when tab regains focus ───────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setBuyingA(false)
        setBuyingB(false)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // ── Signal: compute signal from rolling digit window (all types, every tick) ─
  const runSigCycle = useCallback(async () => {
    const arr = sigDigitsRef.current
    if (arr.length < 60) return  // need ≥60 ticks for statistical confidence
    if (sigScanningRef.current) return  // previous scan still in flight — skip this tick
    sigScanningRef.current = true

    // Scoring (z-score thresholds, window sizes, EMA/RSI/streak/channel weights
    // for Rise/Fall) runs server-side now — see /api/signals/charts. The client
    // only sends recent digit/price history and gets back a decision.
    let data: {
      MD: BgRec; EO: BgRec; OU: BgRec; RF: RFRec
      rfSigData: {emaVote:number; rsi:number; rsiVote:number; streak:number; streakVote:number; channelPos:number; channelVote:number; score:number; dir:'RISE'|'FALL'|null} | null
      edges: Record<string, number>
    } | null = null
    try {
      const res = await fetch('/api/signals/charts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan', digits: arr.slice(-100), prices: rfPricesRef.current.slice(-25) }),
      })
      if (res.ok) data = await res.json()
    } catch { /* network hiccup — try again next tick */ }
    sigScanningRef.current = false
    if (!data) return

    const { MD: bestMD, EO: bestEO, OU: bestOU, RF: bestRF, rfSigData, edges: allEdges } = data
    if (rfSigData) setRfSigData(rfSigData)

    bgRecsRef.current = { MD: bestMD, EO: bestEO, OU: bestOU, RF: bestRF }

    // ── Active type: state machine + edge tile colors ──────────────────────
    // Early return only applies to the state machine, not background computation.
    if (sigStateRef.current === 'cooloff' || sigStateRef.current === 'enter') return

    const tid  = ttRef.current.id

    // ── RF active handling ─────────────────────────────────────────────────
    if (tid === 'RF') {
      if (bestRF) {
        setSigRec({ type: bestRF.type, edge: (bestRF.score - 2) / 2, rsi: bestRF.rsi, channelPos: bestRF.channelPos })
        setSigState('enter')
        if (sigTimerRef.current) clearTimeout(sigTimerRef.current)
        sigTimerRef.current = setTimeout(() => {
          setSigState('cooloff')
          sigTimerRef.current = setTimeout(() => setSigState('analyzing'), 15000)
        }, 5000)
      } else {
        setSigState('waiting')
      }
      return
    }

    const best = tid === 'MD' ? bestMD : tid === 'EO' ? bestEO : bestOU
    setSigEdges(allEdges)

    if (best) {
      setSigRec({ type: best.type, barrier: best.barrier, edge: best.edge })
      setSigState('enter')
      if (sigTimerRef.current) clearTimeout(sigTimerRef.current)
      // enter (5s) → cooloff (15s) → analyzing
      sigTimerRef.current = setTimeout(() => {
        setSigState('cooloff')
        sigTimerRef.current = setTimeout(() => setSigState('analyzing'), 15000)
      }, 5000)
    } else {
      setSigState('waiting')
    }
  }, [])
  // Stable ref so WS closure always calls the latest version
  const runSigCycleRef = useRef(runSigCycle)
  useEffect(() => { runSigCycleRef.current = runSigCycle }, [runSigCycle])

  // Tick handler drives signal checks — no timer needed for analyzing state

  // ══════════════════════════════════════════════════════════════════════════
  // Chart (unchanged from v82)
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!chartEl.current) return
    const cs = getComputedStyle(document.documentElement)
    const cv = (v: string) => cs.getPropertyValue(v).trim()
    const chart = createChart(chartEl.current, {
      layout:    { background: { color: cv('--bg0') }, textColor: cv('--txt1') },
      grid:      { vertLines: { color: cv('--bg1') }, horzLines: { color: cv('--bg1') } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: cv('--bg2') },
      timeScale: {
        borderColor:   cv('--bg2'),
        timeVisible:   true,
        secondsVisible: false,
        rightOffset:   10,   // COSMETIC: breathing room for smooth tracking
        barSpacing:    6,
      },
    })
    chartRef.current = chart
    const obs = new ResizeObserver(() => {
      if (chartEl.current) chart.resize(chartEl.current.offsetWidth, chartEl.current.offsetHeight)
    })
    obs.observe(chartEl.current)

    // lightweight-charts renders to a <canvas> via its own imperative API — it has
    // no idea the `html.light` class exists, so colors captured above are frozen
    // at creation time. Watch for the theme toggle and re-apply them on change.
    const applyTheme = () => {
      const c = getComputedStyle(document.documentElement)
      const v = (name: string) => c.getPropertyValue(name).trim()
      chart.applyOptions({
        layout:          { background: { color: v('--bg0') }, textColor: v('--txt1') },
        grid:            { vertLines: { color: v('--bg1') }, horzLines: { color: v('--bg1') } },
        rightPriceScale: { borderColor: v('--bg2') },
        timeScale:       { borderColor: v('--bg2') },
      })
    }
    const themeObs = new MutationObserver(applyTheme)
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => { themeObs.disconnect(); obs.disconnect(); chart.remove(); chartRef.current = null }
  }, [])

  const rebuildSeries = useCallback((
    type: 'area'|'line'|'candles', ma: boolean, period: number,
    prices: number[], times: number[],
  ) => {
    const chart = chartRef.current
    if (!chart) return
    if (seriesRef.current) { try { chart.removeSeries(seriesRef.current) } catch {} seriesRef.current = null }
    if (maRef.current)     { try { chart.removeSeries(maRef.current)     } catch {} maRef.current     = null }

    // priceFormat must match symbol pip so chart price and digit circles show same decimal places
    const pf = { type: 'price' as const, precision: dpRef.current, minMove: Math.pow(10, -dpRef.current) }

    if (type === 'candles') {
      seriesRef.current = chart.addCandlestickSeries({
        upColor: '#3fb950', downColor: '#f85149',
        borderUpColor: '#3fb950', borderDownColor: '#f85149',
        wickUpColor: '#3fb950', wickDownColor: '#f85149',
        priceFormat: pf,
      })
    } else if (type === 'area') {
      seriesRef.current = chart.addAreaSeries({
        lineColor: '#e6b429', topColor: 'rgba(230,180,41,0.28)',
        bottomColor: 'rgba(230,180,41,0)', lineWidth: 2,
        priceFormat: pf,
      })
    } else {
      seriesRef.current = chart.addLineSeries({ color: '#e6b429', lineWidth: 2, priceFormat: pf })
    }

    if (ma && prices.length >= period) {
      const maS = chart.addLineSeries({ color: '#58a6ff', lineWidth: 1, lineStyle: 2 })
      maRef.current = maS
      const vals = sma(prices, period)
      maS.setData(vals.map((v, i) => v !== null ? { time: times[i] as UTCTimestamp, value: v } : null)
        .filter(Boolean) as LineData[])
    }
  }, [])

  // ══════════════════════════════════════════════════════════════════════════
  // Public WS — market data (unchanged from v82)
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

  useEffect(() => {
    let ws: WebSocket
    let alive = true
    let pingId: ReturnType<typeof setInterval>

    const connect = () => {
      ws = new WebSocket(PUB_WS)
      pubRef.current = ws

      ws.onopen = () => {
        if (!alive) return
        ws.send(JSON.stringify({ active_symbols: 'brief' }))
        ws.send(JSON.stringify({ ticks: symbolRef.current, subscribe: 1 }))
        loadHistory(symbolRef.current, TFS[tfIdxRef.current].gran)
        clearInterval(pingId)
        pingId = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30000)
      }

      ws.onmessage = (e) => {
        if (!alive) return
        const msg = JSON.parse(e.data)
        const sym = symbolRef.current

        // active_symbols — COSMETIC: apply normalizeName to display name
        if (msg.active_symbols) {
          const list: Sym[] = (msg.active_symbols as any[]).map(s => ({
            symbol: s.underlying_symbol,
            name:   normalizeName(s.underlying_symbol, s.underlying_symbol_name ?? s.underlying_symbol),
            pip:    s.pip_size ?? 0.01,
            dp:     s.pip_size ? String(s.pip_size).split('.')[1]?.length ?? 2 : 2,
            group:  s.submarket ?? s.market ?? '',
            open:   s.exchange_is_open === 1,
          }))
          setSyms(list)
        }

        // live tick — COSMETIC: use Date.now()/1000 for sub-second smooth animation
        if (msg.tick && msg.tick.symbol === sym) {
          const p  = msg.tick.quote as number
          const ts = (Date.now() / 1000) as UTCTimestamp   // smooth ticks

          setPrice(prev => {
            setPriceDir(prev === null ? null : p > prev ? 'up' : p < prev ? 'dn' : null)
            prevPriceRef.current = prev
            return p
          })

          // ── Signal: last digit using correct pip size (same lastDigit helper) ──
          const sigDig = lastDigit(p, dpRef.current)
          sigDigitsRef.current.push(sigDig)
          if (sigDigitsRef.current.length > 200) sigDigitsRef.current.splice(0, 100)
          // RF: track raw prices for Rise/Fall indicator computation
          rfPricesRef.current.push(p)
          if (rfPricesRef.current.length > 200) rfPricesRef.current.splice(0, 100)
          const sigWin  = sigDigitsRef.current.slice(-100)
          const sigF    = Array(10).fill(0)
          sigWin.forEach((d: number) => sigF[d]++)
          const sigFreq = sigF.map((c: number) => c / (sigWin.length || 1))
          setDigitFreq(sigFreq)
          // Update live edge colors (all types computed each tick)
          const liveEdges: Record<string, number> = {}
          for (let b = 1; b <= 5; b++) {
            let obs = 0; for (let d = b + 1; d <= 9; d++) obs += sigFreq[d]
            liveEdges[`O${b}`] = obs - (9 - b) / 10
          }
          for (let b = 6; b <= 8; b++) {
            let obs = 0; for (let d = 0; d < b; d++) obs += sigFreq[d]
            liveEdges[`U${b}`] = obs - b / 10
          }
          let obsEvenLive = 0; for (const d of [0,2,4,6,8]) obsEvenLive += sigFreq[d]
          liveEdges['EV'] = obsEvenLive - 0.5
          liveEdges['OD'] = (1 - obsEvenLive) - 0.5
          for (let d = 0; d <= 9; d++) liveEdges[`D${d}`] = sigFreq[d] - 0.1
          setSigEdges(liveEdges)
          // Drive signal checks on every tick — works for both analyzing and waiting
          if (sigStateRef.current === 'analyzing' || sigStateRef.current === 'waiting') {
            runSigCycleRef.current()
          }

          if (isTickRef.current && seriesRef.current) {
            pricesRef.current.push(p)
            tsRef.current.push(ts)
            try {
              ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).update({ time: ts, value: p })
              chartRef.current?.timeScale().scrollToRealTime()   // smooth scroll
            } catch {}
            if (maOnRef.current && maRef.current && pricesRef.current.length >= maPeriodRef.current) {
              const avg = pricesRef.current.slice(-maPeriodRef.current).reduce((a, b) => a + b, 0) / maPeriodRef.current
              try { maRef.current.update({ time: ts, value: avg }) } catch {}
            }
          }
        }

        // candle history
        if (msg.candles && !isTickRef.current && seriesRef.current) {
          const data = (msg.candles as any[]).map(c => ({
            time: c.epoch as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close,
          }))
          pricesRef.current = data.map(c => c.close)
          tsRef.current     = data.map(c => c.time)
          try {
            if (chartType === 'candles') {
              ;(seriesRef.current as ISeriesApi<'Candlestick'>).setData(data as CandlestickData[])
            } else {
              ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).setData(data.map(c => ({ time: c.time, value: c.close })))
            }
            chartRef.current?.timeScale().scrollToRealTime()
          } catch {}
          if (maOnRef.current && maRef.current && pricesRef.current.length >= maPeriodRef.current) {
            const vals = sma(pricesRef.current, maPeriodRef.current)
            try {
              maRef.current.setData(vals.map((v, i) => v !== null ? { time: tsRef.current[i] as UTCTimestamp, value: v } : null).filter(Boolean) as LineData[])
            } catch {}
          }
        }

        // tick history
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
          if (maOnRef.current && maRef.current && prices.length >= maPeriodRef.current) {
            const vals = sma(prices, maPeriodRef.current)
            try {
              maRef.current.setData(vals.map((v, i) => v !== null ? { time: times[i] as UTCTimestamp, value: v } : null).filter(Boolean) as LineData[])
            } catch {}
          }
        }
      }

      ws.onclose = () => {
        clearInterval(pingId)
        if (alive) setTimeout(connect, 2000)
      }
    }

    connect()
    return () => {
      alive = false
      clearInterval(pingId)
      ws?.close()
    }
  }, [loadHistory, chartType]) // eslint-disable-line

  // Update series precision when symbol changes (keeps chart price in sync with digit circles)
  useEffect(() => {
    const pf = { type: 'price' as const, precision: dp, minMove: Math.pow(10, -dp) }
    try { seriesRef.current?.applyOptions({ priceFormat: pf }) } catch {}
    try { maRef.current?.applyOptions({ priceFormat: pf }) } catch {}
  }, [dp])

  // re-subscribe when symbol / TF changes
  useEffect(() => {
    const ws = pubRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'ticks' }))
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }))
    pricesRef.current = []; tsRef.current = []
    rebuildSeries(chartType, maOn, maPeriod, [], [])
    loadHistory(symbol, tf.gran)
    // Reset signal on market switch
    if (sigTimerRef.current) clearTimeout(sigTimerRef.current)
    sigDigitsRef.current = []
    rfPricesRef.current = []
    sigConsecLossRef.current = 0
    bgRecsRef.current = { OU: null, EO: null, MD: null, RF: null }
    setDigitFreq(Array(10).fill(0.1))
    setRfSigData(null)
    setSigRec(null)
    setSigEdges({})
    setSigState('analyzing')
  }, [symbol, tfIdx]) // eslint-disable-line

  useEffect(() => {
    rebuildSeries(chartType, maOn, maPeriod, pricesRef.current, tsRef.current)
    loadHistory(symbol, tf.gran)
  }, [chartType, maOn]) // eslint-disable-line

  // Trade type switch: immediately surface precomputed background rec (no tick wait)
  useEffect(() => {
    if (sigTimerRef.current) clearTimeout(sigTimerRef.current)
    sigConsecLossRef.current = 0
    setSigEdges({})  // edges recomputed on next tick for new type

    const tid = TT[ttIdx].id

    // RF branch — surface precomputed Rise/Fall signal instantly
    if (tid === 'RF') {
      const rfRec = bgRecsRef.current.RF
      if (rfRec) {
        setSigRec({ type: rfRec.type, edge: (rfRec.score - 2) / 2, rsi: rfRec.rsi, channelPos: rfRec.channelPos })
        setSigState('enter')
        sigStateRef.current = 'enter'
        sigTimerRef.current = setTimeout(() => {
          setSigState('cooloff'); sigStateRef.current = 'cooloff'
          sigTimerRef.current = setTimeout(() => { setSigState('analyzing'); sigStateRef.current = 'analyzing' }, 15000)
        }, 5000)
      } else {
        setSigRec(null); setSigState('analyzing'); sigStateRef.current = 'analyzing'
      }
      return
    }

    const bgRec = bgRecsRef.current[tid as 'OU' | 'EO' | 'MD']

    if (bgRec) {
      // Instantly show precomputed signal — no waiting for next tick
      setSigRec({ type: bgRec.type, barrier: bgRec.barrier, edge: bgRec.edge })
      setSigState('enter')
      sigStateRef.current = 'enter'
      sigTimerRef.current = setTimeout(() => {
        setSigState('cooloff')
        sigStateRef.current = 'cooloff'
        sigTimerRef.current = setTimeout(() => {
          setSigState('analyzing'); sigStateRef.current = 'analyzing'
        }, 15000)
      }, 5000)
    } else {
      setSigRec(null)
      setSigState('analyzing')
      sigStateRef.current = 'analyzing'
    }
  }, [ttIdx]) // eslint-disable-line

  // ══════════════════════════════════════════════════════════════════════════
  // Auth WS — balance, proposals, buy  ← UNCHANGED from v82
  // ══════════════════════════════════════════════════════════════════════════
  // Reads all trade params from refs so it's stable — no re-subscription thrash on every state change
  const subscribeProposals = useCallback(() => {
    const ws  = authRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // Immediately clear refs so a stale proposal can't slip through before React flushes
    propARef.current = null
    propBRef.current = null
    setPropA(null)
    setPropB(null)

    ws.send(JSON.stringify({ forget_all: 'proposal' }))

    const cur = ttRef.current
    const sym = symbolRef.current
    const stk = parseFloat(stakeRef.current) || 1
    const base: Record<string, unknown> = {
      proposal: 1, subscribe: 1,
      amount: stk, basis: 'stake',
      currency: currencyRef.current || 'USD',
      underlying_symbol: sym,   // ← new API requires this field (not `symbol`)
      duration: durRef.current,
      duration_unit: 't',
    }
    if (cur.barrier) base.barrier = String(barrierRef.current)

    // passthrough is the official Deriv pattern: baked in at send-time, echoed verbatim in every update
    ws.send(JSON.stringify({ ...base, contract_type: cur.ctA, passthrough: { sym, side: 'A' }, req_id: 10 }))
    ws.send(JSON.stringify({ ...base, contract_type: cur.ctB, passthrough: { sym, side: 'B' }, req_id: 11 }))
  }, []) // stable — all state accessed via refs

  useEffect(() => {
    let ws: WebSocket
    let alive = true

    const connect = async () => {
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) {
          if (!alive) return
          // Don't give up — could be a transient server hiccup; retry after 3 s
          setAuthErr('Reconnecting…')
          setTimeout(connect, 3000)
          return
        }
        const { wsUrl } = await r.json()
        ws = new WebSocket(wsUrl)
        authRef.current = ws
        const socket = ws

        // Guard against a handshake that never resolves (Deriv's OTP-authenticated
        // WS occasionally accepts the connection but never fires onopen/onerror/
        // onclose) — without this, authReady stays false forever with no retry.
        const connectTimeout = setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) { try { socket.close() } catch { /**/ } }
        }, 10_000)

        ws.onopen = () => {
          clearTimeout(connectTimeout)
          if (!alive) return
          ws.send(JSON.stringify({ balance: 1, subscribe: 1 }))
          setAuthReady(true); setAuthErr(null)
        }

        ws.onmessage = async (evt) => {
          if (!alive) return
          try {
          const msg = JSON.parse(evt.data)

          if (msg.balance) {
            const b = Number(msg.balance.balance) || 0
            const cur = msg.balance.currency ?? 'USD'
            setBalance(b)
            setCurrency(cur)
            window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: b, currency: cur } }))
          }

          // Handle proposal errors — new API omits the `proposal` key on errors,
          // so we must check msg.error BEFORE msg.proposal, or it never triggers.
          if (msg.error && msg.echo_req?.proposal === 1) {
            const errMsg = (msg.error as any)?.message ?? 'Error'
            const pt   = (msg.passthrough as any) ?? {}
            const side = pt.side as 'A' | 'B' | undefined
            if      (side === 'A' || msg.req_id === 10) setPropA({ id: '', ask: 0, payout: 0, err: errMsg })
            else if (side === 'B' || msg.req_id === 11) setPropB({ id: '', ask: 0, payout: 0, err: errMsg })
            return
          }

          // Buy errors (insufficient balance, market closed, contract expired, etc.)
          // Without this handler buyingA/B stays true forever → "..." stuck on button.
          if (msg.error && (msg.echo_req?.buy !== undefined || msg.msg_type === 'buy')) {
            if (buyTimeoutRef.current) { clearTimeout(buyTimeoutRef.current); buyTimeoutRef.current = null }
            setBuyingA(false); setBuyingB(false)
            buyingSideRef.current = null
            console.warn('[Lima Trade] Buy error:', (msg.error as any)?.message)
            return
          }

          if (msg.proposal) {
            const p = msg.proposal as { id: string; ask_price: number; payout: number }

            // Layer 1: passthrough — official Deriv pattern; baked at send-time, verbatim on every update
            const pt     = (msg.passthrough as any) ?? {}
            const ptSym  = pt.sym  as string | undefined
            const ptSide = pt.side as 'A' | 'B' | undefined
            // Layer 2: echo_req fallback
            const echoSym = (msg.echo_req as any)?.underlying_symbol as string | undefined
            const echoCt  = (msg.echo_req as any)?.contract_type    as string | undefined
            // Layer 3: discard if from wrong market
            const msgSym = ptSym ?? echoSym
            if (msgSym && msgSym !== symbolRef.current) return

            const cur  = ttRef.current
            // Coerce to number — new Deriv API may return monetary values as strings
            const prop: Prop = { id: p.id, ask: Number(p.ask_price) || 0, payout: Number(p.payout) || 0, sym: msgSym ?? symbolRef.current }
            const isA = ptSide === 'A' || (ptSide === undefined && (echoCt !== undefined ? echoCt === cur.ctA : msg.req_id === 10))
            const isB = ptSide === 'B' || (ptSide === undefined && (echoCt !== undefined ? echoCt === cur.ctB : msg.req_id === 11))
            if      (isA) { propARef.current = prop; setPropA(prop) }
            else if (isB) { propBRef.current = prop; setPropB(prop) }
          }

          if (msg.buy) {
            // Clear the buy timeout — confirmation arrived, no need to auto-reset
            if (buyTimeoutRef.current) { clearTimeout(buyTimeoutRef.current); buyTimeoutRef.current = null }
            const b = msg.buy
            ws.send(JSON.stringify({ forget_all: 'proposal' }))
            const cur = ttRef.current
            const newPos: Pos = {
              id: b.contract_id, ct: b.contract_type,
              // Use ref to read buying side — avoids stale closure (buyingA/B captured at effect creation time)
              side: buyingSideRef.current ?? 'A', ttId: cur.id,
              lA: cur.lA, lB: cur.lB, cA: cur.cA, cB: cur.cB,
              stake: parseFloat(stakeRef.current) || 0, payout: Number(b.buy_price) || 0,
              bid: Number(b.buy_price) || 0, profit: 0,
              status: 'open', barrier: cur.barrier ? String(barrierRef.current) : undefined,
              ts: Date.now(),
            }
            buyingSideRef.current = null
            setPositions(ps => [...ps, newPos])
            setBuyingA(false); setBuyingB(false)
            setTimeout(() => subscribeProposals(), 300)
            ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 }))
          }

          if (msg.proposal_open_contract) {
            const poc = msg.proposal_open_contract
            // Coerce to number — new API may return profit/bid as strings
            const pocProfit   = poc.profit    !== undefined ? Number(poc.profit)    : undefined
            const pocBidPrice = poc.bid_price !== undefined ? Number(poc.bid_price) : undefined
            if (poc.is_sold || poc.status === 'sold') {
              const profit = pocProfit ?? 0
              const status = profit >= 0 ? 'won' : 'lost'
              setPositions(ps => ps.map(p => p.id === poc.contract_id
                ? { ...p, status, profit, bid: pocBidPrice ?? p.bid } : p))
              // ── Signal re-validation on settlement ───────────────────────
              // Whether the specific traded signal still holds is computed
              // server-side now — see /api/signals/charts (action: revalidate).
              if (status === 'won') {
                sigConsecLossRef.current = 0
              } else {
                sigConsecLossRef.current++
                const rec = sigRecRef.current
                let stillValid = false
                if (rec) {
                  try {
                    const r = await fetch('/api/signals/charts', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        action: 'revalidate',
                        digits: sigDigitsRef.current.slice(-100),
                        prices: rfPricesRef.current.slice(-25),
                        rec: { type: rec.type, barrier: rec.barrier },
                        consecLoss: sigConsecLossRef.current,
                      }),
                    })
                    if (r.ok) stillValid = (await r.json()).stillValid === true
                  } catch { /* treat as invalid on network failure */ }
                }
                // Cancel signal if edge is gone OR hit 2 consecutive losses
                if (!stillValid || sigConsecLossRef.current >= 2) {
                  if (sigTimerRef.current) clearTimeout(sigTimerRef.current)
                  sigConsecLossRef.current = 0
                  setSigRec(null)
                  setSigState('analyzing')
                  sigStateRef.current = 'analyzing'
                }
              }
            } else {
              setPositions(ps => ps.map(p => p.id === poc.contract_id
                ? { ...p, profit: pocProfit ?? p.profit, bid: pocBidPrice ?? p.bid } : p))
            }
          }
          } catch (err) { console.error('[Charts WS]', err) }  // prevent any handler error from crashing React
        }

        ws.onclose = () => {
          clearTimeout(connectTimeout)
          if (alive) {
            setAuthReady(false)
            setBuyingA(false); setBuyingB(false)  // un-stick buttons if WS drops mid-buy
            setTimeout(connect, 3000)
          }
        }
      } catch {
        if (!alive) return
        // Network-level error (fetch threw) — retry after 3 s
        setAuthErr('Reconnecting…')
        setTimeout(connect, 3000)
      }
    }

    connect()
    return () => { alive = false; ws?.close() }
  }, [subscribeProposals, authKey]) // v82 deps — unchanged

  // Re-subscribe whenever any trade param or market changes, not just on auth-ready.
  // Debounced 400ms so rapid stake typing doesn't flood the API.
  // Ref-sync effects (symbolRef, stakeRef, ttRef, etc.) all appear earlier in the file
  // so they are guaranteed to run before this effect within the same render flush.
  useEffect(() => {
    if (!authReady) return
    if (propTimerRef.current) clearTimeout(propTimerRef.current)
    propTimerRef.current = setTimeout(subscribeProposals, 400)
  }, [symbol, ttIdx, barrier, tickDur, stake, authReady, subscribeProposals]) // eslint-disable-line

  // ── Buy ───────────────────────────────────────────────────────────────────
  const buy = useCallback((side: 'A'|'B') => {
    const ws   = authRef.current
    // Read from refs for freshest value even if React hasn't re-rendered yet
    const prop = side === 'A' ? propARef.current : propBRef.current
    // Check readyState explicitly — prevents setBuyingA(true) then a failed send leaving the button stuck
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!prop || !prop.id || prop.err) return
    if (buyingA || buyingB) return
    // Guard: reject stale proposal from previous market
    if (prop.sym && prop.sym !== symbolRef.current) return
    // Guard: reject if stake exceeds current balance
    const stakeNum = parseFloat(stakeRef.current)
    if (!Number.isFinite(stakeNum) || stakeNum <= 0) return
    if (balance !== null && stakeNum > balance) return
    buyingSideRef.current = side  // set before state update so WS callback sees it
    if (side === 'A') setBuyingA(true); else setBuyingB(true)

    // 10s safety net: if Deriv never sends msg.buy (lost packet, silent error, rate-limit),
    // auto-reset the button so the user isn't permanently stuck.
    if (buyTimeoutRef.current) clearTimeout(buyTimeoutRef.current)
    buyTimeoutRef.current = setTimeout(() => {
      buyTimeoutRef.current = null
      setBuyingA(false); setBuyingB(false)
      buyingSideRef.current = null
    }, 10000)

    try {
      ws.send(JSON.stringify({ buy: prop.id, price: +(prop.ask * 1.02).toFixed(2) }))
    } catch {
      // WS closed between readyState check and send — un-stick the button immediately
      if (buyTimeoutRef.current) { clearTimeout(buyTimeoutRef.current); buyTimeoutRef.current = null }
      if (side === 'A') setBuyingA(false); else setBuyingB(false)
      buyingSideRef.current = null
    }
  }, [buyingA, buyingB]) // propA/B read from refs inside

  // ── Derived ───────────────────────────────────────────────────────────────
  const openPos   = positions.filter(p => p.status === 'open')
  const closedPos = positions.filter(p => p.status !== 'open')
  const totalPnl  = closedPos.reduce((a, p) => a + p.profit, 0)
  const filteredSyms = syms.filter(s =>
    !mktQ || s.name.toLowerCase().includes(mktQ.toLowerCase()) ||
             s.symbol.toLowerCase().includes(mktQ.toLowerCase())
  )
  const symGroups = filteredSyms.reduce<Record<string, Sym[]>>((acc, s) => {
    ;(acc[s.group] = acc[s.group] || []).push(s)
    return acc
  }, {})

  // ─── Theme colours come from CSS variables via @/lib/colors import ────────

  // ═════════════════════════════════════════════════════════════════════════
  // Render — LAYOUT changes only (positions moved left; everything else same)
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: bg0, fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' }}>

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
            width: 28, height: 28, borderRadius: '50%', background: amber,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 8, fontWeight: 800, color: '#000',
          }}>
            {displayName.replace('Volatility ', 'V').slice(0, 4).toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>{displayName}</div>
            {price !== null && (
              <div style={{ fontSize: 11, lineHeight: 1.4, display: 'flex', gap: 4 }}>
                <span style={{ color: priceDir === 'up' ? '#4ade80' : priceDir === 'dn' ? '#f87171' : txt1 }}>
                  {fdp(price, dp)}
                </span>
                {priceDir && (
                  <span style={{ color: priceDir === 'up' ? '#4ade80' : '#f87171', fontSize: 10 }}>
                    {priceDir === 'up' ? '+' : ''}
                    {prevPriceRef.current !== null ? fdp(price - prevPriceRef.current, dp) : ''}
                  </span>
                )}
              </div>
            )}
          </div>
          <span style={{ color: txt2, fontSize: 10 }}>▾</span>
        </button>

        {/* Symbol dropdown */}
        {symOpen && (
          <div style={{
            position: 'absolute', top: 48, left: 12, zIndex: 200,
            width: 290, background: bg1, border: `1px solid ${bdr}`,
            borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            maxHeight: 400, display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}`, flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: txt0, marginBottom: 8 }}>Select Market</div>
              <input autoFocus value={mktQ} onChange={e => setMktQ(e.target.value)}
                placeholder="Search…"
                style={{ width: '100%', background: bg2, border: `1px solid ${bdr}`, borderRadius: 6, padding: '6px 10px', color: txt0, fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {syms.length === 0 ? (
                <div style={{ padding: '24px', color: txt2, fontSize: 12, textAlign: 'center' }}>Loading markets…</div>
              ) : filteredSyms.length === 0 ? (
                <div style={{ padding: '24px', color: txt2, fontSize: 12, textAlign: 'center' }}>No results</div>
              ) : (
                Object.entries(symGroups).map(([grp, items]) => (
                  <div key={grp}>
                    <div style={{ padding: '8px 12px 4px', fontSize: 10, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{grp}</div>
                    {items.map(s => (
                      <button key={s.symbol}
                        onClick={() => { setSymbol(s.symbol); setSymOpen(false); setMktQ('') }}
                        style={{ width: '100%', padding: '8px 12px', background: s.symbol === symbol ? bg2 : 'transparent', border: 'none', textAlign: 'left', color: s.open ? txt0 : txt2, fontSize: 12, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
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
            <button key={t.label} onClick={() => setTfIdx(i)} style={{
              padding: '4px 9px', fontSize: 11, fontWeight: 600,
              background: tfIdx === i ? bg2 : 'transparent',
              border: `1px solid ${tfIdx === i ? amber : 'transparent'}`,
              borderRadius: 5, color: tfIdx === i ? amber : txt1, cursor: 'pointer',
            }}>{t.label}</button>
          ))}
        </div>

        {/* Chart type */}
        <div style={{ display: 'flex', gap: 2, background: bg2, borderRadius: 6, padding: 2 }}>
          {(['area','line','candles'] as const).map(ct => (
            <button key={ct} onClick={() => setChartType(ct)} style={{
              padding: '3px 8px', fontSize: 10, fontWeight: 600,
              background: chartType === ct ? bdr : 'transparent',
              border: 'none', borderRadius: 4,
              color: chartType === ct ? txt0 : txt1, cursor: 'pointer',
            }}>{ct === 'area' ? '◿' : ct === 'line' ? '╱' : '▭'}</button>
          ))}
        </div>

        <button onClick={() => setMaOn(v => !v)} style={{
          padding: '3px 8px', fontSize: 10, fontWeight: 600,
          background: maOn ? '#f59e0b22' : 'transparent',
          border: `1px solid ${maOn ? '#f59e0b' : 'transparent'}`,
          borderRadius: 4, color: maOn ? '#f59e0b' : txt1, cursor: 'pointer',
        }}>MA</button>

        <div style={{ flex: 1 }} />

        {balance !== null && (
          <div style={{ fontSize: 12, marginRight: 8 }}>
            <span style={{ color: txt2 }}>{currency} </span>
            <span style={{ color: txt0, fontWeight: 600 }}>{f2(balance)}</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: authReady ? green : amber, boxShadow: authReady ? `0 0 6px ${green}` : 'none' }} />
          <span style={{ fontSize: 10, color: txt1 }}>{authReady ? 'Live' : authErr ?? 'Connecting…'}</span>
        </div>
      </div>

      {/* ══ MAIN ROW ═════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

        {/* ── LEFT: POSITIONS (was bottom panel in v82 — layout change only) */}
        <aside style={{
          width: 220, minWidth: 220, background: bg1,
          borderRight: `1px solid ${bdr}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', borderBottom: `1px solid ${bdr}`, flexShrink: 0, height: 38 }}>
            {(['open','history'] as const).map(tab => (
              <button key={tab} onClick={() => setPosTab(tab)} style={{
                flex: 1, height: '100%', fontSize: 11, fontWeight: 600,
                background: 'transparent',
                borderBottom: posTab === tab ? `2px solid ${amber}` : '2px solid transparent',
                border: 'none', cursor: 'pointer',
                color: posTab === tab ? txt0 : txt1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}>
                <span>{tab === 'open' ? 'Open' : 'History'}</span>
                {(tab === 'open' ? openPos : closedPos).length > 0 && (
                  <span style={{
                    background: tab === 'open' ? amber : bg2,
                    color: tab === 'open' ? '#000' : txt1,
                    borderRadius: 10, padding: '0 5px', fontSize: 9, fontWeight: 700,
                  }}>{(tab === 'open' ? openPos : closedPos).length}</span>
                )}
              </button>
            ))}
          </div>

          {posTab === 'history' && closedPos.length > 0 && (
            <div style={{ padding: '5px 10px', borderBottom: `1px solid ${bdr}`, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: txt2 }}>Total P&L </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: totalPnl >= 0 ? green : red }}>
                {totalPnl >= 0 ? '+' : ''}{f2(totalPnl)} {currency}
              </span>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {(posTab === 'open' ? openPos : closedPos).length === 0 ? (
              <div style={{ textAlign: 'center', color: txt2, fontSize: 11, paddingTop: 32 }}>
                {posTab === 'open' ? 'No open positions' : 'No history'}
              </div>
            ) : [...(posTab === 'open' ? openPos : closedPos)].reverse().map(p => (
              <div key={p.id} style={{ padding: '8px 10px', borderBottom: `1px solid ${bdr}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                    background: (p.side === 'A' ? p.cA : p.cB) + '22',
                    color: p.side === 'A' ? p.cA : p.cB,
                  }}>
                    {p.side === 'A' ? p.lA : p.lB}{p.barrier ? ` ${p.barrier}` : ''}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
                    background: p.status === 'open' ? '#1c2d40' : p.status === 'won' ? '#1a3a1a' : '#3a1a1a',
                    color: p.status === 'open' ? blue : p.status === 'won' ? green : red,
                  }}>
                    {p.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: txt2 }}>Stake</span><span style={{ color: txt1 }}>{f2(p.stake)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: txt2 }}>P&L</span>
                  <span style={{ fontWeight: 600, color: p.profit >= 0 ? green : red }}>
                    {p.profit >= 0 ? '+' : ''}{f2(p.profit)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* ── CENTER: CHART + DIGIT STRIP ──────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={chartEl} style={{ flex: 1, minWidth: 0, minHeight: 0 }} />

          {/* Digit circles — mirrors the digit selector; highlights last tick digit */}
          <div style={{
            height: 48, background: bg1, borderTop: `1px solid ${bdr}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 6, flexShrink: 0, padding: '0 8px',
          }}>
            {[0,1,2,3,4,5,6,7,8,9].map(d => {
              const cur       = price !== null ? lastDigit(price, dp) : -1
              const isBarrier = tt.barrier && d === barrier
              const isCurrent = d === cur
              return (
                <button
                  key={d}
                  onClick={() => { if (tt.barrier) setBarrier(d) }}
                  style={{
                    width: 34, height: 34, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, flexShrink: 0,
                    background: isCurrent ? amber : isBarrier ? `color-mix(in srgb, ${amber} 13%, transparent)` : bg2,
                    border: `2px solid ${isCurrent ? amber : isBarrier ? amber : bdr}`,
                    color: isCurrent ? '#000' : isBarrier ? amber : txt1,
                    cursor: tt.barrier ? 'pointer' : 'default',
                    transition: 'background 0.12s, border-color 0.12s',
                    boxShadow: isCurrent ? `0 0 8px color-mix(in srgb, ${amber} 53%, transparent)` : 'none',
                  }}
                >{d}</button>
              )
            })}
          </div>
        </div>

        {/* ── RIGHT: TRADE PANEL (same content as v82, just kept on right) */}
        <aside style={{
          width: 286, minWidth: 286, background: bg1,
          borderLeft: `1px solid ${bdr}`,
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto', overflowX: 'hidden',
        }}>
          {/* TRADE TYPE */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}` }}>
            <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Trade Type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {TT.map((t, i) => (
                <button key={t.id} onClick={() => { setTtIdx(i); setPropA(null); setPropB(null) }} style={{
                  padding: '7px 4px', fontSize: 11, fontWeight: 600,
                  background: ttIdx === i ? bg2 : 'transparent',
                  border: `1px solid ${ttIdx === i ? amber : bdr}`,
                  borderRadius: 6, cursor: 'pointer',
                  color: ttIdx === i ? amber : txt1,
                  textAlign: 'center', lineHeight: 1.4,
                }}>
                  <div>{t.lA} /</div>
                  <div>{t.lB}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ── SIGNAL ANALYZER ──────────────────────────────────── */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}`, flexShrink: 0 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>◈ Signal</span>
              <span style={{ fontSize: 8, color: txt2 }}>{Math.min(sigDigitsRef.current.length, 100)}/100 ticks</span>
            </div>

            {/* State badge */}
            {sigState === 'enter' && sigRec ? (
              // ── ENTER NOW — prominent orange banner like exwager ──────────
              <div style={{
                padding: '8px 10px', borderRadius: 6, marginBottom: 8,
                background: 'linear-gradient(135deg, rgba(249,115,22,0.18) 0%, rgba(230,180,41,0.14) 100%)',
                border: `1px solid #f97316`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#f97316', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 3 }}>
                  🟠 ENTER NOW
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: sigRec.type === 'RISE' ? green : sigRec.type === 'FALL' ? red : green }}>
                    {sigRec.type === 'RISE' ? '↑ Rise' : sigRec.type === 'FALL' ? '↓ Fall' : sigRec.type === 'OVER' ? `Over ${sigRec.barrier}` : sigRec.type === 'UNDER' ? `Under ${sigRec.barrier}` : sigRec.type === 'EVEN' ? 'Even' : sigRec.type === 'ODD' ? 'Odd' : sigRec.type === 'MATCH' ? `Match ${sigRec.barrier}` : `Differ ${sigRec.barrier}`}
                  </span>
                  <span style={{ fontSize: 10, background: `color-mix(in srgb, ${green} 13%, transparent)`, color: green, border: `1px solid color-mix(in srgb, ${green} 33%, transparent)`, borderRadius: 4, padding: '1px 6px' }}>
                    +{(sigRec.edge * 100).toFixed(1)}% edge
                  </span>
                </div>
                <button
                  onClick={() => {
                    if (sigRec.type === 'RISE' || sigRec.type === 'FALL') {
                      setTtIdx(3); setTickDur(5)
                    } else {
                      if (sigRec.type === 'OVER' || sigRec.type === 'UNDER') {
                        setTtIdx(0); setBarrier(sigRec.barrier ?? 5)
                      } else if (sigRec.type === 'MATCH' || sigRec.type === 'DIFFER') {
                        setTtIdx(2); setBarrier(sigRec.barrier ?? 0)
                      }
                      setTickDur(3)
                    }
                  }}
                  style={{
                    width: '100%', padding: '5px 0', fontSize: 11, fontWeight: 700,
                    background: 'rgba(249,115,22,0.15)', border: `1px solid #f97316`,
                    borderRadius: 5, color: '#f97316', cursor: 'pointer',
                  }}
                >
                  Set {sigRec.type === 'RISE' ? '↑ Rise' : sigRec.type === 'FALL' ? '↓ Fall' : sigRec.type === 'OVER' ? `Over ${sigRec.barrier}` : sigRec.type === 'UNDER' ? `Under ${sigRec.barrier}` : sigRec.type === 'EVEN' ? 'Even' : sigRec.type === 'ODD' ? 'Odd' : sigRec.type === 'MATCH' ? `Match ${sigRec.barrier}` : `Differ ${sigRec.barrier}`} · {sigRec.type === 'RISE' || sigRec.type === 'FALL' ? '5' : '3'}t →
                </button>
              </div>
            ) : (
              <div style={{
                padding: '7px 10px', borderRadius: 6, marginBottom: 8, textAlign: 'center',
                background: sigState === 'cooloff' ? 'rgba(230,180,41,0.06)' : bg0,
                border: `1px solid ${sigState === 'cooloff' ? amber : sigState === 'waiting' ? `color-mix(in srgb, ${green} 27%, transparent)` : bdr}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: sigState === 'cooloff' ? amber : sigState === 'waiting' ? green : txt2, marginBottom: sigRec && sigState !== 'analyzing' ? 4 : 0 }}>
                  {sigState === 'analyzing' ? 'Analyzing…'
                  : sigState === 'waiting'  ? 'Waiting for signal'
                  : 'Cooling off…'}
                </div>
                {/* Show last sigRec recommendation during waiting and cooloff */}
                {sigRec && sigState !== 'analyzing' && (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '2px 8px', borderRadius: 4,
                    background: sigState === 'cooloff' ? `color-mix(in srgb, ${amber} 9%, transparent)` : `color-mix(in srgb, ${green} 9%, transparent)`,
                    border: `1px solid ${sigState === 'cooloff' ? `color-mix(in srgb, ${amber} 33%, transparent)` : `color-mix(in srgb, ${green} 33%, transparent)`}`,
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: sigState === 'cooloff' ? amber : green }}>
                      {sigRec.type === 'RISE' ? '↑ Rise' : sigRec.type === 'FALL' ? '↓ Fall' : sigRec.type === 'OVER' ? `Over ${sigRec.barrier}` : sigRec.type === 'UNDER' ? `Under ${sigRec.barrier}` : sigRec.type === 'EVEN' ? 'Even' : sigRec.type === 'ODD' ? 'Odd' : sigRec.type === 'MATCH' ? `Match ${sigRec.barrier}` : `Differ ${sigRec.barrier}`}
                    </span>
                    <span style={{ fontSize: 9, color: txt2 }}>{tickDur}t</span>
                  </div>
                )}
              </div>
            )}

            {/* Edge buttons / indicator panel */}
            {tt.id === 'MD' ? (
              // 10 digit tiles: hot = green (Match), cold = blue (Differ)
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 2, marginBottom: 8 }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => {
                  const edge   = sigEdges[`D${d}`] ?? 0
                  const isBest = sigRec && sigState === 'enter' && sigRec.barrier === d
                  const isHot  = false           // Match signals removed
                  const isCold = edge <= -0.03  // ≤7%  — approaching Differ signal strength
                  return (
                    <div key={d} style={{
                      padding: '4px 2px', borderRadius: 4, textAlign: 'center',
                      background: isBest ? `color-mix(in srgb, ${green} 16%, transparent)` : isHot ? `color-mix(in srgb, ${green} 7%, transparent)` : isCold ? `color-mix(in srgb, ${blue} 7%, transparent)` : bg2,
                      border: `1px solid ${isBest ? green : isHot ? `color-mix(in srgb, ${green} 33%, transparent)` : isCold ? `color-mix(in srgb, ${blue} 33%, transparent)` : bdr}`,
                      color: isBest ? green : isHot ? green : isCold ? blue : txt2,
                      transition: 'all 0.3s',
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700 }}>{d}</div>
                      <div style={{ fontSize: 7, marginTop: 1 }}>{edge >= 0 ? '+' : ''}{(edge * 100).toFixed(0)}%</div>
                    </div>
                  )
                })}
              </div>
            ) : tt.id === 'EO' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
                {(['EV','OD'] as const).map(key => {
                  const edge   = sigEdges[key] ?? 0
                  const label  = key === 'EV' ? 'EVEN' : 'ODD'
                  const isBest = sigRec && sigState === 'enter' && ((key === 'EV' && sigRec.type === 'EVEN') || (key === 'OD' && sigRec.type === 'ODD'))
                  const isGood = edge >= 0.03
                  const isBad  = edge <= -0.02
                  return (
                    <div key={key} style={{
                      padding: '5px 4px', borderRadius: 4, textAlign: 'center',
                      background: isBest ? `color-mix(in srgb, ${green} 16%, transparent)` : isGood ? `color-mix(in srgb, ${green} 7%, transparent)` : isBad ? `color-mix(in srgb, ${red} 7%, transparent)` : bg2,
                      border: `1px solid ${isBest ? green : isGood ? `color-mix(in srgb, ${green} 33%, transparent)` : isBad ? `color-mix(in srgb, ${red} 33%, transparent)` : bdr}`,
                      color: isBest ? green : isGood ? green : isBad ? red : txt2,
                      transition: 'all 0.3s',
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700 }}>{label}</div>
                      <div style={{ fontSize: 8, fontWeight: 400, marginTop: 1 }}>{edge >= 0 ? '+' : ''}{(edge * 100).toFixed(1)}%</div>
                    </div>
                  )
                })}
              </div>
            ) : tt.id === 'RF' ? (
              // ── Rise/Fall multi-indicator panel ───────────────────────────
              <div style={{ marginBottom: 8 }}>
                {rfSigData ? (
                  <>
                    {/* Consensus summary row */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, padding: '5px 8px', borderRadius: 5, background: rfSigData.score >= 3 ? (rfSigData.dir === 'RISE' ? `color-mix(in srgb, ${green} 7%, transparent)` : `color-mix(in srgb, ${red} 7%, transparent)`) : bg2, border: `1px solid ${rfSigData.score >= 3 ? (rfSigData.dir === 'RISE' ? `color-mix(in srgb, ${green} 27%, transparent)` : `color-mix(in srgb, ${red} 27%, transparent)`) : bdr}` }}>
                      <span style={{ fontSize: 10, color: txt2 }}>Consensus</span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: rfSigData.score >= 3 ? (rfSigData.dir === 'RISE' ? green : red) : txt2 }}>
                        {rfSigData.score >= 3 ? (rfSigData.dir === 'RISE' ? '↑ RISE' : '↓ FALL') : 'WAIT'} {rfSigData.score}/4
                      </span>
                    </div>
                    {/* Indicator rows */}
                    {([
                      { name: 'EMA Trend', vote: rfSigData.emaVote,    reading: rfSigData.emaVote > 0 ? 'Bullish' : rfSigData.emaVote < 0 ? 'Bearish' : 'Flat' },
                      { name: 'RSI',       vote: rfSigData.rsiVote,    reading: `${rfSigData.rsi.toFixed(0)} ${rfSigData.rsiVote > 0 ? '(OS)' : rfSigData.rsiVote < 0 ? '(OB)' : ''}` },
                      { name: 'Streak',    vote: rfSigData.streakVote, reading: rfSigData.streakVote !== 0 ? `${rfSigData.streak}t → Rev` : `${rfSigData.streak}t` },
                      { name: 'Channel',   vote: rfSigData.channelVote,reading: rfSigData.channelPos < 0.25 ? 'Near low' : rfSigData.channelPos > 0.75 ? 'Near high' : 'Mid-range' },
                    ] as {name:string;vote:number;reading:string}[]).map(ind => (
                      <div key={ind.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, padding: '4px 8px', borderRadius: 4, background: bg2, border: `1px solid ${ind.vote > 0 ? `color-mix(in srgb, ${green} 20%, transparent)` : ind.vote < 0 ? `color-mix(in srgb, ${red} 20%, transparent)` : bdr}` }}>
                        <span style={{ fontSize: 10, color: txt2, width: 68, flexShrink: 0 }}>{ind.name}</span>
                        <span style={{ fontSize: 10, color: txt1, flex: 1 }}>{ind.reading}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: ind.vote > 0 ? green : ind.vote < 0 ? red : txt2 }}>{ind.vote > 0 ? '↑' : ind.vote < 0 ? '↓' : '—'}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div style={{ textAlign: 'center', color: txt2, fontSize: 10, padding: '12px 0' }}>Collecting data (25 ticks)…</div>
                )}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, marginBottom: 8 }}>
                {(['O1','O2','O3','O4','O5','U6','U7','U8'] as const).map(label => {
                  const edge   = sigEdges[label] ?? 0
                  const isBest = sigRec && sigState === 'enter' && label === `${sigRec.type[0]}${sigRec.barrier}`
                  const isGood = edge >= 0.03
                  const isBad  = edge <= -0.02
                  return (
                    <div key={label} style={{
                      padding: '4px 1px', borderRadius: 4, textAlign: 'center',
                      fontSize: 9, fontWeight: 700,
                      background: isBest ? `color-mix(in srgb, ${green} 16%, transparent)` : isGood ? `color-mix(in srgb, ${green} 7%, transparent)` : isBad ? `color-mix(in srgb, ${red} 7%, transparent)` : bg2,
                      border: `1px solid ${isBest ? green : isGood ? `color-mix(in srgb, ${green} 33%, transparent)` : isBad ? `color-mix(in srgb, ${red} 33%, transparent)` : bdr}`,
                      color: isBest ? green : isGood ? green : isBad ? red : txt2,
                      transition: 'all 0.3s',
                    }}>{label}</div>
                  )
                })}
              </div>
            )}

            {/* Digit frequency bars — not shown for Rise/Fall */}
            {tt.id !== 'RF' && (
              <div style={{ display: 'flex', gap: 2 }}>
                {digitFreq.map((f, i) => {
                  const h     = Math.min(f / 0.25 * 100, 100)
                  const isHot  = f >= 0.16
                  const isWarm = f >= 0.13
                  const isCool = f <= 0.06
                  const barColor = isHot ? red : isWarm ? amber : isCool ? blue : txt2
                  const isWinner = sigRec && sigState === 'enter' && (
                    (sigRec.type === 'OVER'   && i > (sigRec.barrier ?? -1)) ||
                    (sigRec.type === 'UNDER'  && i < (sigRec.barrier ?? 10)) ||
                    (sigRec.type === 'EVEN'   && i % 2 === 0) ||
                    (sigRec.type === 'ODD'    && i % 2 === 1) ||
                    (sigRec.type === 'MATCH'  && i === sigRec.barrier) ||
                    (sigRec.type === 'DIFFER' && i !== sigRec.barrier)
                  )
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                      <div style={{
                        width: '100%', height: 28, display: 'flex', alignItems: 'flex-end',
                        background: 'rgba(0,0,0,0.2)', borderRadius: '2px 2px 0 0', overflow: 'hidden',
                        outline: isWinner ? `1px solid ${green}` : 'none',
                      }}>
                        <div style={{
                          width: '100%', height: `${h}%`,
                          background: isWinner ? green : barColor,
                          borderRadius: '2px 2px 0 0', transition: 'height 0.25s',
                        }} />
                      </div>
                      <div style={{ fontSize: 8, color: isWinner ? green : txt2, fontWeight: 600 }}>{i}</div>
                      <div style={{ fontSize: 7, color: txt2 }}>{(f * 100).toFixed(0)}%</div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* DURATION + STAKE */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}` }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Duration</div>
                <div style={{ display: 'flex' }}>
                  <input type="number" min="1" max="10" value={tickDur}
                    onChange={e => setTickDur(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                    style={{ flex: 1, background: bg0, border: `1px solid ${bdr}`, borderRadius: '4px 0 0 4px', padding: '6px 8px', color: txt0, fontSize: 13, fontWeight: 600, outline: 'none', boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <button onClick={() => setTickDur(d => Math.min(10, d+1))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderBottom: `0.5px solid ${bdr}`, borderRadius: '0 4px 0 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▲</button>
                    <button onClick={() => setTickDur(d => Math.max(1, d-1))}  style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderTop: `0.5px solid ${bdr}`,    borderRadius: '0 0 4px 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▼</button>
                  </div>
                </div>
                <div style={{ fontSize: 10, color: txt2, marginTop: 3 }}>ticks</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Stake ({currency})</div>
                <div style={{ display: 'flex' }}>
                  <input type="number" min="0.35" step="0.01" value={stake}
                    onChange={e => setStake(e.target.value)}
                    style={{ flex: 1, background: bg0, border: `1px solid ${bdr}`, borderRadius: '4px 0 0 4px', padding: '6px 8px', color: txt0, fontSize: 13, fontWeight: 600, outline: 'none', boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <button onClick={() => setStake(s => f2(+s+1))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderBottom: `0.5px solid ${bdr}`, borderRadius: '0 4px 0 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▲</button>
                    <button onClick={() => setStake(s => f2(Math.max(0.35, +s-1)))} style={{ background: bg2, border: `1px solid ${bdr}`, borderLeft: 'none', borderTop: `0.5px solid ${bdr}`, borderRadius: '0 0 4px 0', color: txt1, cursor: 'pointer', padding: '2px 6px', fontSize: 9 }}>▼</button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 2, marginTop: 5 }}>
                  {STAKE_PICKS.map(v => (
                    <button key={v} onClick={() => setStake(f2(v))} style={{
                      flex: 1, padding: '3px 0', fontSize: 9, fontWeight: 700,
                      background: stake === f2(v) ? bg2 : 'transparent',
                      border: `1px solid ${bdr}`, borderRadius: 3,
                      color: stake === f2(v) ? txt0 : txt2, cursor: 'pointer',
                    }}>{v}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* DIGIT barrier */}
          {tt.barrier && (
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${bdr}` }}>
              <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Digit ({barrier})</div>
              <div style={{ display: 'flex', gap: 3 }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <button key={d} onClick={() => setBarrier(d)} style={{
                    flex: 1, height: 28, fontSize: 11, fontWeight: 700,
                    background: barrier === d ? amber : bg2,
                    border: `1px solid ${barrier === d ? amber : bdr}`,
                    borderRadius: 4, color: barrier === d ? '#000' : txt1, cursor: 'pointer',
                  }}>{d}</button>
                ))}
              </div>
            </div>
          )}

          {/* BUY CARDS — same structure as v82 */}
          <div style={{ padding: '10px 12px', flex: 1 }}>
            <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{tt.label}</div>
            {balance !== null && parseFloat(stake) > balance && (
              <div style={{ fontSize: 10, color: red, marginBottom: 6, textAlign: 'center' }}>
                Insufficient balance ({currency} {f2(balance)})
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              {(['A','B'] as const).map(side => {
                const prop   = side === 'A' ? propA : propB
                const buying = side === 'A' ? buyingA : buyingB
                const label  = side === 'A' ? tt.lA : tt.lB
                const color  = side === 'A' ? tt.cA : tt.cB
                const bgDim  = side === 'A' ? '#1a2e1a' : '#1a1a2e'
                const noFunds = balance !== null && parseFloat(stake) > balance
                return (
                  <div key={side} style={{ flex: 1 }}>
                    <div style={{ background: bg2, border: `1px solid ${bdr}`, borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 5 }}>{label.toUpperCase()}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: txt2 }}>Stake</span>
                        <span style={{ fontSize: 11, color: txt1, fontWeight: 600 }}>{stake}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 10, color: txt2 }}>Payout</span>
                        <span style={{ fontSize: 11, color: prop ? green : txt2, fontWeight: 700 }}>
                          {prop ? f2(prop.payout) : '—'}
                        </span>
                      </div>
                    </div>
                    {prop?.err && (
                      <div style={{ fontSize: 10, color: red, textAlign: 'center', marginBottom: 4, lineHeight: 1.3 }}>
                        {prop.err}
                      </div>
                    )}
                    <button
                      onClick={() => buy(side)}
                      disabled={!prop?.id || !!prop?.err || buying || buyingA || buyingB || noFunds}
                      style={{
                        width: '100%', padding: '9px 0', fontSize: 12, fontWeight: 700,
                        background: prop?.id && !prop.err && !buying && !noFunds ? color : bgDim,
                        border: 'none', borderRadius: 6, color: '#fff',
                        cursor: prop?.id && !prop.err && !buying && !noFunds ? 'pointer' : 'not-allowed',
                        opacity: prop?.id && !prop.err && !noFunds ? 1 : 0.5, transition: 'background 0.15s',
                      }}
                    >
                      {buying ? '…' : `Buy ${label}`}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

        </aside>
      </div>
    </div>
  )
}
