'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'
const ACCENT = '#00e5cc'

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

/* ─── Helpers ────────────────────────────────────────────────────────────── */
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

/**
 * Shannon entropy of digit distribution.
 * Returns 0 (perfectly predictable) → ~3.32 (perfectly uniform).
 * Low entropy = clustering = tradeable signal.
 */
function shannonEntropy(digits: number[]): number {
  if (digits.length === 0) return 0
  const freq = Array(10).fill(0)
  digits.forEach(d => freq[d]++)
  return freq.reduce((H, c) => {
    if (c === 0) return H
    const p = c / digits.length
    return H - p * Math.log2(p)
  }, 0)
}

/**
 * AI Scanner pattern detection — fully autonomous direction selection.
 *
 * The scanner always uses BARRIER=5 for Over/Under (balanced natural split).
 * It auto-picks the best direction (OVER vs UNDER, EVEN vs ODD) based on data.
 * Never hardcodes a direction.
 *
 * Confidence scoring (0–100):
 *   • Base signal strength        (0–50)
 *   • Multi-window agreement      (+0–20)  both 30 and 60 tick windows agree
 *   • Entropy bonus               (+0–15)  low entropy = non-random distribution
 *   • Persistence bonus           (+0–15)  pattern present across 3 consecutive checks
 *
 * Fires only when composite score ≥ 70.
 */
interface ScanResult {
  signal:       boolean
  score:        number   // 0–100 composite
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | null
  barrier:      number | null
  reason:       string
  detail:       string   // detailed breakdown for the log
}

function trailingStreak(arr: number[], predicate: (d: number) => boolean): number {
  let streak = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) streak++; else break
  }
  return streak
}

function analyseWindow(digits: number[], tradeType: 'even_odd' | 'over_under') {
  if (digits.length < 10) return null
  if (tradeType === 'even_odd') {
    const evenCnt = digits.filter(d => d % 2 === 0).length
    const oddCnt  = digits.length - evenCnt
    const evenPct = evenCnt / digits.length
    const oddPct  = oddCnt  / digits.length
    const streak  = trailingStreak(digits, d => d % 2 === digits.at(-1)! % 2)
    const streakDir = digits.at(-1)! % 2 === 0 ? 'even' : 'odd'
    return { type: 'even_odd' as const, evenPct, oddPct, streak, streakDir }
  } else {
    // Always use barrier 5 — balanced natural split (5 digits each side)
    const BARRIER = 5
    const overCnt  = digits.filter(d => d > BARRIER).length
    const underCnt = digits.filter(d => d < BARRIER).length
    const overPct  = overCnt  / digits.length
    const underPct = underCnt / digits.length
    const streak   = trailingStreak(digits, d => (digits.at(-1)! > BARRIER ? d > BARRIER : d < BARRIER))
    const streakDir = digits.at(-1)! > BARRIER ? 'over' : 'under'
    return { type: 'over_under' as const, overPct, underPct, streak, streakDir, barrier: BARRIER }
  }
}

