'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'

const MARKETS = [
  { symbol: '1HZ100V', label: 'Volatility 100 (1s)' },
  { symbol: '1HZ75V',  label: 'Volatility 75 (1s)'  },
  { symbol: '1HZ50V',  label: 'Volatility 50 (1s)'  },
  { symbol: '1HZ25V',  label: 'Volatility 25 (1s)'  },
  { symbol: '1HZ10V',  label: 'Volatility 10 (1s)'  },
  { symbol: 'R_100',   label: 'Volatility 100'       },
  { symbol: 'R_75',    label: 'Volatility 75'        },
  { symbol: 'R_50',    label: 'Volatility 50'        },
  { symbol: 'R_25',    label: 'Volatility 25'        },
  { symbol: 'R_10',    label: 'Volatility 10'        },
]

const SCAN_SYMBOLS = ['1HZ100V', '1HZ75V', '1HZ50V', 'R_100', 'R_75']

const DIGIT_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#14b8a6',
  '#3b82f6','#8b5cf6','#ec4899','#06b6d4','#FCA311',
]

const ACCENT = '#00e5cc'

function lastDigit(price: number, pipSize = 2): number {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}

function fmt2(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface TradeRow {
  id:           number
  ts:           number
  contractType: string
  symbol:       string
  stake:        number
  payout:       number
  won:          boolean | null  // null = pending
  profit:       number | null
  source:       'manual' | 'scanner'
}

interface LogLine {
  id:    number
  text:  string
  color: 'green' | 'amber' | 'red' | 'cyan' | 'white'
  ts:    number
}

/* ─── Pattern detection ──────────────────────────────────────────────────── */
interface PatternResult {
  signal:       boolean
  confidence:   number
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | null
  barrier:      number | null
  reason:       string
}

function detectPattern(digits: number[], tradeType: 'even_odd' | 'over_under', barrier: number): PatternResult {
  if (digits.length < 20) return { signal: false, confidence: 0, contractType: null, barrier: null, reason: 'Need ≥20 ticks' }
  const recent = digits.slice(-60)
  const last30 = digits.slice(-30)

  if (tradeType === 'even_odd') {
    const evenCount = recent.filter(d => d % 2 === 0).length
    const oddCount  = recent.length - evenCount
    let streak = 1
    const lastParity = recent[recent.length - 1] % 2
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i] % 2 === lastParity) streak++; else break
    }
    if (streak >= 5) {
      const betType = lastParity === 0 ? 'DIGITODD' : 'DIGITEVEN'
      return { signal: true, confidence: Math.min(95, 60 + streak * 5), contractType: betType, barrier: null, reason: `${streak}-streak ${lastParity === 0 ? 'even' : 'odd'} → bet ${betType === 'DIGITEVEN' ? 'Even' : 'Odd'}` }
    }
    const evenPct = evenCount / recent.length
    const oddPct  = oddCount  / recent.length
    if (evenPct > 0.66) return { signal: true, confidence: Math.round(evenPct * 100), contractType: 'DIGITODD',  barrier: null, reason: `${Math.round(evenPct*100)}% even → bet Odd`  }
    if (oddPct  > 0.66) return { signal: true, confidence: Math.round(oddPct  * 100), contractType: 'DIGITEVEN', barrier: null, reason: `${Math.round(oddPct *100)}% odd  → bet Even` }
    return { signal: false, confidence: 0, contractType: null, barrier: null, reason: 'No pattern' }
  }

  const overCount  = last30.filter(d => d > barrier).length
  const underCount = last30.filter(d => d < barrier).length
  const trapCount  = last30.filter(d => d <= 2 || d >= 7).length
  const trapPct    = trapCount  / last30.length
  const overPct    = overCount  / last30.length
  const underPct   = underCount / last30.length
  if (trapPct  > 0.70) return { signal: true, confidence: Math.round(trapPct  * 100), contractType: 'DIGITOVER',  barrier, reason: `${Math.round(trapPct *100)}% trap digits → Over ${barrier}` }
  if (overPct  > 0.66) return { signal: true, confidence: Math.round(overPct  * 100), contractType: 'DIGITUNDER', barrier, reason: `${Math.round(overPct *100)}% over ${barrier} → Under`  }
  if (underPct > 0.66) return { signal: true, confidence: Math.round(underPct * 100), contractType: 'DIGITOVER',  barrier, reason: `${Math.round(underPct*100)}% under ${barrier} → Over`  }
  return { signal: false, confidence: 0, contractType: null, barrier: null, reason: 'No pattern' }
}

