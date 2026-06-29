'use client'

/**
 * Lima Trade — Charts Page v83
 *
 * Layout (dtrader-style, cloned from exwager.com manual trading UI):
 *
 *   ┌──────────────────────┬───────────────────────────────────────────────┐
 *   │                      │  [Area][Line][Candles]  [1T][1m][5m][15m]... │
 *   │   LEFT TRADE PANEL   │                                               │
 *   │   (240px fixed)      │           L I G H T W E I G H T              │
 *   │                      │              C H A R T S                      │
 *   │  • Trade type tabs   │                                               │
 *   │  • Asset selector    │                                               │
 *   │  • Barrier row       │                                               │
 *   │  • Duration          ├───────────────────────────────────────────────┤
 *   │  • Stake             │        OPEN POSITIONS / HISTORY (bottom)      │
 *   │  • Quick picks       │                                               │
 *   │  • Payout preview    └───────────────────────────────────────────────┘
 *   │  • BUY A / BUY B
 *   │  • Balance display
 *   └──────────────────────
 *
 * Two-WebSocket architecture:
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

const TRADE_TYPES = [
  { id: 'RF', label: 'Rise / Fall',    ctA: 'CALL',       ctB: 'PUT',        lA: 'Rise',  lB: 'Fall',   cA: '#16a34a', cB: '#dc2626', barrier: false },
  { id: 'OU', label: 'Over / Under',   ctA: 'DIGITOVER',  ctB: 'DIGITUNDER', lA: 'Over',  lB: 'Under',  cA: '#16a34a', cB: '#2563eb', barrier: true  },
  { id: 'EO', label: 'Even / Odd',     ctA: 'DIGITEVEN',  ctB: 'DIGITODD',   lA: 'Even',  lB: 'Odd',    cA: '#16a34a', cB: '#7c3aed', barrier: false },
  { id: 'MD', label: 'Match / Differ', ctA: 'DIGITMATCH', ctB: 'DIGITDIFF',  lA: 'Match', lB: 'Differ', cA: '#16a34a', cB: '#dc2626', barrier: true  },
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

const DUR_TICKS   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const DUR_MINUTES = [1, 2, 3, 5, 10, 15, 30, 60]
const STAKE_PICKS = [0.5, 1, 2, 5, 10]

// ─── Types ────────────────────────────────────────────────────────────────────
interface Sym  { symbol: string; name: string; pip: number; dp: number; group: string; open: boolean }
interface Prop { id: string; ask: number; payout: number; err?: string }
interface Pos  {
  id: number; ct: string; side: 'A'|'B'; ttId: string
  lA: string; lB: string; cA: string; cB: string
  stake: number; payout: number; bid: number; profit: number
  status: 'open'|'won'|'lost'|'sold'; barrier?: string; ts: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const f2      = (n: number) => n.toFixed(2)
const fdp     = (n: number, dp: number) => n.toFixed(dp)
const sma     = (arr: number[], n: number) =>
  arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n)

// ─── Component ────────────────────────────────────────────────────────────────
export default function ChartsPage() {

  // ── Market ──────────────────────────────────────────────────────────────────
  const [symbol,    setSymbol]    = useState('R_100')
  const [syms,      setSyms]      = useState<Sym[]>([])
  const [symOpen,   setSymOpen]   = useState(false)
  const [symQ,      setSymQ]      = useState('')
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
  const [priceDir, setPriceDir] = useState<'up'|'dn'|null>(null)
  const prevPriceRef = useRef<number|null>(null)

  // ── Trade state ─────────────────────────────────────────────────────────────
  const [ttIdx,   setTtIdx]   = useState(0)
  const [barrier, setBarrier] = useState(5)
  const [useTick, setUseTick] = useState(true)
  const [tickDur, setTickDur] = useState(5)
  const [minDur,  setMinDur]  = useState(1)
  const [stake,   setStake]   = useState('1.00')
  const tt = TRADE_TYPES[ttIdx]

  // ── Proposals ───────────────────────────────────────────────────────────────
  const [propA, setPropA] = useState<Prop|null>(null)
  const [propB, setPropB] = useState<Prop|null>(null)
  const [buyingA, setBuyingA] = useState(false)
  const [buyingB, setBuyingB] = useState(false)

  // ── Auth / Balance ──────────────────────────────────────────────────────────
  const [balance,   setBalance]   = useState<number|null>(null)
  const [currency,  setCurrency]  = useState('USD')
  const [authReady, setAuthReady] = useState(false)
  const [authErr,   setAuthErr]   = useState<string|null>(null)
  const [authKey,   setAuthKey]   = useState(0)

  // ── Positions ───────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<Pos[]>([])
  const [posTab,    setPosTab]    = useState<'open'|'history'>('open')
  const [posOpen,   setPosOpen]   = useState(true)

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const chartEl   = useRef<HTMLDivElement>(null)
  const chartRef  = useRef<IChartApi|null>(null)
  const seriesRef = useRef<ISeriesApi<any>|null>(null)
  const maRef     = useRef<ISeriesApi<'Line'>|null>(null)
  const pubRef    = useRef<WebSocket|null>(null)
  const authRef   = useRef<WebSocket|null>(null)
  const pricesRef = useRef<number[]>([])
  const tsRef     = useRef<number[]>([])
  const propTimerRef = useRef<ReturnType<typeof setTimeout>|null>(null)

  // ── Account-switch listener ──────────────────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════════════════════════
  // Chart setup
  // ══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!chartEl.current) return
    const chart = createChart(chartEl.current, {
      layout: { background: { color: '#0f172a' }, textColor: '#94a3b8' },
      grid:   { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart
    const obs = new ResizeObserver(() => {
      if (chartEl.current) chart.resize(chartEl.current.offsetWidth, chartEl.current.offsetHeight)
    })
    obs.observe(chartEl.current)
    return () => { obs.disconnect(); chart.remove(); chartRef.current = null }
  }, [])

  // ── Rebuild series when chart type changes ────────────────────────────────
  const rebuildSeries = useCallback((type: 'area'|'line'|'candles', ma: boolean, period: number, prices: number[], times: number[], curDp: number) => {
    const chart = chartRef.current
    if (!chart) return
    if (seriesRef.current) { try { chart.removeSeries(seriesRef.current) } catch {} seriesRef.current = null }
    if (maRef.current)     { try { chart.removeSeries(maRef.current)     } catch {} maRef.current     = null }

    if (type === 'candles') {
      const s = chart.addCandlestickSeries({
        upColor: '#16a34a', downColor: '#dc2626',
        borderUpColor: '#16a34a', borderDownColor: '#dc2626',
        wickUpColor: '#16a34a', wickDownColor: '#dc2626',
      })
      seriesRef.current = s
    } else if (type === 'area') {
      const s = chart.addAreaSeries({
        lineColor: '#6366f1', topColor: 'rgba(99,102,241,0.35)', bottomColor: 'rgba(99,102,241,0)',
        lineWidth: 2,
      })
      seriesRef.current = s
    } else {
      const s = chart.addLineSeries({ color: '#6366f1', lineWidth: 2 })
      seriesRef.current = s
    }

    if (ma && prices.length >= period) {
      const maS = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, lineStyle: 1 })
      maRef.current = maS
      const maVals = sma(prices, period)
      const maData = maVals
        .map((v, i) => v !== null ? { time: times[i] as UTCTimestamp, value: v } : null)
        .filter(Boolean) as LineData[]
      maS.setData(maData)
    }
  }, [])

  // ══════════════════════════════════════════════════════════════════════════════
  // Public WS — market data
  // ══════════════════════════════════════════════════════════════════════════════
  const loadHistory = useCallback((sym: string, gran: number) => {
    const ws = pubRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const end   = Math.floor(Date.now() / 1000)
    const start = end - (gran > 0 ? gran * 500 : 3600)
    if (gran > 0) {
      ws.send(JSON.stringify({ ticks_history: sym, granularity: gran, style: 'candles', start, end, count: 500 }))
    } else {
      ws.send(JSON.stringify({ ticks_history: sym, style: 'ticks', start, end, count: 500 }))
    }
  }, [])

  useEffect(() => {
    let ws: WebSocket
    let alive = true

    const connect = () => {
      ws = new WebSocket(PUB_WS)
      pubRef.current = ws

      ws.onopen = () => {
        if (!alive) return
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }))
        ws.send(JSON.stringify({ ticks: symbolRef.current, subscribe: 1 }))
        loadHistory(symbolRef.current, TFS[tfIdxRef.current].gran)
      }

      ws.onmessage = (e) => {
        if (!alive) return
        const msg = JSON.parse(e.data)
        const sym = symbolRef.current

        if (msg.active_symbols) {
          const list: Sym[] = (msg.active_symbols as any[]).map(s => ({
            symbol: s.symbol, name: s.display_name ?? s.symbol,
            pip: s.pip ?? 0.01, dp: s.pip ? String(s.pip).split('.')[1]?.length ?? 2 : 2,
            group: s.submarket_display_name ?? s.market_display_name ?? '',
            open: s.exchange_is_open === 1,
          }))
          setSyms(list)
        }

        if (msg.tick && msg.tick.symbol === sym) {
          const p = msg.tick.quote
          setPrice(prev => {
            setPriceDir(prev === null ? null : p > prev ? 'up' : p < prev ? 'dn' : null)
            return p
          })
          if (isTickRef.current && seriesRef.current) {
            const t = msg.tick.epoch as UTCTimestamp
            pricesRef.current.push(p)
            tsRef.current.push(t)
            const pt = seriesRef.current as ISeriesApi<'Area'|'Line'>
            pt.update({ time: t, value: p })
            if (maOnRef.current && maRef.current && pricesRef.current.length >= 20) {
              const vals = pricesRef.current
              const avg  = vals.slice(-20).reduce((a, b) => a + b, 0) / 20
              maRef.current.update({ time: t, value: avg })
            }
          }
        }

        if (msg.candles && !isTickRef.current && seriesRef.current) {
          const data = (msg.candles as any[]).map(c => ({
            time:  c.epoch as UTCTimestamp,
            open:  c.open, high: c.high, low: c.low, close: c.close,
          }))
          pricesRef.current = data.map(c => c.close)
          tsRef.current     = data.map(c => c.time)
          const cType = chartType
          if (cType === 'candles') {
            (seriesRef.current as ISeriesApi<'Candlestick'>).setData(data as CandlestickData[])
          } else {
            const lineData = data.map(c => ({ time: c.time, value: c.close }))
            ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).setData(lineData)
          }
          if (maOnRef.current && maRef.current && pricesRef.current.length >= 20) {
            const maVals = sma(pricesRef.current, 20)
            const maData = maVals
              .map((v, i) => v !== null ? { time: tsRef.current[i] as UTCTimestamp, value: v } : null)
              .filter(Boolean) as LineData[]
            maRef.current.setData(maData)
          }
        }

        if (msg.history && isTickRef.current && seriesRef.current) {
          const prices = (msg.history.prices as number[]) ?? []
          const times  = (msg.history.times  as number[]) ?? []
          pricesRef.current = prices
          tsRef.current     = times
          const lineData = prices.map((p, i) => ({ time: times[i] as UTCTimestamp, value: p }))
          ;(seriesRef.current as ISeriesApi<'Area'|'Line'>).setData(lineData)
          if (maOnRef.current && maRef.current && prices.length >= 20) {
            const maVals = sma(prices, 20)
            const maData = maVals
              .map((v, i) => v !== null ? { time: times[i] as UTCTimestamp, value: v } : null)
              .filter(Boolean) as LineData[]
            maRef.current.setData(maData)
          }
        }
      }

      ws.onclose = () => { if (alive) setTimeout(connect, 2000) }
    }

    connect()
    return () => { alive = false; ws?.close() }
  }, [loadHistory, chartType])

  // ── Re-subscribe ticks when symbol changes ────────────────────────────────
  useEffect(() => {
    const ws = pubRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'ticks' }))
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }))
    pricesRef.current = []; tsRef.current = []
    loadHistory(symbol, TFS[tfIdx].gran)
    rebuildSeries(chartType, maOn, 20, [], [], dp)
  }, [symbol, tfIdx, chartType, maOn, dp, loadHistory, rebuildSeries])

  // ── Rebuild series when chart type / MA changes ──────────────────────────
  useEffect(() => {
    rebuildSeries(chartType, maOn, 20, pricesRef.current, tsRef.current, dp)
    loadHistory(symbol, TFS[tfIdx].gran)
  }, [chartType, maOn]) // eslint-disable-line

  // ══════════════════════════════════════════════════════════════════════════════
  // Auth WS — balance, proposals, buy
  // ══════════════════════════════════════════════════════════════════════════════
  const subscribeProposals = useCallback(() => {
    const ws   = authRef.current
    const stk  = parseFloat(stake) || 1
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'proposal' }))

    const dur   = useTick ? tickDur : minDur * 60
    const durUnit = useTick ? 't' : 's'

    const base: Record<string, unknown> = {
      proposal: 1, subscribe: 1,
      amount: stk, basis: 'stake',
      currency: currency || 'USD',
      symbol,
      duration: useTick ? tickDur : minDur,
      duration_unit: useTick ? 't' : 'm',
    }
    if (tt.barrier) base.barrier = barrier

    ws.send(JSON.stringify({ ...base, contract_type: tt.ctA }))
    ws.send(JSON.stringify({ ...base, contract_type: tt.ctB }))
  }, [stake, symbol, tt, barrier, useTick, tickDur, minDur, currency])

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
            const p = msg.proposal
            const isA = p.contract_type === tt.ctA || ['CALL','DIGITOVER','DIGITEVEN','DIGITMATCH'].includes(p.contract_type)
            const prop: Prop = { id: p.id, ask: p.ask_price, payout: p.payout, err: undefined }
            if (isA) setPropA(prop); else setPropB(prop)
          }

          if (msg.error?.code === 'ProposalArrayInteger' || msg.error?.code === 'ContractBuyValidationError') {
            /* ignore proposal errors silently */
          }

          if (msg.buy) {
            const b = msg.buy
            ws.send(JSON.stringify({ forget_all: 'proposal' }))
            const newPos: Pos = {
              id: b.contract_id, ct: b.contract_type,
              side: buyingA ? 'A' : 'B', ttId: tt.id,
              lA: tt.lA, lB: tt.lB, cA: tt.cA, cB: tt.cB,
              stake: parseFloat(stake), payout: b.buy_price ?? 0,
              bid: b.buy_price ?? 0, profit: 0,
              status: 'open', barrier: tt.barrier ? String(barrier) : undefined,
              ts: Date.now(),
            }
            setPositions(ps => [...ps, newPos])
            setBuyingA(false); setBuyingB(false)
            setTimeout(() => subscribeProposals(), 300)
            ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 }))
          }

          if (msg.proposal_open_contract) {
            const poc = msg.proposal_open_contract
            if (poc.is_sold || poc.status === 'sold') {
              const status = poc.profit >= 0 ? 'won' : 'lost'
              setPositions(ps => ps.map(p => p.id === poc.contract_id
                ? { ...p, status, profit: poc.profit ?? 0, bid: poc.bid_price ?? p.bid }
                : p))
            } else {
              setPositions(ps => ps.map(p => p.id === poc.contract_id
                ? { ...p, profit: poc.profit ?? p.profit, bid: poc.bid_price ?? p.bid }
                : p))
            }
          }
        }

        ws.onclose = () => { if (alive) { setAuthReady(false); setTimeout(connect, 3000) } }
      } catch { setAuthErr('Auth WS error') }
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

  // ── Buy ───────────────────────────────────────────────────────────────────
  const buy = useCallback((side: 'A'|'B') => {
    const ws   = authRef.current
    const prop = side === 'A' ? propA : propB
    if (!ws || !prop || buyingA || buyingB) return
    if (side === 'A') setBuyingA(true); else setBuyingB(true)
    ws.send(JSON.stringify({ buy: prop.id, price: +(prop.ask * 1.02).toFixed(2) }))
  }, [propA, propB, buyingA, buyingB])

  // ── Derived ───────────────────────────────────────────────────────────────
  const openPos   = positions.filter(p => p.status === 'open')
  const closedPos = positions.filter(p => p.status !== 'open')
  const totalPnl  = closedPos.reduce((a, p) => a + p.profit, 0)
  const stakeNum  = parseFloat(stake) || 0
  const filteredSyms = syms.filter(s =>
    symQ ? s.name.toLowerCase().includes(symQ.toLowerCase()) || s.symbol.toLowerCase().includes(symQ.toLowerCase()) : true
  )
  // group by market
  const symGroups = filteredSyms.reduce<Record<string, Sym[]>>((acc, s) => {
    ;(acc[s.group] = acc[s.group] || []).push(s)
    return acc
  }, {})

  // ── CSS helpers ───────────────────────────────────────────────────────────
  const panelBg  = '#0f172a'
  const panelBdr = '#1e293b'
  const textMain = '#f1f5f9'
  const textMid  = '#94a3b8'
  const textDim  = '#475569'
  const accent   = '#6366f1'
  const green    = '#16a34a'
  const red      = '#dc2626'

  // ═══════════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ display: 'flex', height: '100vh', background: panelBg, fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ── LEFT TRADE PANEL ──────────────────────────────────────────── */}
      <aside style={{
        width: 248, minWidth: 248, maxWidth: 248,
        background: '#080f1e',
        borderRight: `1px solid ${panelBdr}`,
        display: 'flex', flexDirection: 'column',
        overflowY: 'auto', overflowX: 'hidden',
      }}>

        {/* Balance strip */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${panelBdr}`, background: '#0a1628' }}>
          <div style={{ fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Balance</div>
          {balance !== null
            ? <div style={{ fontSize: 20, fontWeight: 700, color: textMain, letterSpacing: '-0.01em' }}>
                {currency} {f2(balance)}
              </div>
            : <div style={{ fontSize: 13, color: textDim }}>{authErr ?? 'Connecting…'}</div>
          }
        </div>

        {/* Asset selector */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${panelBdr}` }}>
          <div style={{ fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Asset</div>
          <button
            onClick={() => setSymOpen(v => !v)}
            style={{
              width: '100%', padding: '8px 10px',
              background: '#0f172a', border: `1px solid ${panelBdr}`,
              borderRadius: 6, color: textMain, fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontWeight: 600 }}>{curSym?.name ?? symbol}</span>
            <span style={{ color: textDim, fontSize: 11 }}>{symOpen ? '▲' : '▼'}</span>
          </button>

          {symOpen && (
            <div style={{
              position: 'absolute', zIndex: 100,
              width: 220, background: '#0a1628',
              border: `1px solid ${panelBdr}`, borderRadius: 8,
              marginTop: 4, maxHeight: 320, overflowY: 'auto',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}>
              <div style={{ padding: '8px 10px', borderBottom: `1px solid ${panelBdr}` }}>
                <input
                  value={symQ}
                  onChange={e => setSymQ(e.target.value)}
                  placeholder="Search markets…"
                  autoFocus
                  style={{
                    width: '100%', background: '#0f172a', border: `1px solid ${panelBdr}`,
                    borderRadius: 4, padding: '5px 8px', color: textMain,
                    fontSize: 12, outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              {Object.entries(symGroups).map(([grp, items]) => (
                <div key={grp}>
                  <div style={{ padding: '6px 10px', fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{grp}</div>
                  {items.map(s => (
                    <button
                      key={s.symbol}
                      onClick={() => { setSymbol(s.symbol); setSymOpen(false); setSymQ('') }}
                      style={{
                        width: '100%', padding: '7px 10px', textAlign: 'left',
                        background: s.symbol === symbol ? '#1e293b' : 'transparent',
                        border: 'none', color: s.open ? textMain : textDim,
                        fontSize: 12, cursor: 'pointer',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      }}
                    >
                      <span>{s.name}</span>
                      {!s.open && <span style={{ fontSize: 10, color: red }}>closed</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Live price */}
          {price !== null && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em',
                color: priceDir === 'up' ? '#4ade80' : priceDir === 'dn' ? '#f87171' : textMain,
                transition: 'color 0.2s',
              }}>
                {fdp(price, dp)}
              </span>
              {priceDir && (
                <span style={{ fontSize: 13, color: priceDir === 'up' ? '#4ade80' : '#f87171' }}>
                  {priceDir === 'up' ? '▲' : '▼'}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Trade type tabs */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${panelBdr}` }}>
          <div style={{ fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Trade Type</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {TRADE_TYPES.map((t, i) => (
              <button
                key={t.id}
                onClick={() => { setTtIdx(i); setPropA(null); setPropB(null) }}
                style={{
                  padding: '6px 4px', fontSize: 11, fontWeight: 600,
                  background: ttIdx === i ? accent : '#0f172a',
                  border: `1px solid ${ttIdx === i ? accent : panelBdr}`,
                  borderRadius: 5, color: ttIdx === i ? '#fff' : textMid,
                  cursor: 'pointer', textAlign: 'center', lineHeight: 1.3,
                }}
              >
                {t.lA} / {t.lB}
              </button>
            ))}
          </div>
        </div>

        {/* Barrier (digits) */}
        {tt.barrier && (
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${panelBdr}` }}>
            <div style={{ fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              Digit ({tt.id === 'OU' ? 'over/under' : 'match/differ'})
            </div>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {[0,1,2,3,4,5,6,7,8,9].map(d => (
                <button
                  key={d}
                  onClick={() => setBarrier(d)}
                  style={{
                    width: 28, height: 28, fontSize: 12, fontWeight: 700,
                    background: barrier === d ? accent : '#0f172a',
                    border: `1px solid ${barrier === d ? accent : panelBdr}`,
                    borderRadius: 4, color: barrier === d ? '#fff' : textMid,
                    cursor: 'pointer',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Duration */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${panelBdr}` }}>
          <div style={{ fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Duration</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {['Ticks', 'Minutes'].map((l, i) => (
              <button
                key={l}
                onClick={() => setUseTick(i === 0)}
                style={{
                  flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
                  background: useTick === (i === 0) ? accent : '#0f172a',
                  border: `1px solid ${useTick === (i === 0) ? accent : panelBdr}`,
                  borderRadius: 4, color: useTick === (i === 0) ? '#fff' : textMid,
                  cursor: 'pointer',
                }}
              >
                {l}
              </button>
            ))}
          </div>
          {useTick ? (
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {DUR_TICKS.map(d => (
                <button
                  key={d}
                  onClick={() => setTickDur(d)}
                  style={{
                    width: 30, height: 28, fontSize: 12, fontWeight: 600,
                    background: tickDur === d ? '#1e293b' : '#0f172a',
                    border: `1px solid ${tickDur === d ? accent : panelBdr}`,
                    borderRadius: 4, color: tickDur === d ? textMain : textMid,
                    cursor: 'pointer',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {DUR_MINUTES.map(d => (
                <button
                  key={d}
                  onClick={() => setMinDur(d)}
                  style={{
                    padding: '4px 8px', fontSize: 11, fontWeight: 600,
                    background: minDur === d ? '#1e293b' : '#0f172a',
                    border: `1px solid ${minDur === d ? accent : panelBdr}`,
                    borderRadius: 4, color: minDur === d ? textMain : textMid,
                    cursor: 'pointer',
                  }}
                >
                  {d}m
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Stake */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${panelBdr}` }}>
          <div style={{ fontSize: 10, color: textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Stake</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ color: textMid, fontSize: 13 }}>{currency || 'USD'}</span>
            <input
              type="number" min="0.35" step="0.01"
              value={stake}
              onChange={e => setStake(e.target.value)}
              style={{
                flex: 1, background: '#0f172a', border: `1px solid ${panelBdr}`,
                borderRadius: 5, padding: '6px 8px', color: textMain,
                fontSize: 14, fontWeight: 600, outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {STAKE_PICKS.map(v => (
              <button
                key={v}
                onClick={() => setStake(f2(v))}
                style={{
                  flex: 1, padding: '4px 2px', fontSize: 10, fontWeight: 600,
                  background: '#0f172a', border: `1px solid ${panelBdr}`,
                  borderRadius: 4, color: textMid, cursor: 'pointer',
                }}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Proposals + Buy buttons */}
        <div style={{ padding: '10px 14px', flex: 1 }}>
          {/* Side A */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: textDim }}>
                {tt.lA} payout
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: propA ? '#4ade80' : textDim }}>
                {propA ? `${currency} ${f2(propA.payout)}` : '—'}
              </span>
            </div>
            <button
              onClick={() => buy('A')}
              disabled={!propA || buyingA || buyingB}
              style={{
                width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 700,
                background: propA && !buyingA ? green : '#1a2e1a',
                border: 'none', borderRadius: 7, color: '#fff',
                cursor: propA && !buyingA ? 'pointer' : 'not-allowed',
                opacity: propA ? 1 : 0.5,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                transition: 'background 0.15s',
              }}
            >
              {buyingA ? <span style={{ fontSize: 11 }}>Placing…</span> : (
                <>
                  <span style={{ fontSize: 16 }}>▲</span>
                  <span>{tt.lA}</span>
                  {propA && <span style={{ fontSize: 11, opacity: 0.85 }}>${f2(propA.ask)}</span>}
                </>
              )}
            </button>
          </div>

          {/* Side B */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: textDim }}>
                {tt.lB} payout
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: propB ? '#f87171' : textDim }}>
                {propB ? `${currency} ${f2(propB.payout)}` : '—'}
              </span>
            </div>
            <button
              onClick={() => buy('B')}
              disabled={!propB || buyingA || buyingB}
              style={{
                width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 700,
                background: propB && !buyingB ? red : '#2e1a1a',
                border: 'none', borderRadius: 7, color: '#fff',
                cursor: propB && !buyingB ? 'pointer' : 'not-allowed',
                opacity: propB ? 1 : 0.5,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                transition: 'background 0.15s',
              }}
            >
              {buyingB ? <span style={{ fontSize: 11 }}>Placing…</span> : (
                <>
                  <span style={{ fontSize: 16 }}>▼</span>
                  <span>{tt.lB}</span>
                  {propB && <span style={{ fontSize: 11, opacity: 0.85 }}>${f2(propB.ask)}</span>}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Auth status */}
        <div style={{
          padding: '8px 14px', borderTop: `1px solid ${panelBdr}`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: authReady ? '#22c55e' : authErr ? red : '#f59e0b',
          }} />
          <span style={{ fontSize: 10, color: textDim }}>
            {authReady ? 'Live' : authErr ?? 'Connecting…'}
          </span>
        </div>
      </aside>

      {/* ── RIGHT COLUMN (chart + positions) ──────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

        {/* Chart toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', background: '#080f1e',
          borderBottom: `1px solid ${panelBdr}`,
          flexShrink: 0,
        }}>
          {/* Chart type */}
          <div style={{ display: 'flex', gap: 2, background: '#0f172a', borderRadius: 6, padding: 2 }}>
            {(['area','line','candles'] as const).map(ct => (
              <button
                key={ct}
                onClick={() => setChartType(ct)}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 600,
                  background: chartType === ct ? accent : 'transparent',
                  border: 'none', borderRadius: 4,
                  color: chartType === ct ? '#fff' : textDim,
                  cursor: 'pointer',
                }}
              >
                {ct === 'area' ? '◿ Area' : ct === 'line' ? '╱ Line' : '▭ Candles'}
              </button>
            ))}
          </div>

          {/* Separator */}
          <div style={{ width: 1, height: 18, background: panelBdr }} />

          {/* Timeframes */}
          <div style={{ display: 'flex', gap: 2 }}>
            {TFS.map((t, i) => (
              <button
                key={t.label}
                onClick={() => setTfIdx(i)}
                style={{
                  padding: '4px 8px', fontSize: 11, fontWeight: 600,
                  background: tfIdx === i ? '#1e293b' : 'transparent',
                  border: `1px solid ${tfIdx === i ? accent : 'transparent'}`,
                  borderRadius: 4, color: tfIdx === i ? textMain : textDim,
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Separator */}
          <div style={{ width: 1, height: 18, background: panelBdr }} />

          {/* MA toggle */}
          <button
            onClick={() => setMaOn(v => !v)}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              background: maOn ? '#f59e0b22' : 'transparent',
              border: `1px solid ${maOn ? '#f59e0b' : 'transparent'}`,
              borderRadius: 4, color: maOn ? '#f59e0b' : textDim,
              cursor: 'pointer',
            }}
          >
            MA(20)
          </button>

          <div style={{ flex: 1 }} />

          {/* Live indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
            <span style={{ fontSize: 10, color: textDim }}>LIVE</span>
          </div>
        </div>

        {/* Chart canvas */}
        <div ref={chartEl} style={{ flex: 1, minHeight: 0, position: 'relative' }} />

        {/* ── POSITIONS PANEL ─────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0, background: '#080f1e',
          borderTop: `1px solid ${panelBdr}`,
          height: posOpen ? 200 : 38,
          transition: 'height 0.2s ease',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex', alignItems: 'center',
            borderBottom: posOpen ? `1px solid ${panelBdr}` : 'none',
            flexShrink: 0, height: 38,
          }}>
            {(['open','history'] as const).map(tab => {
              const count = tab === 'open' ? openPos.length : closedPos.length
              return (
                <button
                  key={tab}
                  onClick={() => { setPosTab(tab); setPosOpen(true) }}
                  style={{
                    padding: '0 16px', height: '100%', fontSize: 12, fontWeight: 600,
                    background: 'transparent',
                    borderBottom: posTab === tab && posOpen ? `2px solid ${accent}` : '2px solid transparent',
                    border: 'none',
                    color: posTab === tab && posOpen ? textMain : textDim,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <span style={{ textTransform: 'capitalize' }}>
                    {tab === 'open' ? 'Open' : 'History'}
                  </span>
                  {count > 0 && (
                    <span style={{
                      background: tab === 'open' ? accent : '#334155',
                      color: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 10,
                    }}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}

            <div style={{ flex: 1 }} />

            {posTab === 'history' && closedPos.length > 0 && (
              <span style={{
                fontSize: 12, fontWeight: 700, marginRight: 10,
                color: totalPnl >= 0 ? '#4ade80' : '#f87171',
              }}>
                P&L: {totalPnl >= 0 ? '+' : ''}{f2(totalPnl)} {currency}
              </span>
            )}

            <button
              onClick={() => setPosOpen(v => !v)}
              style={{
                padding: '0 12px', height: '100%', background: 'transparent',
                border: 'none', color: textDim, cursor: 'pointer', fontSize: 14,
              }}
            >
              {posOpen ? '▾' : '▴'}
            </button>
          </div>

          {/* Table */}
          {posOpen && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {(posTab === 'open' ? openPos : closedPos).length === 0 ? (
                <div style={{ textAlign: 'center', color: textDim, fontSize: 12, paddingTop: 28 }}>
                  No {posTab === 'open' ? 'open positions' : 'trade history'}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: textDim, textAlign: 'left' }}>
                      <th style={{ padding: '6px 14px', fontWeight: 500 }}>Contract</th>
                      <th style={{ padding: '6px 8px',  fontWeight: 500 }}>Type</th>
                      <th style={{ padding: '6px 8px',  fontWeight: 500 }}>Stake</th>
                      <th style={{ padding: '6px 8px',  fontWeight: 500 }}>Payout</th>
                      <th style={{ padding: '6px 8px',  fontWeight: 500 }}>P&L</th>
                      <th style={{ padding: '6px 14px', fontWeight: 500 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(posTab === 'open' ? openPos : closedPos).map(p => (
                      <tr key={p.id} style={{ borderTop: `1px solid ${panelBdr}` }}>
                        <td style={{ padding: '6px 14px', color: textMain }}>#{p.id}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <span style={{
                            padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                            background: p.side === 'A' ? p.cA + '22' : p.cB + '22',
                            color: p.side === 'A' ? p.cA : p.cB,
                          }}>
                            {p.side === 'A' ? p.lA : p.lB}
                            {p.barrier ? ` ${p.barrier}` : ''}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', color: textMid }}>{f2(p.stake)}</td>
                        <td style={{ padding: '6px 8px', color: textMid }}>{f2(p.payout)}</td>
                        <td style={{ padding: '6px 8px', fontWeight: 600, color: p.profit >= 0 ? '#4ade80' : '#f87171' }}>
                          {p.profit >= 0 ? '+' : ''}{f2(p.profit)}
                        </td>
                        <td style={{ padding: '6px 14px' }}>
                          <span style={{
                            padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                            background:
                              p.status === 'open'  ? '#1e3a5f' :
                              p.status === 'won'   ? '#14532d' :
                              p.status === 'lost'  ? '#450a0a' : '#1e293b',
                            color:
                              p.status === 'open'  ? '#60a5fa' :
                              p.status === 'won'   ? '#4ade80' :
                              p.status === 'lost'  ? '#f87171' : textDim,
                          }}>
                            {p.status.toUpperCase()}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