function detectSignal(
  digits: number[],
  tradeType: 'even_odd' | 'over_under',
  persistCount: number,  // how many consecutive 5-tick checks showed the same pattern
): ScanResult {
  const none: ScanResult = { signal: false, score: 0, contractType: null, barrier: null, reason: '', detail: '' }
  if (digits.length < 30) return none

  const w60 = analyseWindow(digits.slice(-60), tradeType)
  const w30 = analyseWindow(digits.slice(-30), tradeType)
  if (!w60 || !w30) return none

  const entropy60 = shannonEntropy(digits.slice(-60))
  // Entropy bonus: max 15 pts when entropy ≤ 2.8 (vs uniform ~3.32)
  const entropyBonus = Math.max(0, Math.round((3.32 - entropy60) / 3.32 * 15 * 2))
  const clampedEntropyBonus = Math.min(15, entropyBonus)

  // Persistence bonus: 5pts per consecutive check (max 15)
  const persistBonus = Math.min(15, persistCount * 5)

  if (tradeType === 'even_odd') {
    const a60 = w60 as Extract<ReturnType<typeof analyseWindow>, { type: 'even_odd' }>
    const a30 = w30 as Extract<ReturnType<typeof analyseWindow>, { type: 'even_odd' }>

    // Frequency imbalance signal (60-tick window)
    const dominant60 = a60.evenPct > a60.oddPct ? 'even' : 'odd'
    const domPct60   = Math.max(a60.evenPct, a60.oddPct)
    const dominant30 = a30.evenPct > a30.oddPct ? 'even' : 'odd'
    const domPct30   = Math.max(a30.evenPct, a30.oddPct)

    // Base: how strong is the 60-window imbalance?
    if (domPct60 < 0.56) return none  // not enough imbalance

    // Bet AGAINST the dominant side (contrarian — reversion to mean)
    const betType: 'DIGITEVEN' | 'DIGITODD' = dominant60 === 'even' ? 'DIGITODD' : 'DIGITEVEN'
    const baseScore = Math.round((domPct60 - 0.56) / 0.44 * 50)

    // Multi-window agreement: same dominant side in both windows
    const windowAgree = dominant60 === dominant30
    const windowBonus = windowAgree ? Math.round((domPct30 - 0.5) / 0.5 * 20) : 0

    // Streak bonus (included in base if streak ≥ 5)
    const streakBonus = a60.streak >= 5 ? Math.min(10, a60.streak * 2) : 0

    const score = Math.min(100, baseScore + Math.max(windowBonus, 0) + clampedEntropyBonus + persistBonus + streakBonus)

    if (score < 70) return none

    const reason = `${dominant60 === 'even' ? 'Even' : 'Odd'} dominates ${Math.round(domPct60*100)}% (60t) ${Math.round(domPct30*100)}% (30t) → bet ${betType === 'DIGITEVEN' ? 'Even' : 'Odd'}`
    const detail = `base=${baseScore} win=${windowBonus} entropy=${clampedEntropyBonus} persist=${persistBonus} streak=${streakBonus}`
    return { signal: true, score, contractType: betType, barrier: null, reason, detail }
  }

  // over_under — barrier 5 always
  const BARRIER = 5
  const a60 = w60 as Extract<ReturnType<typeof analyseWindow>, { type: 'over_under' }>
  const a30 = w30 as Extract<ReturnType<typeof analyseWindow>, { type: 'over_under' }>

  const dominant60 = a60.overPct > a60.underPct ? 'over' : 'under'
  const domPct60   = Math.max(a60.overPct, a60.underPct)
  const dominant30 = a30.overPct > a30.underPct ? 'over' : 'under'
  const domPct30   = Math.max(a30.overPct, a30.underPct)

  if (domPct60 < 0.56) return none

  // Bet AGAINST the dominant side
  const betType: 'DIGITOVER' | 'DIGITUNDER' = dominant60 === 'over' ? 'DIGITUNDER' : 'DIGITOVER'
  const baseScore = Math.round((domPct60 - 0.56) / 0.44 * 50)
  const windowAgree  = dominant60 === dominant30
  const windowBonus  = windowAgree ? Math.round((domPct30 - 0.5) / 0.5 * 20) : 0
  const streakBonus  = a60.streak >= 5 ? Math.min(10, a60.streak * 2) : 0
  const score = Math.min(100, baseScore + Math.max(windowBonus, 0) + clampedEntropyBonus + persistBonus + streakBonus)

  if (score < 70) return none

  const direction = betType === 'DIGITOVER' ? `Over ${BARRIER}` : `Under ${BARRIER}`
  const reason = `${dominant60 === 'over' ? 'Over' : 'Under'} ${BARRIER} dominates ${Math.round(domPct60*100)}% (60t) ${Math.round(domPct30*100)}% (30t) → bet ${direction}`
  const detail = `base=${baseScore} win=${windowBonus} entropy=${clampedEntropyBonus} persist=${persistBonus} streak=${streakBonus}`
  return { signal: true, score, contractType: betType, barrier: BARRIER, reason, detail }
}

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface TradeRow {
  id:           number
  ts:           number
  contractType: string
  symbol:       string
  stake:        number
  payout:       number
  won:          boolean | null
  profit:       number | null
  source:       'manual' | 'scanner'
}

interface LogLine {
  id:    number
  text:  string
  color: 'green' | 'amber' | 'red' | 'cyan' | 'white'
  ts:    number
}