/* ─── Digit Gauge ────────────────────────────────────────────────────────── */
function DigitGauge({ digit, count, total, liveDigit }: { digit: number; count: number; total: number; liveDigit: number | null }) {
  const pct  = total > 0 ? (count / total) * 100 : 0
  const r    = 18
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const live = liveDigit === digit
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <svg width="46" height="46" viewBox="0 0 46 46">
        <circle cx="23" cy="23" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="4" />
        <circle cx="23" cy="23" r={r} fill="none"
          stroke={live ? '#fff' : DIGIT_COLORS[digit]}
          strokeWidth={live ? 5 : 3.5}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.3s', filter: live ? `drop-shadow(0 0 5px ${DIGIT_COLORS[digit]})` : 'none' }}
        />
        <text x="23" y="27" textAnchor="middle" fontSize="12" fontWeight="800" fill={live ? '#fff' : DIGIT_COLORS[digit]}>{digit}</text>
      </svg>
      <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.45)' }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export default function BulkTraderPage() {
  /* ── Controls ── */
  const [symbol,     setSymbol]     = useState('1HZ100V')
  const [tradeType,  setTradeType]  = useState<'even_odd' | 'over_under'>('even_odd')
  const [barrier,    setBarrier]    = useState(5)
  const [stake,      setStake]      = useState('1.00')
  const [tradeCount, setTradeCount] = useState(3)
  const [tickWindow, setTickWindow] = useState(60)

  /* ── Tick data ── */
  const [livePrice,    setLivePrice]    = useState<number | null>(null)
  const [recentDigits, setRecentDigits] = useState<number[]>([])
  const [digitCounts,  setDigitCounts]  = useState<number[]>(Array(10).fill(0))
  const pipSizeRef = useRef(2)

  /* ── Trade state ── */
  const [isTrading,  setIsTrading]  = useState(false)
  const [tradeError, setTradeError] = useState<string | null>(null)
  const [currency,   setCurrency]   = useState('USD')
  const botWsRef        = useRef<WebSocket | null>(null)
  const reqIdRef        = useRef(0)
  const intentionalClose = useRef(false)

  /* ── Trade history ── */
  const [trades,   setTrades]   = useState<TradeRow[]>([])
  const tradeIdRef = useRef(0)
  const pendingRef = useRef<Map<number, { rowId: number; stake: number }>>(new Map()) // contractId → {rowId, stake}

  /* ── AI Scanner ── */
  const [scannerOpen,   setScannerOpen]   = useState(false)
  const [scannerActive, setScannerActive] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<'idle' | 'scanning' | 'fired'>('idle')
  const [logLines,      setLogLines]      = useState<LogLine[]>([])
  const logIdRef       = useRef(0)
  const scannerWsRefs  = useRef<Map<string, WebSocket>>(new Map())
  const scannerDigits  = useRef<Map<string, number[]>>(new Map())
  const cooldowns      = useRef<Map<string, number>>(new Map())
  const scannerBotWsRef = useRef<WebSocket | null>(null)
  const scannerTradeCountRef = useRef(3)
  const scannerStakeRef      = useRef('1.00')
  const scannerCurrencyRef   = useRef('USD')
  const scannerTradeTypeRef  = useRef<'even_odd'|'over_under'>('even_odd')
  const scannerBarrierRef    = useRef(5)

  /* ── Sync scanner refs ── */
  useEffect(() => { scannerTradeCountRef.current = tradeCount }, [tradeCount])
  useEffect(() => { scannerStakeRef.current      = stake      }, [stake])
  useEffect(() => { scannerCurrencyRef.current   = currency   }, [currency])
  useEffect(() => { scannerTradeTypeRef.current  = tradeType  }, [tradeType])
  useEffect(() => { scannerBarrierRef.current    = barrier    }, [barrier])

  /* ── Digit counts ── */
  useEffect(() => {
    const counts = Array(10).fill(0)
    recentDigits.slice(-tickWindow).forEach(d => counts[d]++)
    setDigitCounts(counts)
  }, [recentDigits, tickWindow])

  /* ── Derived stats ── */
  const settled    = trades.filter(t => t.won !== null)
  const wins       = settled.filter(t => t.won)
  const totalPnl   = settled.reduce((s, t) => s + (t.profit ?? 0), 0)
  const winRate    = settled.length > 0 ? (wins.length / settled.length) * 100 : 0

  /* ── Public WS: live ticks ── */
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => ws.send(JSON.stringify({ ticks_history: symbol, end: 'latest', count: 100, style: 'ticks', subscribe: 1, req_id: 1 }))
    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'history') {
        if (msg.pip_size != null) pipSizeRef.current = msg.pip_size
        const prices: number[] = msg.history?.prices ?? []
        setRecentDigits(prices.map(p => lastDigit(Number(p), pipSizeRef.current)).slice(-100))
        setLivePrice(prices.at(-1) ?? null)
      }
      if (msg.msg_type === 'tick') {
        if (msg.tick?.pip_size != null) pipSizeRef.current = msg.tick.pip_size
        const q = msg.tick?.quote
        if (q != null) {
          setLivePrice(q)
          setRecentDigits(prev => [...prev.slice(-99), lastDigit(Number(q), pipSizeRef.current)])
        }
      }
    }
    ws.onerror = () => {}; ws.onclose = () => {}
    return () => {
      if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 9999 })) } catch { /**/ }
      ws.close(); setLivePrice(null); setRecentDigits([])
    }
  }, [symbol])

  /* ── Logger ── */
  const log = useCallback((text: string, color: LogLine['color'] = 'white') => {
    setLogLines(prev => [...prev.slice(-200), { id: ++logIdRef.current, text, color, ts: Date.now() }])
  }, [])

  /* ── Add trade row ── */
  const addTrade = useCallback((
    contractType: string, sym: string, stakeVal: number, source: 'manual' | 'scanner'
  ): number => {
    const id = ++tradeIdRef.current
    setTrades(prev => [{
      id, ts: Date.now(), contractType, symbol: sym,
      stake: stakeVal, payout: 0, won: null, profit: null, source,
    }, ...prev.slice(0, 99)])
    return id
  }, [])

  /* ── Settle trade row ── */
  const settleTrade = useCallback((rowId: number, payout: number, stakeVal: number) => {
    const profit = payout - stakeVal
    setTrades(prev => prev.map(t =>
      t.id === rowId ? { ...t, payout, profit, won: profit > 0 } : t
    ))
  }, [])

  /* ── Connect bot WS ── */
  const connectBotWs = useCallback(async (): Promise<WebSocket | null> => {
    try {
      const r = await fetch('/api/user/ws-url')
      if (!r.ok) { if (r.status === 401) window.location.href = '/'; return null }
      const { wsUrl } = await r.json()
      const ws = new WebSocket(wsUrl)
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res()
        ws.onerror = () => rej(new Error('connect failed'))
        setTimeout(() => rej(new Error('timeout')), 10_000)
      })
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
      try {
        const br = await fetch('/api/user/balance')
        if (br.ok) {
          const { accounts, activeAccountId } = await br.json()
          const acc = accounts?.find((a: any) => a.accountId === activeAccountId) ?? accounts?.[0]
          if (acc?.currency) setCurrency(acc.currency)
        }
      } catch { /**/ }
      return ws
    } catch { return null }
  }, [])

  /* ── Fire N trades ── */
  const fireTrades = useCallback((
    ws: WebSocket, contractType: string, barrierVal: number | null,
    stakeVal: number, count: number, sym: string, cur: string, source: 'manual' | 'scanner',
    pending: Map<number, { rowId: number; stake: number }>,
  ) => {
    for (let i = 0; i < count; i++) {
      const reqId = ++reqIdRef.current
      const rowId = addTrade(contractType, sym, stakeVal, source)
      pending.set(reqId, { rowId, stake: stakeVal })
      ws.send(JSON.stringify({
        buy: '1', price: 1000, req_id: reqId,
        parameters: {
          contract_type:     contractType,
          underlying_symbol: sym,
          duration: 5, duration_unit: 't',
          amount: stakeVal, basis: 'stake', currency: cur,
          ...(barrierVal !== null ? { barrier: String(barrierVal) } : {}),
        },
      }))
    }
  }, [addTrade])

  /* ── Manual bulk trade ── */
  const handleManualTrade = useCallback(async (contractType: string) => {
    if (isTrading) return
    setIsTrading(true); setTradeError(null)
    const stakeVal = parseFloat(stake) || 1.00
    const ws = await connectBotWs()
    if (!ws) { setTradeError('Connection failed'); setIsTrading(false); return }
    botWsRef.current = ws; intentionalClose.current = false

    const pending = new Map<number, { rowId: number; stake: number }>()
    // map reqId → rowId after buy response
    const reqToRow = new Map<number, number>()
    let settled = 0
    const n = tradeCount

    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: msg.balance?.balance, currency: msg.balance?.currency } }))
      if (msg.msg_type === 'buy') {
        const reqId = msg.req_id as number
        const contractId = msg.buy?.contract_id as number
        const rowInfo = pending.get(reqId)
        if (rowInfo && contractId) reqToRow.set(contractId, rowInfo.rowId)
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const contractId = msg.transaction.contract_id as number
        const payout     = Math.abs(msg.transaction.amount ?? 0)
        const rowId      = reqToRow.get(contractId)
        // find stake from pending by matching any pending rowId
        let stk = stakeVal
        for (const [, v] of pending) { stk = v.stake; break }
        if (rowId != null) settleTrade(rowId, payout, stk)
        settled++
        if (settled >= n) { intentionalClose.current = true; ws.close(); setIsTrading(false) }
      }
      if (msg.error) { setTradeError(msg.error.message ?? 'Trade error'); intentionalClose.current = true; ws.close(); setIsTrading(false) }
    }
    ws.onclose = () => { if (!intentionalClose.current) setIsTrading(false) }
    ws.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))
    fireTrades(ws, contractType, tradeType === 'over_under' ? barrier : null, stakeVal, n, symbol, currency, 'manual', pending)
  }, [isTrading, stake, tradeCount, tradeType, barrier, symbol, currency, connectBotWs, fireTrades, settleTrade])

  /* ── AI Scanner ── */
  const startScanner = useCallback(async () => {
    setScannerActive(true); setScannerStatus('scanning'); setLogLines([])
    log('━━━ AI BULK SCANNER STARTED ━━━', 'cyan')
    log(`Monitoring: ${SCAN_SYMBOLS.join(' · ')}`, 'white')
    log(`Type: ${scannerTradeTypeRef.current === 'even_odd' ? 'Even/Odd' : `Over/Under ${scannerBarrierRef.current}`} · ${scannerTradeCountRef.current}× @ ${scannerStakeRef.current} ${scannerCurrencyRef.current}`, 'white')

    const bws = await connectBotWs()
    if (!bws) { log('ERROR: Could not connect trading WS', 'red'); setScannerActive(false); setScannerStatus('idle'); return }
    scannerBotWsRef.current = bws
    const scanPending = new Map<number, { rowId: number; stake: number }>()
    const scanReqToRow = new Map<number, number>()

    bws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: msg.balance?.balance, currency: msg.balance?.currency } }))
      if (msg.msg_type === 'buy') {
        const reqId = msg.req_id as number
        const cid   = msg.buy?.contract_id as number
        const rowInfo = scanPending.get(reqId)
        if (rowInfo && cid) { scanReqToRow.set(cid, rowInfo.rowId); log(`  ✓ Bought contract ${cid}`, 'green') }
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const cid    = msg.transaction.contract_id as number
        const payout = Math.abs(msg.transaction.amount ?? 0)
        const rowId  = scanReqToRow.get(cid)
        let stk = parseFloat(scannerStakeRef.current) || 1
        for (const [, v] of scanPending) { stk = v.stake; break }
        if (rowId != null) { settleTrade(rowId, payout, stk); log(`  ${payout > stk ? '✓ WIN' : '✗ LOSS'} ${fmt2(payout - stk)} ${scannerCurrencyRef.current}`, payout > stk ? 'green' : 'red') }
      }
      if (msg.error) log(`  ERROR: ${msg.error.message}`, 'red')
    }
    bws.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))

    SCAN_SYMBOLS.forEach(sym => {
      scannerDigits.current.set(sym, [])
      const ws = new WebSocket(PUBLIC_WS_URL)
      scannerWsRefs.current.set(sym, ws)
      let localPipSize = 2
      ws.onopen = () => ws.send(JSON.stringify({ ticks_history: sym, end: 'latest', count: 100, style: 'ticks', subscribe: 1, req_id: 1 }))
      ws.onmessage = (ev) => {
        let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.msg_type === 'history') {
          if (msg.pip_size != null) localPipSize = msg.pip_size
          scannerDigits.current.set(sym, (msg.history?.prices ?? []).map((p: number) => lastDigit(Number(p), localPipSize)))
        }
        if (msg.msg_type === 'tick') {
          if (msg.tick?.pip_size != null) localPipSize = msg.tick.pip_size
          const q = msg.tick?.quote; if (q == null) return
          const digits = scannerDigits.current.get(sym) ?? []
          digits.push(lastDigit(Number(q), localPipSize))
          if (digits.length > 200) digits.shift()
          scannerDigits.current.set(sym, digits)
          if (digits.length % 5 !== 0) return
          const lastFired = cooldowns.current.get(sym) ?? 0
          if (Date.now() - lastFired < 30_000) return
          const tt = scannerTradeTypeRef.current, br = scannerBarrierRef.current
          const result = detectPattern(digits, tt, br)
          if (result.signal && result.confidence >= 62 && result.contractType) {
            const mkt = MARKETS.find(m => m.symbol === sym)?.label ?? sym
            log(`━━ SIGNAL: ${mkt} ━━`, 'cyan')
            log(`  ${result.reason} (${result.confidence}%)`, 'amber')
            cooldowns.current.set(sym, Date.now())
            setScannerStatus('fired'); setTimeout(() => setScannerStatus('scanning'), 3000)
            if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
              const cnt = scannerTradeCountRef.current
              const stk = parseFloat(scannerStakeRef.current) || 1
              const cur = scannerCurrencyRef.current
              fireTrades(scannerBotWsRef.current, result.contractType, result.barrier, stk, cnt, sym, cur, 'scanner', scanPending)
            }
          }
        }
      }
      ws.onerror = () => log(`WS error on ${sym}`, 'red')
    })
  }, [connectBotWs, fireTrades, settleTrade, log])

  const stopScanner = useCallback(() => {
    setScannerActive(false); setScannerStatus('idle')
    log('━━━ SCANNER STOPPED ━━━', 'amber')
    scannerWsRefs.current.forEach(ws => { try { ws.close() } catch { /**/ } })
    scannerWsRefs.current.clear(); scannerDigits.current.clear(); cooldowns.current.clear()
    if (scannerBotWsRef.current) { try { scannerBotWsRef.current.close() } catch { /**/ } }
    scannerBotWsRef.current = null
  }, [log])

  useEffect(() => () => { stopScanner() }, [stopScanner])

  const liveDigit  = livePrice != null ? lastDigit(livePrice, pipSizeRef.current) : null
  const totalTicks = recentDigits.slice(-tickWindow).length

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    <>
      <style>{`
        .bt-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:.85rem 1rem; }
        .bt-lbl  { font-size:.65rem; font-weight:700; letter-spacing:.08em; color:rgba(229,229,229,.4); text-transform:uppercase; margin-bottom:.45rem; }
        .bt-sel  { width:100%; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#e5e5e5; padding:.5rem .7rem; font-size:.82rem; outline:none; cursor:pointer; }
        .bt-inp  { width:100%; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#e5e5e5; padding:.5rem .7rem; font-size:.88rem; outline:none; box-sizing:border-box; }
        .bt-inp:focus { border-color:${ACCENT}; }
        .bt-btn  { border:none; border-radius:9px; font-weight:800; cursor:pointer; transition:opacity .15s; }
        .bt-btn:disabled { opacity:.4; cursor:not-allowed; }
        .tt-chip { padding:.42rem 0; border-radius:7px; font-size:.75rem; font-weight:700; cursor:pointer; border:1px solid transparent; transition:all .15s; text-align:center; flex:1; white-space:nowrap; }
        .dot-cell { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:4px; font-size:.68rem; font-weight:800; flex-shrink:0; }
        .sm-btn { padding:.38rem .6rem; border-radius:6px; font-size:.78rem; font-weight:800; cursor:pointer; border:1px solid transparent; transition:all .15s; flex:1; text-align:center; }
        .hist-row { display:grid; grid-template-columns:1fr 72px 52px 60px; gap:4px; align-items:center; padding:.35rem .5rem; border-radius:6px; font-size:.72rem; }
        .hist-row:hover { background:rgba(255,255,255,.04); }
        .scanner-bg { position:fixed; inset:0; z-index:999; background:rgba(0,0,0,.88); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; padding:1rem; }
        .scanner-modal { background:#080f0e; border:1px solid ${ACCENT}44; border-radius:14px; width:100%; max-width:620px; max-height:85vh; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 0 60px ${ACCENT}18; }
        .ll-green { color:#22c55e; } .ll-amber { color:#FCA311; } .ll-red { color:#ef4444; } .ll-cyan { color:${ACCENT}; } .ll-white { color:rgba(229,229,229,.75); }
        @keyframes scanPulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:none} }
      `}</style>

      {/* ── Outer layout: left content + right history panel ── */}
      <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

        {/* ── LEFT: main content ── */}
        <div style={{ flex:1, minWidth:0, overflowY:'auto', padding:'1rem', display:'flex', flexDirection:'column', gap:'.85rem' }}>

          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:'.5rem' }}>
            <div>
              <h1 style={{ margin:0, fontSize:'1.2rem', fontWeight:900, color:'#fff' }}>⣿ Bulk Trader</h1>
              <p style={{ margin:'1px 0 0', fontSize:'.72rem', color:'rgba(229,229,229,.38)' }}>Fire multiple contracts simultaneously on pattern signals</p>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:'1.35rem', fontWeight:900, color:ACCENT, fontVariantNumeric:'tabular-nums' }}>
                {livePrice != null ? livePrice.toFixed(pipSizeRef.current) : '—'}
              </div>
              <div style={{ fontSize:'.65rem', color:'rgba(229,229,229,.35)' }}>LIVE PRICE</div>
            </div>
          </div>

          {/* Controls grid */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:'.65rem' }}>

            {/* Market */}
            <div className="bt-card">
              <div className="bt-lbl">Market</div>
              <select className="bt-sel" value={symbol} onChange={e => setSymbol(e.target.value)}>
                {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
              </select>
            </div>

            {/* Trade Type — stacked to avoid truncation */}
            <div className="bt-card">
              <div className="bt-lbl">Trade Type</div>
              <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                {(['even_odd','over_under'] as const).map(t => (
                  <button key={t} className="tt-chip" onClick={() => setTradeType(t)} style={{
                    background: tradeType===t ? `${ACCENT}22` : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tradeType===t ? ACCENT : 'rgba(255,255,255,.1)'}`,
                    color:      tradeType===t ? ACCENT : 'rgba(229,229,229,.5)',
                  }}>
                    {t === 'even_odd' ? 'Even / Odd' : 'Over / Under'}
                  </button>
                ))}
              </div>
            </div>

            {/* Barrier — only for Over/Under */}
            {tradeType === 'over_under' && (
              <div className="bt-card">
                <div className="bt-lbl">Barrier</div>
                <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                  {[0,1,2,3,4,5,6,7,8,9].map(d => (
                    <button key={d} onClick={() => setBarrier(d)} style={{
                      width:26, height:26, borderRadius:5, cursor:'pointer',
                      border:`1px solid ${barrier===d ? DIGIT_COLORS[d] : 'rgba(255,255,255,.1)'}`,
                      background: barrier===d ? `${DIGIT_COLORS[d]}22` : 'transparent',
                      color: barrier===d ? DIGIT_COLORS[d] : 'rgba(229,229,229,.45)',
                      fontWeight:800, fontSize:'.75rem',
                    }}>{d}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Stake */}
            <div className="bt-card">
              <div className="bt-lbl">Stake ({currency})</div>
              <input className="bt-inp" type="number" min="0.35" step="0.01" value={stake} onChange={e => setStake(e.target.value)} />
            </div>

            {/* Trade count */}
            <div className="bt-card">
              <div className="bt-lbl">Per Signal</div>
              <div style={{ display:'flex', gap:4 }}>
                {[1,3,5,10].map(n => (
                  <button key={n} className="sm-btn" onClick={() => setTradeCount(n)} style={{
                    background: tradeCount===n ? `${ACCENT}22`              : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tradeCount===n ? ACCENT        : 'rgba(255,255,255,.1)'}`,
                    color:      tradeCount===n ? ACCENT                     : 'rgba(229,229,229,.5)',
                  }}>{n}</button>
                ))}
              </div>
            </div>

            {/* Window */}
            <div className="bt-card">
              <div className="bt-lbl">Window</div>
              <div style={{ display:'flex', gap:4 }}>
                {[30,60,100].map(n => (
                  <button key={n} className="sm-btn" onClick={() => setTickWindow(n)} style={{
                    background: tickWindow===n ? 'rgba(252,163,17,.12)'     : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tickWindow===n ? 'rgba(252,163,17,.5)' : 'rgba(255,255,255,.1)'}`,
                    color:      tickWindow===n ? '#FCA311'                  : 'rgba(229,229,229,.5)',
                  }}>{n}</button>
                ))}
              </div>
            </div>

          </div>

          {/* Digit gauges */}
          <div className="bt-card">
            <div className="bt-lbl">Distribution — last {tickWindow} ticks</div>
            <div style={{ display:'flex', gap:'.4rem', justifyContent:'space-around', flexWrap:'wrap', paddingTop:4 }}>
              {Array.from({length:10},(_,d) => (
                <DigitGauge key={d} digit={d} count={digitCounts[d]} total={totalTicks} liveDigit={liveDigit} />
              ))}
            </div>
          </div>

          {/* Last 60 digits */}
          <div className="bt-card">
            <div className="bt-lbl">Last 60 Digits</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, paddingTop:4 }}>
              {recentDigits.slice(-60).map((d,i,arr) => (
                <span key={i} className="dot-cell" style={{
                  background: i===arr.length-1 ? DIGIT_COLORS[d] : `${DIGIT_COLORS[d]}1a`,
                  color:      i===arr.length-1 ? '#000'           : DIGIT_COLORS[d],
                  border:     `1px solid ${DIGIT_COLORS[d]}44`,
                  transform:  i===arr.length-1 ? 'scale(1.25)' : 'none',
                  transition: 'transform .15s',
                }}>{d}</span>
              ))}
            </div>
          </div>

          {/* Manual trade buttons */}
          <div className="bt-card">
            <div className="bt-lbl">Manual — fires {tradeCount} contracts now</div>
            <div style={{ display:'flex', gap:'.65rem', flexWrap:'wrap', alignItems:'center' }}>
              {tradeType === 'even_odd' ? <>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITEVEN')}
                  style={{ flex:1, padding:'.65rem', fontSize:'.9rem', background:'#22c55e', color:'#000' }}>
                  {isTrading ? 'Trading…' : `▲ Even ×${tradeCount}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITODD')}
                  style={{ flex:1, padding:'.65rem', fontSize:'.9rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading ? 'Trading…' : `▼ Odd ×${tradeCount}`}
                </button>
              </> : <>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITOVER')}
                  style={{ flex:1, padding:'.65rem', fontSize:'.9rem', background:'#22c55e', color:'#000' }}>
                  {isTrading ? 'Trading…' : `▲ Over ${barrier} ×${tradeCount}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITUNDER')}
                  style={{ flex:1, padding:'.65rem', fontSize:'.9rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading ? 'Trading…' : `▼ Under ${barrier} ×${tradeCount}`}
                </button>
              </>}
            </div>
            {tradeError && <p style={{ margin:'.45rem 0 0', fontSize:'.78rem', color:'#ef4444' }}>{tradeError}</p>}
          </div>

          {/* AI Scanner strip */}
          <div className="bt-card" style={{ borderColor: scannerActive ? `${ACCENT}44` : undefined }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'1rem', flexWrap:'wrap' }}>
              <div>
                <div className="bt-lbl" style={{ marginBottom:2 }}>AI Pattern Scanner</div>
                <p style={{ margin:0, fontSize:'.72rem', color:'rgba(229,229,229,.38)' }}>
                  {SCAN_SYMBOLS.length} markets · 30s cooldown · confidence ≥ 62%
                </p>
              </div>
              <div style={{ display:'flex', gap:'.5rem', alignItems:'center' }}>
                <span style={{
                  padding:'.28rem .7rem', borderRadius:20, fontSize:'.68rem', fontWeight:700,
                  background: scannerStatus==='idle' ? 'rgba(255,255,255,.05)' : scannerStatus==='scanning' ? `${ACCENT}18` : 'rgba(252,163,17,.15)',
                  color:      scannerStatus==='idle' ? 'rgba(229,229,229,.35)' : scannerStatus==='scanning' ? ACCENT             : '#FCA311',
                  border:     `1px solid ${scannerStatus==='idle' ? 'rgba(255,255,255,.07)' : scannerStatus==='scanning' ? `${ACCENT}44` : 'rgba(252,163,17,.3)'}`,
                }}>
                  {scannerStatus==='idle' ? '● IDLE' : scannerStatus==='scanning' ? '◉ SCANNING' : '⚡ FIRED'}
                </span>
                <button className="bt-btn" onClick={() => setScannerOpen(true)}
                  style={{ padding:'.38rem .8rem', fontSize:'.75rem', background:'rgba(255,255,255,.06)', color:'rgba(229,229,229,.7)', border:'1px solid rgba(255,255,255,.1)' }}>
                  Logs
                </button>
                <button className="bt-btn" onClick={scannerActive ? stopScanner : startScanner}
                  style={{ padding:'.38rem .9rem', fontSize:'.78rem', background: scannerActive ? 'rgba(239,68,68,.12)' : `${ACCENT}1a`, color: scannerActive ? '#ef4444' : ACCENT, border:`1px solid ${scannerActive ? 'rgba(239,68,68,.3)' : `${ACCENT}44`}` }}>
                  {scannerActive ? '■ Stop' : '▶ Start'}
                </button>
              </div>
            </div>
          </div>

        </div>{/* end LEFT */}

        {/* ── RIGHT: trade history panel ── */}
        <div style={{
          width:260, flexShrink:0, borderLeft:'1px solid rgba(255,255,255,.07)',
          display:'flex', flexDirection:'column', overflow:'hidden',
          background:'rgba(0,0,0,.15)',
        }}>
          {/* Panel header */}
          <div style={{ padding:'.75rem 1rem', borderBottom:'1px solid rgba(255,255,255,.07)', flexShrink:0 }}>
            <div style={{ fontSize:'.7rem', fontWeight:700, letterSpacing:'.08em', color:'rgba(229,229,229,.4)', textTransform:'uppercase', marginBottom:'.5rem' }}>
              Trade History
            </div>
            {/* Summary stats */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
              {[
                { label:'Total P&L', value: `${totalPnl >= 0 ? '+' : ''}${fmt2(totalPnl)}`, color: totalPnl > 0 ? '#22c55e' : totalPnl < 0 ? '#ef4444' : 'rgba(229,229,229,.5)' },
                { label:'Win Rate',  value: settled.length > 0 ? `${winRate.toFixed(0)}%` : '—', color: winRate >= 50 ? '#22c55e' : winRate > 0 ? '#ef4444' : 'rgba(229,229,229,.5)' },
                { label:'Trades',    value: String(settled.length),  color:'rgba(229,229,229,.7)' },
                { label:'Pending',   value: String(trades.filter(t => t.won === null).length), color:'#FCA311' },
              ].map(s => (
                <div key={s.label} style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.07)', borderRadius:8, padding:'.4rem .5rem' }}>
                  <div style={{ fontSize:'.58rem', color:'rgba(229,229,229,.35)', textTransform:'uppercase', letterSpacing:'.06em' }}>{s.label}</div>
                  <div style={{ fontSize:'.88rem', fontWeight:800, color:s.color, marginTop:1, fontVariantNumeric:'tabular-nums' }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Column headers */}
          <div className="hist-row" style={{ padding:'.3rem .5rem', borderBottom:'1px solid rgba(255,255,255,.05)', flexShrink:0 }}>
            <span style={{ fontSize:'.62rem', color:'rgba(229,229,229,.3)', fontWeight:700, textTransform:'uppercase' }}>Type · Market</span>
            <span style={{ fontSize:'.62rem', color:'rgba(229,229,229,.3)', fontWeight:700, textTransform:'uppercase', textAlign:'right' }}>Stake</span>
            <span style={{ fontSize:'.62rem', color:'rgba(229,229,229,.3)', fontWeight:700, textTransform:'uppercase', textAlign:'center' }}>Result</span>
            <span style={{ fontSize:'.62rem', color:'rgba(229,229,229,.3)', fontWeight:700, textTransform:'uppercase', textAlign:'right' }}>P&L</span>
          </div>

          {/* Trade rows */}
          <div style={{ flex:1, overflowY:'auto', padding:'.25rem .25rem' }}>
            {trades.length === 0 ? (
              <div style={{ padding:'2rem 1rem', textAlign:'center', color:'rgba(229,229,229,.2)', fontSize:'.78rem' }}>
                No trades yet.<br/>Fire a manual trade<br/>or start the scanner.
              </div>
            ) : trades.map(t => {
              const short = t.contractType.replace('DIGIT','')
              const mktShort = MARKETS.find(m=>m.symbol===t.symbol)?.label.replace('Volatility ','Vol ') ?? t.symbol
              const pnlColor = t.won === null ? '#FCA311' : t.won ? '#22c55e' : '#ef4444'
              const pnlText  = t.won === null ? '…' : `${(t.profit ?? 0) >= 0 ? '+' : ''}${fmt2(t.profit ?? 0)}`
              return (
                <div key={t.id} className="hist-row" style={{ animation:'fadeIn .2s ease' }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:'.72rem', fontWeight:700, color: t.source==='scanner' ? ACCENT : 'rgba(229,229,229,.85)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {short}
                    </div>
                    <div style={{ fontSize:'.6rem', color:'rgba(229,229,229,.3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{mktShort}</div>
                  </div>
                  <div style={{ textAlign:'right', fontSize:'.72rem', color:'rgba(229,229,229,.55)', fontVariantNumeric:'tabular-nums' }}>
                    {fmt2(t.stake)}
                  </div>
                  <div style={{ textAlign:'center' }}>
                    {t.won === null
                      ? <span style={{ fontSize:'.65rem', color:'#FCA311' }}>●</span>
                      : t.won
                        ? <span style={{ fontSize:'.65rem', color:'#22c55e' }}>✓</span>
                        : <span style={{ fontSize:'.65rem', color:'#ef4444' }}>✗</span>
                    }
                  </div>
                  <div style={{ textAlign:'right', fontSize:'.74rem', fontWeight:700, color:pnlColor, fontVariantNumeric:'tabular-nums' }}>
                    {pnlText}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Clear button */}
          {trades.length > 0 && (
            <div style={{ padding:'.5rem', borderTop:'1px solid rgba(255,255,255,.06)', flexShrink:0 }}>
              <button onClick={() => setTrades([])} style={{
                width:'100%', padding:'.38rem', borderRadius:7, cursor:'pointer',
                background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.08)',
                color:'rgba(229,229,229,.4)', fontSize:'.72rem', fontWeight:600,
              }}>Clear history</button>
            </div>
          )}
        </div>{/* end RIGHT */}

      </div>{/* end outer layout */}

      {/* ── AI Scanner Modal ── */}
      {scannerOpen && (
        <div className="scanner-bg" onClick={e => { if (e.target===e.currentTarget) setScannerOpen(false) }}>
          <div className="scanner-modal">
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'.85rem 1.1rem', borderBottom:`1px solid ${ACCENT}33`, background:`${ACCENT}08`, flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:'.5rem' }}>
                <span style={{ color:ACCENT, fontWeight:800, fontSize:'.9rem', letterSpacing:'.06em' }}>⣿ AI BULK SCANNER</span>
                {scannerActive && <span style={{ width:7, height:7, borderRadius:'50%', background:'#22c55e', boxShadow:'0 0 7px #22c55e', animation:'scanPulse 1.2s ease-in-out infinite', display:'inline-block' }} />}
              </div>
              <div style={{ display:'flex', gap:.5, gap:'.45rem' }}>
                <button className="bt-btn" onClick={scannerActive ? stopScanner : startScanner}
                  style={{ padding:'.32rem .75rem', fontSize:'.76rem', background: scannerActive ? 'rgba(239,68,68,.12)' : `${ACCENT}1a`, color: scannerActive ? '#ef4444' : ACCENT, border:`1px solid ${scannerActive ? 'rgba(239,68,68,.28)' : `${ACCENT}40`}` }}>
                  {scannerActive ? '■ Stop' : '▶ Start'}
                </button>
                <button onClick={() => setScannerOpen(false)} style={{ background:'transparent', border:'1px solid rgba(255,255,255,.1)', color:'rgba(229,229,229,.45)', borderRadius:7, padding:'.32rem .6rem', cursor:'pointer', fontSize:'.82rem' }}>✕</button>
              </div>
            </div>
            <div style={{ flex:1, overflowY:'auto', padding:'.65rem .9rem', fontFamily:"'SF Mono','Fira Code','Consolas',monospace", fontSize:'.75rem', lineHeight:1.75, background:'#040b0a' }}>
              {logLines.length === 0
                ? <p style={{ color:'rgba(229,229,229,.2)', margin:0 }}>{scannerActive ? 'Waiting for signals…' : 'Start the scanner to begin monitoring.'}</p>
                : logLines.map(l => (
                    <div key={l.id} className={`ll-${l.color}`}>
                      <span style={{ color:'rgba(229,229,229,.18)', marginRight:'.45rem', fontSize:'.67rem' }}>{fmtTime(l.ts)}</span>{l.text}
                    </div>
                  ))
              }
            </div>
            <div style={{ padding:'.5rem .9rem', borderTop:`1px solid ${ACCENT}1a`, display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:'.68rem', color:'rgba(229,229,229,.28)', flexShrink:0 }}>
              <span>Confidence ≥62% · cooldown 30s/market</span>
              <button onClick={() => setLogLines([])} style={{ background:'transparent', border:'none', color:'rgba(229,229,229,.28)', cursor:'pointer', fontSize:'.68rem' }}>Clear</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