/* ─── Digit Gauge ────────────────────────────────────────────────────────── */
function DigitGauge({ digit, count, total, liveDigit }: { digit: number; count: number; total: number; liveDigit: number | null }) {
  const pct  = total > 0 ? (count / total) * 100 : 0
  const r    = 18, circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const live = liveDigit === digit
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
      <svg width="46" height="46" viewBox="0 0 46 46">
        <circle cx="23" cy="23" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="4"/>
        <circle cx="23" cy="23" r={r} fill="none"
          stroke={live ? '#fff' : DIGIT_COLORS[digit]} strokeWidth={live ? 5 : 3.5}
          strokeDasharray={`${dash} ${circ-dash}`} strokeDashoffset={circ/4}
          strokeLinecap="round"
          style={{ transition:'stroke-dasharray 0.3s', filter: live ? `drop-shadow(0 0 5px ${DIGIT_COLORS[digit]})` : 'none' }}
        />
        <text x="23" y="27" textAnchor="middle" fontSize="12" fontWeight="800" fill={live ? '#fff' : DIGIT_COLORS[digit]}>{digit}</text>
      </svg>
      <span style={{ fontSize:'.62rem', color:'rgba(229,229,229,.45)' }}>{pct.toFixed(0)}%</span>
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
  const reqIdRef        = useRef(0)
  const intentionalClose = useRef(false)

  /* ── Trade history ── */
  const [trades,   setTrades]   = useState<TradeRow[]>([])
  const tradeIdRef = useRef(0)

  /* ── Panel ── */
  const [panelTab, setPanelTab] = useState<'trades' | 'scanner'>('trades')

  /* ── AI Scanner ── */
  const [scannerActive, setScannerActive] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<'idle' | 'scanning' | 'fired'>('idle')
  const [logLines,      setLogLines]      = useState<LogLine[]>([])
  const logIdRef        = useRef(0)
  const scannerWsRefs   = useRef<Map<string, WebSocket>>(new Map())
  const scannerDigits   = useRef<Map<string, number[]>>(new Map())
  const cooldowns       = useRef<Map<string, number>>(new Map())
  const persistCounts   = useRef<Map<string, number>>(new Map())  // consecutive signal checks per market
  const scannerBotWsRef = useRef<WebSocket | null>(null)
  // Snapshot scanner settings at start time
  const scanTradeTypeRef  = useRef<'even_odd'|'over_under'>('even_odd')
  const scanStakeRef      = useRef('1.00')
  const scanCountRef      = useRef(3)
  const scanCurrencyRef   = useRef('USD')

  /* ── Digit counts ── */
  useEffect(() => {
    const counts = Array(10).fill(0)
    recentDigits.slice(-tickWindow).forEach(d => counts[d]++)
    setDigitCounts(counts)
  }, [recentDigits, tickWindow])

  /* ── Derived stats ── */
  const settled  = trades.filter(t => t.won !== null)
  const wins     = settled.filter(t => t.won)
  const totalPnl = settled.reduce((s, t) => s + (t.profit ?? 0), 0)
  const winRate  = settled.length > 0 ? (wins.length / settled.length) * 100 : 0

  /* ── Public WS: live ticks ── */
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => ws.send(JSON.stringify({ ticks_history: symbol, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
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
        if (q != null) { setLivePrice(q); setRecentDigits(prev => [...prev.slice(-99), lastDigit(Number(q), pipSizeRef.current)]) }
      }
    }
    ws.onerror = () => {}; ws.onclose = () => {}
    return () => {
      if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({ forget_all:'ticks', req_id:9999 })) } catch { /**/ }
      ws.close(); setLivePrice(null); setRecentDigits([])
    }
  }, [symbol])

  /* ── Log helper ── */
  const log = useCallback((text: string, color: LogLine['color'] = 'white') => {
    setLogLines(prev => [...prev.slice(-300), { id: ++logIdRef.current, text, color, ts: Date.now() }])
  }, [])

  /* ── Add / settle trade rows ── */
  const addTrade = useCallback((contractType: string, sym: string, stakeVal: number, source: 'manual'|'scanner'): number => {
    const id = ++tradeIdRef.current
    setTrades(prev => [{ id, ts:Date.now(), contractType, symbol:sym, stake:stakeVal, payout:0, won:null, profit:null, source }, ...prev.slice(0,199)])
    return id
  }, [])

  const settleTrade = useCallback((rowId: number, payout: number, stakeVal: number) => {
    const profit = payout - stakeVal
    setTrades(prev => prev.map(t => t.id === rowId ? { ...t, payout, profit, won: profit > 0 } : t))
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
      ws.send(JSON.stringify({ balance:1, subscribe:1, req_id:51 }))
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

  /* ── Fire trades helper ── */
  const fireTrades = useCallback((
    ws: WebSocket, contractType: string, barrierVal: number|null,
    stakeVal: number, count: number, sym: string, cur: string,
    source: 'manual'|'scanner',
    reqToRow: Map<number, number>, pending: Map<number, { rowId:number; stake:number }>,
  ) => {
    for (let i = 0; i < count; i++) {
      const reqId = ++reqIdRef.current
      const rowId = addTrade(contractType, sym, stakeVal, source)
      pending.set(reqId, { rowId, stake: stakeVal })
      ws.send(JSON.stringify({
        buy:'1', price:1000, req_id:reqId,
        parameters: {
          contract_type:     contractType,
          underlying_symbol: sym,
          duration:5, duration_unit:'t',
          amount:stakeVal, basis:'stake', currency:cur,
          ...(barrierVal !== null ? { barrier: String(barrierVal) } : {}),
        },
      }))
    }
  }, [addTrade])

  /* ── Manual trade ── */
  const handleManualTrade = useCallback(async (contractType: string) => {
    if (isTrading) return
    setIsTrading(true); setTradeError(null)
    const stakeVal = parseFloat(stake) || 1
    const ws = await connectBotWs()
    if (!ws) { setTradeError('Connection failed'); setIsTrading(false); return }
    intentionalClose.current = false
    const pending  = new Map<number, { rowId:number; stake:number }>()
    const reqToRow = new Map<number, number>()
    let settled = 0
    const n = tradeCount

    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:msg.balance?.balance, currency:msg.balance?.currency }}))
      if (msg.msg_type === 'buy') {
        const ri = pending.get(msg.req_id)
        if (ri && msg.buy?.contract_id) reqToRow.set(msg.buy.contract_id, ri.rowId)
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const cid    = msg.transaction.contract_id as number
        const payout = Math.abs(msg.transaction.amount ?? 0)
        const rowId  = reqToRow.get(cid)
        let stk = stakeVal
        for (const [, v] of pending) { stk = v.stake; break }
        if (rowId != null) settleTrade(rowId, payout, stk)
        settled++
        if (settled >= n) { intentionalClose.current = true; ws.close(); setIsTrading(false) }
      }
      if (msg.error) { setTradeError(msg.error.message ?? 'Trade error'); intentionalClose.current = true; ws.close(); setIsTrading(false) }
    }
    ws.onclose = () => { if (!intentionalClose.current) setIsTrading(false) }
    ws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))
    fireTrades(ws, contractType, tradeType === 'over_under' ? barrier : null, stakeVal, n, symbol, currency, 'manual', reqToRow, pending)
  }, [isTrading, stake, tradeCount, tradeType, barrier, symbol, currency, connectBotWs, fireTrades, settleTrade])

  /* ── AI Scanner ── */
  const startScanner = useCallback(async () => {
    setScannerActive(true); setScannerStatus('scanning'); setLogLines([])
    setPanelTab('scanner')
    // Snapshot settings
    scanTradeTypeRef.current = tradeType
    scanStakeRef.current     = stake
    scanCountRef.current     = tradeCount
    scanCurrencyRef.current  = currency

    log('━━━ AI BULK SCANNER v2 STARTED ━━━', 'cyan')
    log(`Type: ${tradeType === 'even_odd' ? 'Even/Odd' : 'Over/Under (barrier auto=5)'}`, 'white')
    log(`Markets: ${SCAN_SYMBOLS.join(' · ')}`, 'white')
    log(`Threshold: composite score ≥ 70 · 30s cooldown · 3-check persistence`, 'white')
    log('Multi-window + entropy + persistence scoring active.', 'green')

    const bws = await connectBotWs()
    if (!bws) { log('ERROR: Could not connect trading WS', 'red'); setScannerActive(false); setScannerStatus('idle'); return }
    scannerBotWsRef.current = bws
    const scanPending  = new Map<number, { rowId:number; stake:number }>()
    const scanReqToRow = new Map<number, number>()

    bws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:msg.balance?.balance, currency:msg.balance?.currency }}))
      if (msg.msg_type === 'buy') {
        const ri = scanPending.get(msg.req_id)
        if (ri && msg.buy?.contract_id) { scanReqToRow.set(msg.buy.contract_id, ri.rowId); log(`  ✓ Contract ${msg.buy.contract_id} bought`, 'green') }
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const cid    = msg.transaction.contract_id as number
        const payout = Math.abs(msg.transaction.amount ?? 0)
        const rowId  = scanReqToRow.get(cid)
        let stk = parseFloat(scanStakeRef.current) || 1
        for (const [, v] of scanPending) { stk = v.stake; break }
        if (rowId != null) { settleTrade(rowId, payout, stk); log(`  ${payout > stk ? '✓ WIN' : '✗ LOSS'} ${payout > stk ? '+' : ''}${fmt2(payout-stk)} ${scanCurrencyRef.current}`, payout > stk ? 'green' : 'red') }
      }
      if (msg.error) log(`  ERROR: ${msg.error.message}`, 'red')
    }
    bws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))

    SCAN_SYMBOLS.forEach(sym => {
      scannerDigits.current.set(sym, [])
      persistCounts.current.set(sym, 0)
      const ws = new WebSocket(PUBLIC_WS_URL)
      scannerWsRefs.current.set(sym, ws)
      let localPipSize = 2
      let tickCount = 0

      ws.onopen = () => ws.send(JSON.stringify({ ticks_history:sym, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
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
          if (digits.length > 300) digits.shift()
          scannerDigits.current.set(sym, digits)
          tickCount++

          // Evaluate every 5 ticks
          if (tickCount % 5 !== 0) return

          const lastFired = cooldowns.current.get(sym) ?? 0
          if (Date.now() - lastFired < 30_000) return

          const tt      = scanTradeTypeRef.current
          const persist = persistCounts.current.get(sym) ?? 0
          const result  = detectSignal(digits, tt, persist)

          if (result.signal && result.contractType) {
            // Increment persistence counter
            persistCounts.current.set(sym, persist + 1)

            // Only fire after 3 consecutive positive checks (persistence requirement)
            if (persist + 1 < 3) {
              log(`  ${sym} signal building… (${persist+1}/3 checks, score=${result.score})`, 'white')
              return
            }

            // Fire!
            const mkt = MARKETS.find(m => m.symbol === sym)?.label ?? sym
            const direction = result.contractType.replace('DIGIT','')
            const barrierStr = result.barrier !== null ? ` ${result.barrier}` : ''
            log(`━━ SIGNAL: ${mkt} ━━`, 'cyan')
            log(`  ${result.reason}`, 'amber')
            log(`  Score: ${result.score}/100 [${result.detail}]`, 'white')
            log(`  → Firing ${scanCountRef.current}× ${direction}${barrierStr} @ ${scanStakeRef.current} ${scanCurrencyRef.current}`, 'green')

            cooldowns.current.set(sym, Date.now())
            persistCounts.current.set(sym, 0)  // reset after firing
            setScannerStatus('fired'); setTimeout(() => setScannerStatus('scanning'), 3000)

            if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
              fireTrades(
                scannerBotWsRef.current, result.contractType, result.barrier,
                parseFloat(scanStakeRef.current) || 1, scanCountRef.current,
                sym, scanCurrencyRef.current, 'scanner', scanReqToRow, scanPending,
              )
            }
          } else {
            // Pattern gone — reset persistence
            if (persist > 0) persistCounts.current.set(sym, 0)
          }
        }
      }
      ws.onerror = () => log(`WS error: ${sym}`, 'red')
    })
  }, [tradeType, stake, tradeCount, currency, connectBotWs, fireTrades, settleTrade, log])

  const stopScanner = useCallback(() => {
    setScannerActive(false); setScannerStatus('idle')
    log('━━━ SCANNER STOPPED ━━━', 'amber')
    scannerWsRefs.current.forEach(ws => { try { ws.close() } catch { /**/ } })
    scannerWsRefs.current.clear(); scannerDigits.current.clear()
    cooldowns.current.clear(); persistCounts.current.clear()
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
        .bt-card { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:.85rem 1rem; }
        .bt-lbl  { font-size:.63rem; font-weight:700; letter-spacing:.08em; color:rgba(229,229,229,.38); text-transform:uppercase; margin-bottom:.4rem; }
        .bt-sel  { width:100%; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#e5e5e5; padding:.48rem .65rem; font-size:.8rem; outline:none; cursor:pointer; }
        .bt-inp  { width:100%; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#e5e5e5; padding:.48rem .65rem; font-size:.88rem; outline:none; box-sizing:border-box; }
        .bt-inp:focus { border-color:${ACCENT}; }
        .bt-btn  { border:none; border-radius:8px; font-weight:800; cursor:pointer; transition:opacity .15s; }
        .bt-btn:disabled { opacity:.4; cursor:not-allowed; }
        .tt-chip { padding:.4rem 0; border-radius:7px; font-size:.74rem; font-weight:700; cursor:pointer; border:1px solid transparent; transition:all .15s; text-align:center; flex:1; }
        .sm-btn  { padding:.36rem 0; border-radius:6px; font-size:.77rem; font-weight:800; cursor:pointer; border:1px solid transparent; transition:all .15s; flex:1; text-align:center; }
        .dot-cell { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:4px; font-size:.67rem; font-weight:800; flex-shrink:0; }
        .hist-row { display:grid; grid-template-columns:1fr 62px 36px 58px; gap:3px; align-items:center; padding:.32rem .45rem; border-radius:5px; font-size:.7rem; }
        .hist-row:hover { background:rgba(255,255,255,.04); }
        .panel-tab { flex:1; padding:.45rem; text-align:center; font-size:.72rem; font-weight:700; cursor:pointer; border-bottom:2px solid transparent; transition:all .15s; color:rgba(229,229,229,.4); }
        .panel-tab.active { color:#e5e5e5; border-bottom-color:${ACCENT}; }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-3px)} to{opacity:1;transform:none} }
        @keyframes scanPulse { 0%,100%{opacity:1} 50%{opacity:.25} }
      `}</style>

      <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

        {/* ── LEFT: main content ── */}
        <div style={{ flex:1, minWidth:0, overflowY:'auto', padding:'1rem', display:'flex', flexDirection:'column', gap:'.8rem' }}>

          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'.5rem' }}>
            <div>
              <h1 style={{ margin:0, fontSize:'1.15rem', fontWeight:900, color:'#fff' }}>⣿ Bulk Trader</h1>
              <p style={{ margin:'1px 0 0', fontSize:'.7rem', color:'rgba(229,229,229,.35)' }}>Fire multiple contracts simultaneously on pattern signals</p>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:'1.3rem', fontWeight:900, color:ACCENT, fontVariantNumeric:'tabular-nums' }}>
                {livePrice != null ? livePrice.toFixed(pipSizeRef.current) : '—'}
              </div>
              <div style={{ fontSize:'.62rem', color:'rgba(229,229,229,.3)' }}>LIVE PRICE</div>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(145px,1fr))', gap:'.6rem' }}>

            <div className="bt-card">
              <div className="bt-lbl">Market</div>
              <select className="bt-sel" value={symbol} onChange={e => setSymbol(e.target.value)}>
                {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
              </select>
            </div>

            <div className="bt-card">
              <div className="bt-lbl">Trade Type</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {(['even_odd','over_under'] as const).map(t => (
                  <button key={t} className="tt-chip" onClick={() => setTradeType(t)} style={{
                    background: tradeType===t ? `${ACCENT}22` : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tradeType===t ? ACCENT : 'rgba(255,255,255,.1)'}`,
                    color:      tradeType===t ? ACCENT : 'rgba(229,229,229,.5)',
                  }}>{t === 'even_odd' ? 'Even / Odd' : 'Over / Under'}</button>
                ))}
              </div>
            </div>

            {tradeType === 'over_under' && (
              <div className="bt-card">
                <div className="bt-lbl">Barrier <span style={{ color:ACCENT, fontSize:'.58rem' }}>(manual only)</span></div>
                <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                  {[0,1,2,3,4,5,6,7,8,9].map(d => (
                    <button key={d} onClick={() => setBarrier(d)} style={{
                      width:25, height:25, borderRadius:5, cursor:'pointer',
                      border:`1px solid ${barrier===d ? DIGIT_COLORS[d] : 'rgba(255,255,255,.1)'}`,
                      background: barrier===d ? `${DIGIT_COLORS[d]}22` : 'transparent',
                      color: barrier===d ? DIGIT_COLORS[d] : 'rgba(229,229,229,.4)',
                      fontWeight:800, fontSize:'.72rem',
                    }}>{d}</button>
                  ))}
                </div>
                <p style={{ margin:'5px 0 0', fontSize:'.6rem', color:'rgba(229,229,229,.3)' }}>AI scanner uses barrier 5 automatically</p>
              </div>
            )}

            <div className="bt-card">
              <div className="bt-lbl">Stake ({currency})</div>
              <input className="bt-inp" type="number" min="0.35" step="0.01" value={stake} onChange={e => setStake(e.target.value)} />
            </div>

            <div className="bt-card">
              <div className="bt-lbl">Per Signal</div>
              <div style={{ display:'flex', gap:4 }}>
                {[1,3,5,10].map(n => (
                  <button key={n} className="sm-btn" onClick={() => setTradeCount(n)} style={{
                    background: tradeCount===n ? `${ACCENT}22` : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tradeCount===n ? ACCENT : 'rgba(255,255,255,.1)'}`,
                    color:      tradeCount===n ? ACCENT : 'rgba(229,229,229,.5)',
                  }}>{n}</button>
                ))}
              </div>
            </div>

            <div className="bt-card">
              <div className="bt-lbl">Window</div>
              <div style={{ display:'flex', gap:4 }}>
                {[30,60,100].map(n => (
                  <button key={n} className="sm-btn" onClick={() => setTickWindow(n)} style={{
                    background: tickWindow===n ? 'rgba(252,163,17,.12)' : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tickWindow===n ? 'rgba(252,163,17,.5)' : 'rgba(255,255,255,.1)'}`,
                    color:      tickWindow===n ? '#FCA311' : 'rgba(229,229,229,.5)',
                  }}>{n}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Digit gauges */}
          <div className="bt-card">
            <div className="bt-lbl">Distribution — last {tickWindow} ticks</div>
            <div style={{ display:'flex', gap:'.35rem', justifyContent:'space-around', flexWrap:'wrap', paddingTop:4 }}>
              {Array.from({length:10},(_,d) => <DigitGauge key={d} digit={d} count={digitCounts[d]} total={totalTicks} liveDigit={liveDigit} />)}
            </div>
          </div>

          {/* Last 60 digits */}
          <div className="bt-card">
            <div className="bt-lbl">Last 60 Digits</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, paddingTop:4 }}>
              {recentDigits.slice(-60).map((d,i,arr) => (
                <span key={i} className="dot-cell" style={{
                  background: i===arr.length-1 ? DIGIT_COLORS[d] : `${DIGIT_COLORS[d]}18`,
                  color:      i===arr.length-1 ? '#000' : DIGIT_COLORS[d],
                  border:`1px solid ${DIGIT_COLORS[d]}44`,
                  transform:  i===arr.length-1 ? 'scale(1.25)' : 'none',
                  transition:'transform .15s',
                }}>{d}</span>
              ))}
            </div>
          </div>

          {/* Manual trade */}
          <div className="bt-card">
            <div className="bt-lbl">Manual — fires {tradeCount} contracts now</div>
            <div style={{ display:'flex', gap:'.6rem' }}>
              {tradeType === 'even_odd' ? <>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITEVEN')}
                  style={{ flex:1, padding:'.6rem', fontSize:'.88rem', background:'#22c55e', color:'#000' }}>
                  {isTrading ? 'Trading…' : `▲ Even ×${tradeCount}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITODD')}
                  style={{ flex:1, padding:'.6rem', fontSize:'.88rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading ? 'Trading…' : `▼ Odd ×${tradeCount}`}
                </button>
              </> : <>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITOVER')}
                  style={{ flex:1, padding:'.6rem', fontSize:'.88rem', background:'#22c55e', color:'#000' }}>
                  {isTrading ? 'Trading…' : `▲ Over ${barrier} ×${tradeCount}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITUNDER')}
                  style={{ flex:1, padding:'.6rem', fontSize:'.88rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading ? 'Trading…' : `▼ Under ${barrier} ×${tradeCount}`}
                </button>
              </>}
            </div>
            {tradeError && <p style={{ margin:'.4rem 0 0', fontSize:'.76rem', color:'#ef4444' }}>{tradeError}</p>}
          </div>

          {/* Scanner strip */}
          <div className="bt-card" style={{ borderColor: scannerActive ? `${ACCENT}44` : undefined }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'.75rem', flexWrap:'wrap' }}>
              <div>
                <div className="bt-lbl" style={{ marginBottom:2 }}>AI Pattern Scanner v2</div>
                <p style={{ margin:0, fontSize:'.7rem', color:'rgba(229,229,229,.35)' }}>
                  Multi-window · entropy · persistence · score ≥ 70
                </p>
              </div>
              <div style={{ display:'flex', gap:'.45rem', alignItems:'center' }}>
                <span style={{
                  padding:'.26rem .65rem', borderRadius:20, fontSize:'.67rem', fontWeight:700,
                  background: scannerStatus==='idle' ? 'rgba(255,255,255,.05)' : scannerStatus==='scanning' ? `${ACCENT}18` : 'rgba(252,163,17,.15)',
                  color:      scannerStatus==='idle' ? 'rgba(229,229,229,.32)' : scannerStatus==='scanning' ? ACCENT : '#FCA311',
                  border:     `1px solid ${scannerStatus==='idle' ? 'rgba(255,255,255,.07)' : scannerStatus==='scanning' ? `${ACCENT}44` : 'rgba(252,163,17,.3)'}`,
                }}>
                  {scannerActive && <span style={{ width:6, height:6, borderRadius:'50%', background: scannerStatus==='fired' ? '#FCA311' : '#22c55e', display:'inline-block', marginRight:5, animation:'scanPulse 1.2s ease infinite' }} />}
                  {scannerStatus==='idle' ? 'IDLE' : scannerStatus==='scanning' ? 'SCANNING' : 'FIRED'}
                </span>
                <button className="bt-btn" onClick={() => setPanelTab('scanner')}
                  style={{ padding:'.32rem .75rem', fontSize:'.73rem', background:'rgba(255,255,255,.06)', color:'rgba(229,229,229,.65)', border:'1px solid rgba(255,255,255,.1)' }}>
                  View Logs →
                </button>
                <button className="bt-btn" onClick={scannerActive ? stopScanner : startScanner}
                  style={{ padding:'.32rem .85rem', fontSize:'.76rem', background: scannerActive ? 'rgba(239,68,68,.12)' : `${ACCENT}1a`, color: scannerActive ? '#ef4444' : ACCENT, border:`1px solid ${scannerActive ? 'rgba(239,68,68,.28)' : `${ACCENT}44`}` }}>
                  {scannerActive ? '■ Stop' : '▶ Start'}
                </button>
              </div>
            </div>
          </div>

        </div>{/* end LEFT */}

        {/* ── RIGHT PANEL ── */}
        <div style={{ width:265, flexShrink:0, borderLeft:'1px solid rgba(255,255,255,.07)', display:'flex', flexDirection:'column', overflow:'hidden', background:'rgba(0,0,0,.18)' }}>

          {/* Tabs */}
          <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,.07)', flexShrink:0, background:'rgba(255,255,255,.02)' }}>
            <button className={`panel-tab${panelTab==='trades' ? ' active' : ''}`} onClick={() => setPanelTab('trades')}>
              Trades {settled.length > 0 && <span style={{ fontSize:'.6rem', color:'rgba(229,229,229,.4)' }}>({settled.length})</span>}
            </button>
            <button className={`panel-tab${panelTab==='scanner' ? ' active' : ''}`} onClick={() => setPanelTab('scanner')}>
              Scanner {scannerActive && <span style={{ width:5, height:5, borderRadius:'50%', background:'#22c55e', display:'inline-block', marginLeft:4, animation:'scanPulse 1.2s ease infinite' }} />}
            </button>
          </div>

          {/* Stats strip — always visible */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5, padding:'.6rem', borderBottom:'1px solid rgba(255,255,255,.06)', flexShrink:0 }}>
            {[
              { label:'Total P&L', value:`${totalPnl>=0?'+':''}${fmt2(totalPnl)}`, color: totalPnl>0?'#22c55e':totalPnl<0?'#ef4444':'rgba(229,229,229,.45)' },
              { label:'Win Rate',  value: settled.length>0 ? `${winRate.toFixed(0)}%` : '—', color: winRate>=50?'#22c55e':winRate>0?'#ef4444':'rgba(229,229,229,.45)' },
              { label:'Trades',    value: String(settled.length), color:'rgba(229,229,229,.7)' },
              { label:'Pending',   value: String(trades.filter(t=>t.won===null).length), color:'#FCA311' },
            ].map(s => (
              <div key={s.label} style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:7, padding:'.35rem .45rem' }}>
                <div style={{ fontSize:'.56rem', color:'rgba(229,229,229,.32)', textTransform:'uppercase', letterSpacing:'.05em' }}>{s.label}</div>
                <div style={{ fontSize:'.85rem', fontWeight:800, color:s.color, marginTop:1, fontVariantNumeric:'tabular-nums' }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Tab content */}
          {panelTab === 'trades' ? (
            <>
              {/* Column headers */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 62px 36px 58px', gap:3, padding:'.28rem .45rem', borderBottom:'1px solid rgba(255,255,255,.04)', flexShrink:0 }}>
                {['Type/Mkt','Stake','','P&L'].map((h,i) => (
                  <span key={i} style={{ fontSize:'.58rem', color:'rgba(229,229,229,.28)', fontWeight:700, textTransform:'uppercase', textAlign: i>=2?'center':i===1?'right':'left' }}>{h}</span>
                ))}
              </div>
              <div style={{ flex:1, overflowY:'auto', padding:'.2rem' }}>
                {trades.length === 0 ? (
                  <div style={{ padding:'2rem 1rem', textAlign:'center', color:'rgba(229,229,229,.18)', fontSize:'.75rem' }}>No trades yet.</div>
                ) : trades.map(t => {
                  const short   = t.contractType.replace('DIGIT','')
                  const mkt     = MARKETS.find(m=>m.symbol===t.symbol)?.label.replace('Volatility ','V') ?? t.symbol
                  const pnlClr  = t.won===null ? '#FCA311' : t.won ? '#22c55e' : '#ef4444'
                  const pnlTxt  = t.won===null ? '…' : `${(t.profit??0)>=0?'+':''}${fmt2(t.profit??0)}`
                  return (
                    <div key={t.id} className="hist-row" style={{ animation:'fadeIn .18s ease' }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:'.72rem', fontWeight:700, color: t.source==='scanner' ? ACCENT : 'rgba(229,229,229,.85)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{short}</div>
                        <div style={{ fontSize:'.58rem', color:'rgba(229,229,229,.28)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{mkt}</div>
                      </div>
                      <div style={{ textAlign:'right', fontSize:'.7rem', color:'rgba(229,229,229,.5)', fontVariantNumeric:'tabular-nums' }}>{fmt2(t.stake)}</div>
                      <div style={{ textAlign:'center' }}>
                        {t.won===null ? <span style={{ color:'#FCA311', fontSize:'.62rem' }}>●</span> : t.won ? <span style={{ color:'#22c55e', fontSize:'.62rem' }}>✓</span> : <span style={{ color:'#ef4444', fontSize:'.62rem' }}>✗</span>}
                      </div>
                      <div style={{ textAlign:'right', fontSize:'.72rem', fontWeight:700, color:pnlClr, fontVariantNumeric:'tabular-nums' }}>{pnlTxt}</div>
                    </div>
                  )
                })}
              </div>
              {trades.length > 0 && (
                <div style={{ padding:'.45rem', borderTop:'1px solid rgba(255,255,255,.05)', flexShrink:0 }}>
                  <button onClick={() => setTrades([])} style={{ width:'100%', padding:'.32rem', borderRadius:6, cursor:'pointer', background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.07)', color:'rgba(229,229,229,.35)', fontSize:'.7rem' }}>
                    Clear history
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Scanner log */}
              <div style={{ flex:1, overflowY:'auto', padding:'.55rem .75rem', fontFamily:"'SF Mono','Fira Code','Consolas',monospace", fontSize:'.73rem', lineHeight:1.75, background:'#040b0a' }}>
                {logLines.length === 0
                  ? <p style={{ color:'rgba(229,229,229,.18)', margin:0 }}>{scannerActive ? 'Waiting for signals…' : 'Start the scanner to begin monitoring.'}</p>
                  : logLines.map(l => (
                      <div key={l.id} style={{ color: l.color==='green'?'#22c55e':l.color==='amber'?'#FCA311':l.color==='red'?'#ef4444':l.color==='cyan'?ACCENT:'rgba(229,229,229,.7)' }}>
                        <span style={{ color:'rgba(229,229,229,.15)', marginRight:'.4rem', fontSize:'.63rem' }}>{fmtTime(l.ts)}</span>{l.text}
                      </div>
                    ))
                }
              </div>
              <div style={{ padding:'.4rem .65rem', borderTop:`1px solid ${ACCENT}18`, display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
                <span style={{ fontSize:'.63rem', color:'rgba(229,229,229,.22)' }}>score ≥70 · barrier auto=5 · persist=3</span>
                <button onClick={() => setLogLines([])} style={{ background:'transparent', border:'none', color:'rgba(229,229,229,.25)', cursor:'pointer', fontSize:'.63rem' }}>Clear</button>
              </div>
            </>
          )}

        </div>{/* end RIGHT PANEL */}
      </div>
    </>
  )
}
