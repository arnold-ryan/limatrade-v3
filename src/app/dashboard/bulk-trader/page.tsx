'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

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
// Deeper shades than the usual Tailwind 500s — the brighter versions (yellow,
// cyan, green, teal especially) fail contrast against a white page background.
// These hold up on both a light and dark surface.
const DIGIT_COLORS = [
  '#dc2626','#c2410c','#a16207','#16a34a','#0d9488',
  '#3b82f6','#8b5cf6','#db2777','#0e7490','#FCA311',
]

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
function shannonEntropy(digits: number[]): number {
  if (!digits.length) return 0
  const freq = Array(10).fill(0)
  digits.forEach(d => freq[d]++)
  return freq.reduce((H: number, c: number) => {
    if (!c) return H
    const p = c / digits.length
    return H - p * Math.log2(p)
  }, 0)
}

interface ScanResult {
  signal: boolean
  score: number
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITDIFF' | null
  barrier: number | null
  reason: string
  detail: string
}
const NO_SIGNAL: ScanResult = { signal: false, score: 0, contractType: null, barrier: null, reason: '', detail: '' }

/**
 * PRIMARY over/under detection — DIGITUNDER 8 and DIGITOVER 1 only.
 * Natural win rate for both = 80%.  Fires at composite ≥ 40.
 * Uses higher scoring multipliers (×1200/×1000) because excess above 80% natural is small.
 */
function detectPrimary(digits: number[], persistCount: number): ScanResult {
  if (digits.length < 30) return NO_SIGNAL
  const d60 = digits.slice(-60)
  const d30 = digits.slice(-30)
  const entropy      = shannonEntropy(d60)
  const entropyBonus = Math.min(15, Math.max(0, Math.round((3.32 - entropy) / 3.32 * 30)))
  const persistBonus = Math.min(10, persistCount * 5)

  let bestScore = 39
  let best: ScanResult = NO_SIGNAL

  const candidates: Array<{ nat: number; obs60: number; obs30: number; ct: 'DIGITUNDER'|'DIGITOVER'; b: number; label: string }> = [
    { nat: 0.80, obs60: d60.filter(d => d < 8).length / d60.length, obs30: d30.filter(d => d < 8).length / d30.length, ct: 'DIGITUNDER', b: 8, label: 'Under 8' },
    { nat: 0.80, obs60: d60.filter(d => d > 1).length / d60.length, obs30: d30.filter(d => d > 1).length / d30.length, ct: 'DIGITOVER',  b: 1, label: 'Over 1'  },
  ]

  for (const c of candidates) {
    if (c.obs60 > c.nat + 0.015 && c.obs30 > c.nat + 0.005) {
      const base  = Math.min(50, (c.obs60 - c.nat) * 1200)
      const agree = Math.min(25, (c.obs30 - c.nat) * 1000)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: c.ct, barrier: c.b,
          reason: `${c.label} trending — ${Math.round(c.obs60*100)}% (60t) / ${Math.round(c.obs30*100)}% (30t) vs 80% natural`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }
  }
  return best
}

/**
 * RECOVERY over/under detection — DIGITOVER 3 and DIGITUNDER 6 only.
 * Natural win rate for both = 60%.  Fires only at composite ≥ 80 (high confidence).
 * Activated only after a scanner trade settles as a loss.
 */
function detectRecovery(digits: number[], persistCount: number): ScanResult {
  if (digits.length < 30) return NO_SIGNAL
  const d60 = digits.slice(-60)
  const d30 = digits.slice(-30)
  const entropy      = shannonEntropy(d60)
  const entropyBonus = Math.min(15, Math.max(0, Math.round((3.32 - entropy) / 3.32 * 30)))
  const persistBonus = Math.min(10, persistCount * 5)

  let bestScore = 79   // must beat 80
  let best: ScanResult = NO_SIGNAL

  const candidates: Array<{ nat: number; obs60: number; obs30: number; ct: 'DIGITUNDER'|'DIGITOVER'; b: number; label: string }> = [
    { nat: 0.60, obs60: d60.filter(d => d > 3).length / d60.length, obs30: d30.filter(d => d > 3).length / d30.length, ct: 'DIGITOVER',  b: 3, label: 'Over 3'  },
    { nat: 0.60, obs60: d60.filter(d => d < 6).length / d60.length, obs30: d30.filter(d => d < 6).length / d30.length, ct: 'DIGITUNDER', b: 6, label: 'Under 6' },
  ]

  for (const c of candidates) {
    if (c.obs60 > c.nat + 0.05 && c.obs30 > c.nat + 0.02) {
      const base  = Math.min(50, (c.obs60 - c.nat) * 600)
      const agree = Math.min(25, (c.obs30 - c.nat) * 500)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: c.ct, barrier: c.b,
          reason: `[RECOVERY] ${c.label} — ${Math.round(c.obs60*100)}% (60t) / ${Math.round(c.obs30*100)}% (30t) vs 60% natural`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }
  }
  return best
}

/**
 * Even/Odd and Matches/Differs detection (unchanged from v196).
 */
function detectSignal(
  digits: number[],
  tradeType: 'even_odd' | 'matches_differs',
  persistCount: number,
): ScanResult {
  if (digits.length < 30) return NO_SIGNAL
  const d60 = digits.slice(-60)
  const d30 = digits.slice(-30)
  const entropy      = shannonEntropy(d60)
  const entropyBonus = Math.min(15, Math.max(0, Math.round((3.32 - entropy) / 3.32 * 30)))
  const persistBonus = Math.min(10, persistCount * 5)

  if (tradeType === 'even_odd') {
    const even60 = d60.filter(d => d % 2 === 0).length / d60.length
    const even30 = d30.filter(d => d % 2 === 0).length / d30.length
    const dominant = even60 >= 0.5 ? 'even' : 'odd'
    const domPct60 = dominant === 'even' ? even60 : 1 - even60
    const domPct30 = dominant === 'even' ? even30 : 1 - even30
    if (domPct60 < 0.52 || domPct30 <= 0.5) return NO_SIGNAL
    const base  = Math.min(50, (domPct60 - 0.5) * 600)
    const agree = Math.min(25, (domPct30 - 0.5) * 500)
    const score = Math.min(100, base + agree + entropyBonus + persistBonus)
    if (score < 55) return NO_SIGNAL
    const betType: 'DIGITEVEN' | 'DIGITODD' = dominant === 'even' ? 'DIGITEVEN' : 'DIGITODD'
    return {
      signal: true, score: Math.round(score), contractType: betType, barrier: null,
      reason: `${dominant === 'even' ? 'Even' : 'Odd'} trending — ${Math.round(domPct60*100)}% (60t) / ${Math.round(domPct30*100)}% (30t) vs 50% natural`,
      detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
    }
  }

  /* matches_differs — COLD digit strategy:
     Pick the digit appearing LEAST in recent history.
     DIFFERS wins when last digit ≠ barrier, so a cold digit (rarely appears) = high win rate.
     e.g. digit at 2% observed → DIFFERS wins ~98% vs 90% natural.
     Betting DIFFERS on a HOT digit is wrong (reduces win rate below natural). */
  let bestScore = 59   // threshold 60 — fires when deficit is meaningful
  let best: ScanResult = NO_SIGNAL
  for (let d = 0; d <= 9; d++) {
    const nat   = 0.10
    const o60   = d60.filter(x => x === d).length / d60.length
    const o30   = d30.filter(x => x === d).length / d30.length
    const def60 = nat - o60   // how cold the digit is (positive = below natural)
    const def30 = nat - o30
    // Only fire when digit is genuinely cold in both windows
    if (def60 > 0.03 && def30 > 0.01) {
      const base  = Math.min(50, def60 * 600)   // bigger deficit = higher score
      const agree = Math.min(25, def30 * 500)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: 'DIGITDIFF', barrier: d,
          reason: `Digit ${d} cold — ${Math.round(o60*100)}% (60t) / ${Math.round(o30*100)}% (30t) vs 10% natural → Differs ${d} (win rate ~${Math.round((1-o60)*100)}%)`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }
  }
  return best
}

interface TradeRow {
  id: number; ts: number; contractType: string; symbol: string
  stake: number; payout: number; won: boolean | null; profit: number | null
  source: 'manual' | 'scanner' | 'recovery'
  /** True when the proposal/buy request itself was rejected by Deriv — no money was won or lost. */
  failed?: boolean
}
interface LogLine { id: number; text: string; color: 'green'|'amber'|'red'|'cyan'|'white'|'purple'; ts: number }

function DigitGauge({ digit, count, total, liveDigit }: {
  digit: number; count: number; total: number; liveDigit: number | null
}) {
  const pct  = total > 0 ? (count / total) * 100 : 0
  const r    = 17, circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const live = liveDigit === digit
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
      <svg width="42" height="42" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--bg2)" strokeWidth="3.5"/>
        <circle cx="21" cy="21" r={r} fill="none" stroke={live ? 'var(--txt0)' : DIGIT_COLORS[digit]}
          strokeWidth={live ? 5 : 3.5}
          strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition:'stroke-dasharray .3s', filter:live?`drop-shadow(0 0 5px ${DIGIT_COLORS[digit]})`:'none' }}/>
        <text x="21" y="25" textAnchor="middle" fontSize="11" fontWeight="800"
          fill={live ? 'var(--txt0)' : DIGIT_COLORS[digit]}>{digit}</text>
      </svg>
      <span style={{ fontSize:'.6rem', color:'var(--txt1)' }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

export default function BulkTraderPage() {
  const [symbol,    setSymbol]    = useState('1HZ100V')
  const [tradeType, setTradeType] = useState<'even_odd'|'over_under'|'matches_differs'>('even_odd')
  const [digit,     setDigit]     = useState(5)
  const [stake,     setStake]     = useState('1.00')
  const [bulkCount, setBulkCount] = useState('3')
  const [ticks,     setTicks]     = useState(60)
  const [scanMode,  setScanMode]  = useState<'once'|'continuous'>('continuous')
  const scanModeRef = useRef<'once'|'continuous'>('continuous')

  const [livePrice,    setLivePrice]    = useState<number|null>(null)
  const [recentDigits, setRecentDigits] = useState<number[]>([])
  const [digitCounts,  setDigitCounts]  = useState<number[]>(Array(10).fill(0))
  const pipSizeRef = useRef(2)

  const [isTrading,  setIsTrading]  = useState(false)
  const [tradeError, setTradeError] = useState<string|null>(null)
  const [currency,   setCurrency]   = useState('USD')
  const reqIdRef         = useRef(0)
  const intentionalClose = useRef(false)

  const [trades, setTrades] = useState<TradeRow[]>([])
  const tradeIdRef = useRef(0)

  const [scannerActive, setScannerActive] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<'idle'|'scanning'|'fired'|'recovery'>('idle')
  const [recoveryActive, setRecoveryActive] = useState(false)
  const [logLines,       setLogLines]       = useState<LogLine[]>([])
  const logIdRef        = useRef(0)
  const logEndRef       = useRef<HTMLDivElement>(null)

  /* scanner WS refs */
  const scannerWsRefs = useRef<Map<string,WebSocket>>(new Map())
  const scannerDigits = useRef<Map<string,number[]>>(new Map())

  /* primary strategy refs (UNDER 8 / OVER 1) */
  const primaryCooldowns = useRef<Map<string,number>>(new Map())
  const primaryPersists  = useRef<Map<string,number>>(new Map())

  /* recovery strategy refs (OVER 3 / UNDER 6) — activates after first loss */
  const recoveryMode      = useRef(false)
  const recoveryCooldowns = useRef<Map<string,number>>(new Map())
  const recoveryPersists  = useRef<Map<string,number>>(new Map())

  /* general cooldowns for even_odd / matches_differs */
  const generalCooldowns = useRef<Map<string,number>>(new Map())
  const generalPersists  = useRef<Map<string,number>>(new Map())

  const scannerBotWsRef  = useRef<WebSocket|null>(null)
  const stopScannerRef   = useRef<(() => void) | null>(null)
  const scanPendingCount = useRef(0)  // tracks unresolved scanner trades for One Shot cleanup
  const scanTradeTypeRef = useRef<'even_odd'|'over_under'|'matches_differs'>('even_odd')
  const scanStakeRef     = useRef('1.00')
  const scanCountRef     = useRef(3)
  const scanCurrencyRef  = useRef('USD')

  useEffect(() => {
    const counts = Array(10).fill(0)
    recentDigits.slice(-ticks).forEach(d => counts[d]++)
    setDigitCounts(counts)
  }, [recentDigits, ticks])

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior:'smooth' }) }, [logLines])

  const settled  = trades.filter(t => t.won !== null)
  const wins     = settled.filter(t => t.won)
  const totalPnl = settled.reduce((s, t) => s + (t.profit ?? 0), 0)
  const winRate  = settled.length > 0 ? (wins.length / settled.length) * 100 : 0

  useEffect(() => {
    let alive = true
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (!alive) return
      ws = new WebSocket(PUBLIC_WS_URL)
      ws.onopen = () => ws!.send(JSON.stringify({ ticks_history:symbol, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
      ws.onmessage = (ev) => {
        let msg: Record<string,unknown>; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.msg_type === 'history') {
          const h = msg as {pip_size?:number;history?:{prices:number[]}}
          if (h.pip_size != null) pipSizeRef.current = h.pip_size
          const prices: number[] = h.history?.prices ?? []
          setRecentDigits(prices.map(p => lastDigit(Number(p), pipSizeRef.current)).slice(-100))
          setLivePrice(prices.at(-1) ?? null)
        }
        if (msg.msg_type === 'tick') {
          const t = msg as {tick?:{pip_size?:number;quote?:number}}
          if (t.tick?.pip_size != null) pipSizeRef.current = t.tick.pip_size
          const q = t.tick?.quote
          if (q != null) { setLivePrice(q); setRecentDigits(prev => [...prev.slice(-99), lastDigit(Number(q), pipSizeRef.current)]) }
        }
      }
      ws.onerror = () => {}
      ws.onclose = () => { if (alive) reconnectTimer = setTimeout(connect, 3000) }
    }
    connect()

    return () => {
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.send(JSON.stringify({ forget_all:'ticks', req_id:9999 })) } catch { /**/ }
      ws?.close(); setLivePrice(null); setRecentDigits([])
    }
  }, [symbol])

  const log = useCallback((text: string, color: LogLine['color'] = 'white') => {
    setLogLines(prev => [...prev.slice(-500), { id:++logIdRef.current, text, color, ts:Date.now() }])
  }, [])

  const addTrade = useCallback((contractType: string, sym: string, stakeVal: number, source: TradeRow['source']): number => {
    const id = ++tradeIdRef.current
    setTrades(prev => [{ id, ts:Date.now(), contractType, symbol:sym, stake:stakeVal, payout:0, won:null, profit:null, source }, ...prev.slice(0,199)])
    return id
  }, [])

  const settleTrade = useCallback((rowId: number, payout: number, stakeVal: number) => {
    const profit = payout - stakeVal
    setTrades(prev => prev.map(t => t.id === rowId ? { ...t, payout, profit, won:profit>0 } : t))
  }, [])

  /** A proposal or buy request was rejected by Deriv — no stake was ever placed. */
  const failTrade = useCallback((rowId: number) => {
    setTrades(prev => prev.map(t => t.id === rowId ? { ...t, failed:true } : t))
  }, [])

  /**
   * Requests a proposal for a contract instead of buying directly with a flat price
   * cap. The actual buy is sent once the proposal response arrives (see the `proposal`
   * message handling in each onmessage handler below), using Deriv's real ask_price —
   * this is what makes the trade's slippage cap meaningful instead of a fixed $1000
   * ceiling that silently rejects any trade whose ask_price exceeds it.
   *
   * subscribe:0 (one-shot) is rejected outright by this API with
   * "Input validation failed: subscribe" — it only accepts subscribe:1. So we
   * subscribe, use the first response to buy, then `forget` the subscription
   * immediately (see the proposal handler) so it doesn't keep streaming.
   */
  const requestProposal = useCallback((
    ws: WebSocket, contractType: string, barrierVal: number|null,
    stakeVal: number, sym: string, cur: string, rowId: number,
    proposalPending: Map<number,{rowId:number;stake:number}>,
  ) => {
    const propReqId = ++reqIdRef.current
    proposalPending.set(propReqId, { rowId, stake:stakeVal })
    ws.send(JSON.stringify({
      proposal:1, subscribe:1, req_id:propReqId,
      contract_type:contractType, underlying_symbol:sym,
      duration:5, duration_unit:'t', amount:stakeVal, basis:'stake', currency:cur,
      ...(barrierVal !== null ? { barrier:String(barrierVal) } : {}),
    }))
  }, [])

  const connectBotWs = useCallback(async (): Promise<WebSocket|null> => {
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
          const acc = (accounts as Array<{accountId:string;currency:string}>)?.find(a => a.accountId === activeAccountId) ?? accounts?.[0]
          if (acc?.currency) setCurrency(acc.currency)
        }
      } catch { /**/ }
      return ws
    } catch { return null }
  }, [])

  const fireTrades = useCallback((
    ws: WebSocket, contractType: string, barrierVal: number|null,
    stakeVal: number, count: number, sym: string, cur: string,
    source: TradeRow['source'],
    proposalPending: Map<number,{rowId:number;stake:number}>,
  ) => {
    for (let i = 0; i < count; i++) {
      const rowId = addTrade(contractType, sym, stakeVal, source)
      requestProposal(ws, contractType, barrierVal, stakeVal, sym, cur, rowId, proposalPending)
    }
  }, [addTrade, requestProposal])

  const handleManualTrade = useCallback(async (contractType: string) => {
    if (isTrading) return
    setIsTrading(true); setTradeError(null)
    const stakeVal = parseFloat(stake) || 1
    const n        = parseInt(bulkCount) || 1
    const ws = await connectBotWs()
    if (!ws) { setTradeError('Connection failed'); setIsTrading(false); return }
    intentionalClose.current = false
    const proposalPending = new Map<number,{rowId:number;stake:number}>()
    const pending  = new Map<number,{rowId:number;stake:number}>()
    const reqToRow = new Map<number,number>()
    const cidToStake = new Map<number,number>()
    let doneCount = 0
    const finishOne = () => { doneCount++; if (doneCount >= n) { intentionalClose.current = true; ws.close(); setIsTrading(false) } }
    ws.onmessage = (ev) => {
      let msg: Record<string,unknown>; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:(msg.balance as Record<string,unknown>)?.balance, currency:(msg.balance as Record<string,unknown>)?.currency } }))
      if (msg.msg_type === 'proposal') {
        const pr = proposalPending.get(msg.req_id as number)
        proposalPending.delete(msg.req_id as number)
        if (pr) {
          if (msg.error) {
            failTrade(pr.rowId)
            finishOne()
          } else {
            const prop = msg.proposal as Record<string,unknown>
            const buyReqId = ++reqIdRef.current
            pending.set(buyReqId, { rowId:pr.rowId, stake:pr.stake })
            ws.send(JSON.stringify({ buy: prop.id, price: +(Number(prop.ask_price) * 1.02).toFixed(2), req_id: buyReqId }))
            // We subscribed (subscribe:0 is rejected by this API) just to get one
            // price — cancel the stream now so it doesn't keep pushing updates.
            const subId = (msg.subscription as Record<string,unknown>)?.id
            if (subId) ws.send(JSON.stringify({ forget: subId, req_id: ++reqIdRef.current }))
          }
        }
      }
      if (msg.msg_type === 'buy') {
        const ri = pending.get(msg.req_id as number)
        if (ri) {
          if (msg.error) { failTrade(ri.rowId); finishOne() }
          else if ((msg.buy as Record<string,unknown>)?.contract_id) {
            const cid = (msg.buy as Record<string,unknown>).contract_id as number
            reqToRow.set(cid, ri.rowId)
            cidToStake.set(cid, ri.stake)
          }
        }
      }
      if (msg.msg_type === 'transaction' && (msg.transaction as Record<string,unknown>)?.action === 'sell') {
        const tx  = msg.transaction as Record<string,unknown>
        const cid = tx.contract_id as number
        const payout = Math.abs(tx.amount as number ?? 0)
        const rowId = reqToRow.get(cid)
        const stk = cidToStake.get(cid) ?? stakeVal
        if (rowId != null) settleTrade(rowId, payout, stk)
        finishOne()
      }
      if (msg.error && msg.msg_type !== 'proposal' && msg.msg_type !== 'buy') {
        setTradeError((msg.error as Record<string,unknown>)?.message as string ?? 'Trade error'); intentionalClose.current = true; ws.close(); setIsTrading(false)
      }
    }
    ws.onclose = () => { if (!intentionalClose.current) setIsTrading(false) }
    ws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))
    fireTrades(ws, contractType, (tradeType === 'over_under' || tradeType === 'matches_differs') ? digit : null, stakeVal, n, symbol, currency, 'manual', proposalPending)
  }, [isTrading, stake, bulkCount, tradeType, digit, symbol, currency, connectBotWs, fireTrades, settleTrade, failTrade])

  const startScanner = useCallback(async () => {
    setScannerActive(true); setScannerStatus('scanning'); setLogLines([])
    recoveryMode.current = false; setRecoveryActive(false)
    scanPendingCount.current = 0
    scanTradeTypeRef.current = tradeType
    scanStakeRef.current     = stake
    scanCountRef.current     = parseInt(bulkCount) || 1
    scanCurrencyRef.current  = currency
    scanModeRef.current      = scanMode

    const isOU = tradeType === 'over_under'
    log('━━━ AI BULK SCANNER V2 ━━━', 'cyan')
    if (isOU) {
      log('Mode: Over/Under — PRIMARY: Under 8 + Over 1 (80% natural)', 'white')
      log('RECOVERY: Over 3 + Under 6 activates after first loss (score≥80)', 'amber')
    } else {
      log(`Mode: ${tradeType === 'even_odd' ? 'Even / Odd' : 'Matches / Differs (DIGITDIFF, auto-digit)'}`, 'white')
    }
    log(`Markets: ${SCAN_SYMBOLS.join('  ·  ')}`, 'white')

    const bws = await connectBotWs()
    if (!bws) { log('ERROR: trading WS failed', 'red'); setScannerActive(false); setScannerStatus('idle'); return }
    scannerBotWsRef.current = bws
    const scanProposalPending = new Map<number,{rowId:number;stake:number}>()
    const scanRowSource = new Map<number,TradeRow['source']>()
    const scanPending  = new Map<number,{rowId:number;stake:number;source:TradeRow['source']}>()
    const scanReqToRow = new Map<number,number>()
    const scanCidToStake = new Map<number,number>()
    const scanCidToSource = new Map<number,TradeRow['source']>()

    const scanFinishOne = () => {
      scanPendingCount.current = Math.max(0, scanPendingCount.current - 1)
      if (scanPendingCount.current === 0 && scanModeRef.current === 'once' && scannerBotWsRef.current) {
        try { scannerBotWsRef.current.close() } catch { /**/ }
        scannerBotWsRef.current = null
      }
    }

    bws.onmessage = (ev) => {
      let msg: Record<string,unknown>; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:(msg.balance as Record<string,unknown>)?.balance, currency:(msg.balance as Record<string,unknown>)?.currency } }))
      if (msg.msg_type === 'proposal') {
        const pr = scanProposalPending.get(msg.req_id as number)
        scanProposalPending.delete(msg.req_id as number)
        if (pr) {
          if (msg.error) {
            log(`  ✗ Proposal rejected: ${(msg.error as Record<string,unknown>)?.message}`, 'red')
            failTrade(pr.rowId)
            scanFinishOne()
          } else {
            const prop = msg.proposal as Record<string,unknown>
            const buyReqId = ++reqIdRef.current
            scanPending.set(buyReqId, { rowId:pr.rowId, stake:pr.stake, source: scanRowSource.get(pr.rowId) ?? 'scanner' })
            bws.send(JSON.stringify({ buy: prop.id, price: +(Number(prop.ask_price) * 1.02).toFixed(2), req_id: buyReqId }))
            const subId = (msg.subscription as Record<string,unknown>)?.id
            if (subId) bws.send(JSON.stringify({ forget: subId, req_id: ++reqIdRef.current }))
          }
        }
      }
      if (msg.msg_type === 'buy') {
        const ri = scanPending.get(msg.req_id as number)
        if (ri) {
          if (msg.error) {
            log(`  ✗ Buy rejected: ${(msg.error as Record<string,unknown>)?.message}`, 'red')
            failTrade(ri.rowId)
            scanFinishOne()
          } else if ((msg.buy as Record<string,unknown>)?.contract_id) {
            const cid = (msg.buy as Record<string,unknown>).contract_id as number
            scanReqToRow.set(cid, ri.rowId)
            scanCidToStake.set(cid, ri.stake)
            scanCidToSource.set(cid, ri.source)
            log(`  ✓ Contract #${cid} placed`, 'green')
          }
        }
      }
      if (msg.msg_type === 'transaction' && (msg.transaction as Record<string,unknown>)?.action === 'sell') {
        const tx     = msg.transaction as Record<string,unknown>
        const cid    = tx.contract_id as number
        const payout = Math.abs(tx.amount as number ?? 0)
        const rowId  = scanReqToRow.get(cid)
        const stk    = scanCidToStake.get(cid) ?? (parseFloat(scanStakeRef.current) || 1)
        const src    = scanCidToSource.get(cid) ?? 'scanner'
        if (rowId != null) {
          settleTrade(rowId, payout, stk)
          const won = payout > stk
          const tag = src === 'recovery' ? '[RECOVERY] ' : ''
          log(`  ${won ? '\u2713 WIN' : '\u2717 LOSS'} ${tag}${won?'+':''}${fmt2(payout-stk)} ${scanCurrencyRef.current}`, won ? 'green' : 'red')
          if (!won && !recoveryMode.current && scanTradeTypeRef.current === 'over_under') {
            recoveryMode.current = true
            setRecoveryActive(true)
            log('\u2501\u2501 RECOVERY MODE ACTIVATED \u2501\u2501', 'amber')
            log('  Now scanning Over 3 / Under 6 alongside primary (score\u226580)', 'amber')
          }
          scanFinishOne()
        }
      }
      if (msg.error && msg.msg_type !== 'proposal' && msg.msg_type !== 'buy') {
        log(`  ERROR: ${(msg.error as Record<string,unknown>)?.message}`, 'red')
      }
    }
    bws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))

    SCAN_SYMBOLS.forEach(sym => {
      scannerDigits.current.set(sym, [])
      primaryPersists.current.set(sym, 0)
      recoveryPersists.current.set(sym, 0)
      generalPersists.current.set(sym, 0)
      let localPipSize = 2, tickCount = 0

      const ws = new WebSocket(PUBLIC_WS_URL)
      scannerWsRefs.current.set(sym, ws)
      ws.onopen = () => ws.send(JSON.stringify({ ticks_history:sym, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
      ws.onmessage = (ev) => {
        let msg: Record<string,unknown>; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.msg_type === 'history') {
          const h = msg as {pip_size?:number;history?:{prices:number[]}}
          if (h.pip_size != null) localPipSize = h.pip_size
          scannerDigits.current.set(sym, (h.history?.prices ?? []).map((p:number) => lastDigit(Number(p), localPipSize)))
        }
        if (msg.msg_type === 'tick') {
          const t = msg as {tick?:{pip_size?:number;quote?:number}}
          if (t.tick?.pip_size != null) localPipSize = t.tick.pip_size
          const q = t.tick?.quote; if (q == null) return
          const digits = scannerDigits.current.get(sym) ?? []
          digits.push(lastDigit(Number(q), localPipSize))
          if (digits.length > 300) digits.shift()
          scannerDigits.current.set(sym, digits)
          tickCount++
          if (tickCount % 3 !== 0) return

          const tt = scanTradeTypeRef.current

          /* ── Over/Under: dual strategy ── */
          if (tt === 'over_under') {
            /* PRIMARY: UNDER 8 / OVER 1 */
            const pCool = primaryCooldowns.current.get(sym) ?? 0
            if (Date.now() - pCool >= 20_000) {
              const pPersist = primaryPersists.current.get(sym) ?? 0
              const pResult  = detectPrimary(digits, pPersist)
              if (pResult.signal && pResult.contractType) {
                primaryPersists.current.set(sym, pPersist + 1)
                if (pPersist >= 1) {
                  const mkt  = MARKETS.find(m => m.symbol === sym)?.label ?? sym
                  const dir  = pResult.contractType.replace('DIGIT','')
                  log(`━━ ${mkt} [PRIMARY] ━━`, 'cyan')
                  log(`  ${pResult.reason}`, 'white')
                  log(`  Score: ${pResult.score}/100  [${pResult.detail}]`, 'white')
                  log(`  → ${scanCountRef.current}× ${dir} ${pResult.barrier} @ ${scanStakeRef.current} ${scanCurrencyRef.current}`, 'green')
                  primaryCooldowns.current.set(sym, Date.now())
                  primaryPersists.current.set(sym, 0)
                  setScannerStatus('fired'); setTimeout(() => setScannerStatus('scanning'), 3000)
                  if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
                    const n = scanCountRef.current
                    const stakeVal = parseFloat(scanStakeRef.current) || 1
                    scanPendingCount.current += n
                    for (let i = 0; i < n; i++) {
                      const rowId = addTrade(pResult.contractType, sym, stakeVal, 'scanner')
                      scanRowSource.set(rowId, 'scanner')
                      requestProposal(scannerBotWsRef.current, pResult.contractType, pResult.barrier, stakeVal, sym, scanCurrencyRef.current, rowId, scanProposalPending)
                    }
                    // One Shot: stop feeds now; bot WS stays open until all trades settle
                    if (scanModeRef.current === 'once') stopScannerRef.current?.()
                  }
                } else {
                  log(`  ${sym} primary building (${pPersist+1}/2, score=${pResult.score})`, 'white')
                }
              } else {
                if (pPersist > 0) primaryPersists.current.set(sym, 0)
              }
            }

            /* RECOVERY: OVER 3 / UNDER 6 (only after a loss) */
            if (recoveryMode.current) {
              const rCool = recoveryCooldowns.current.get(sym) ?? 0
              if (Date.now() - rCool >= 25_000) {
                const rPersist = recoveryPersists.current.get(sym) ?? 0
                const rResult  = detectRecovery(digits, rPersist)
                if (rResult.signal && rResult.contractType) {
                  recoveryPersists.current.set(sym, rPersist + 1)
                  if (rPersist >= 1) {
                    const mkt = MARKETS.find(m => m.symbol === sym)?.label ?? sym
                    const dir = rResult.contractType.replace('DIGIT','')
                    log(`━━ ${mkt} [RECOVERY] ━━`, 'purple')
                    log(`  ${rResult.reason}`, 'amber')
                    log(`  Score: ${rResult.score}/100  [${rResult.detail}]`, 'white')
                    log(`  → ${scanCountRef.current}× ${dir} ${rResult.barrier} @ ${scanStakeRef.current} ${scanCurrencyRef.current}`, 'green')
                    recoveryCooldowns.current.set(sym, Date.now())
                    recoveryPersists.current.set(sym, 0)
                    setScannerStatus('recovery'); setTimeout(() => setScannerStatus('scanning'), 3000)
                    if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
                      const n = scanCountRef.current
                      const stakeVal = parseFloat(scanStakeRef.current) || 1
                      scanPendingCount.current += n
                      for (let i = 0; i < n; i++) {
                        const rowId = addTrade(rResult.contractType, sym, stakeVal, 'recovery')
                        scanRowSource.set(rowId, 'recovery')
                        requestProposal(scannerBotWsRef.current, rResult.contractType, rResult.barrier, stakeVal, sym, scanCurrencyRef.current, rowId, scanProposalPending)
                      }
                      if (scanModeRef.current === 'once') stopScannerRef.current?.()
                    }
                  } else {
                    log(`  ${sym} recovery building (${rPersist+1}/2, score=${rResult.score})`, 'amber')
                  }
                } else {
                  if (rPersist > 0) recoveryPersists.current.set(sym, 0)
                }
              }
            }
            return
          }

          /* ── Even/Odd and Matches/Differs ── */
          const gCool = generalCooldowns.current.get(sym) ?? 0
          if (Date.now() - gCool < 20_000) return
          const gPersist = generalPersists.current.get(sym) ?? 0
          const result   = detectSignal(digits, tt as 'even_odd'|'matches_differs', gPersist)
          if (result.signal && result.contractType) {
            generalPersists.current.set(sym, gPersist + 1)
            if (gPersist >= 1) {
              const mkt  = MARKETS.find(m => m.symbol === sym)?.label ?? sym
              const dir  = result.contractType.replace('DIGIT','')
              const bStr = result.barrier !== null ? ` ${result.barrier}` : ''
              log(`━━ ${mkt} ━━`, 'cyan')
              log(`  ${result.reason}`, 'amber')
              log(`  Score: ${result.score}/100  [${result.detail}]`, 'white')
              log(`  → ${scanCountRef.current}× ${dir}${bStr} @ ${scanStakeRef.current} ${scanCurrencyRef.current}`, 'green')
              generalCooldowns.current.set(sym, Date.now())
              generalPersists.current.set(sym, 0)
              setScannerStatus('fired'); setTimeout(() => setScannerStatus('scanning'), 3000)
              if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
                const n = scanCountRef.current
                const stakeVal = parseFloat(scanStakeRef.current) || 1
                scanPendingCount.current += n
                for (let i = 0; i < n; i++) {
                  const rowId = addTrade(result.contractType, sym, stakeVal, 'scanner')
                  scanRowSource.set(rowId, 'scanner')
                  requestProposal(scannerBotWsRef.current, result.contractType, result.barrier, stakeVal, sym, scanCurrencyRef.current, rowId, scanProposalPending)
                }
                if (scanModeRef.current === 'once') stopScannerRef.current?.()
              }
            } else {
              log(`  ${sym} pattern building (${gPersist+1}/2, score=${result.score})`, 'white')
            }
          } else {
            if (gPersist > 0) generalPersists.current.set(sym, 0)
          }
        }
      }
      ws.onerror = () => log(`WS error: ${sym}`, 'red')
    })
  }, [tradeType, stake, bulkCount, currency, scanMode, connectBotWs, addTrade, settleTrade, log, requestProposal, failTrade])

  const stopScanner = useCallback((keepBotWs = false) => {
    setScannerActive(false); setScannerStatus('idle'); setRecoveryActive(false)
    recoveryMode.current = false
    log('━━━ SCANNER STOPPED ━━━', 'amber')
    scannerWsRefs.current.forEach(ws => { try { ws.close() } catch { /**/ } })
    scannerWsRefs.current.clear(); scannerDigits.current.clear()
    primaryCooldowns.current.clear(); primaryPersists.current.clear()
    recoveryCooldowns.current.clear(); recoveryPersists.current.clear()
    generalCooldowns.current.clear(); generalPersists.current.clear()
    // keepBotWs=true (One Shot): bot WS stays open to receive settle events; closed by settle handler
    if (!keepBotWs) {
      if (scannerBotWsRef.current) { try { scannerBotWsRef.current.close() } catch { /**/ } }
      scannerBotWsRef.current = null
    }
  }, [log])

  // wire ref so startScanner can call stopScanner without a forward-declaration error
  // One Shot path calls stopScanner(true) to keep bot WS alive for settlement
  stopScannerRef.current = () => stopScanner(scanModeRef.current === 'once')

  useEffect(() => () => { stopScanner() }, [stopScanner])

  const liveDigit  = livePrice != null ? lastDigit(livePrice, pipSizeRef.current) : null
  const totalTicks = recentDigits.slice(-ticks).length

  return (
    <>
      <style>{`
        .bt-card{background:var(--bg2);border:1px solid var(--bdr);border-radius:10px;padding:.72rem .82rem}
        .bt-lbl{font-size:.6rem;font-weight:700;letter-spacing:.08em;color:var(--txt1);text-transform:uppercase;margin-bottom:.32rem}
        .bt-sel{width:100%;background:var(--bg2);border:1px solid var(--bdr);border-radius:7px;color:var(--txt0);padding:.4rem .58rem;font-size:.78rem;outline:none;cursor:pointer}
        .bt-inp{background:var(--bg2);border:1px solid var(--bdr);border-radius:7px;color:var(--txt0);padding:.4rem .58rem;font-size:.84rem;outline:none;box-sizing:border-box;width:100%}
        .bt-inp:focus{border-color:#00e5cc}
        .bt-btn{border:none;border-radius:8px;font-weight:800;cursor:pointer;transition:opacity .15s}
        .bt-btn:disabled{opacity:.4;cursor:not-allowed}
        .tt-chip{padding:.36rem 0;border-radius:7px;font-size:.72rem;font-weight:700;cursor:pointer;border:1px solid transparent;transition:all .15s;text-align:center;flex:1}
        .tw-chip{padding:.3rem 0;border-radius:6px;font-size:.72rem;font-weight:700;cursor:pointer;border:1px solid transparent;transition:all .15s;flex:1;text-align:center}
        .dot-cell{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;font-size:.64rem;font-weight:800;flex-shrink:0}
        .hr-row{display:grid;grid-template-columns:1fr 52px 28px 52px;gap:2px;align-items:center;padding:.26rem .38rem;border-radius:5px;font-size:.68rem}
        .hr-row:hover{background:var(--bg2)}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
        @keyframes scanPulse{0%,100%{opacity:1}50%{opacity:.2}}
        @keyframes recoveryGlow{0%,100%{box-shadow:0 0 0 rgba(252,163,17,0)}50%{box-shadow:0 0 12px rgba(252,163,17,.3)}}
      `}</style>

      <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

        {/* LEFT: Scanner */}
        <div style={{ width:250, flexShrink:0, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', background:'var(--bg1)', animation:recoveryActive?'recoveryGlow 2s ease infinite':undefined }}>
          <div style={{ padding:'.58rem .72rem', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'.35rem' }}>
              <span style={{ fontSize:'.8rem', fontWeight:800, color:'var(--txt0)' }}>AI Scanner V2</span>
              <span style={{
                padding:'.18rem .5rem', borderRadius:20, fontSize:'.61rem', fontWeight:700,
                background:scannerStatus==='idle'?'var(--bg2)':scannerStatus==='recovery'?'rgba(252,163,17,.15)':scannerStatus==='scanning'?'#00e5cc18':'rgba(34,197,94,.15)',
                color:scannerStatus==='idle'?'var(--txt2)':scannerStatus==='recovery'?'#FCA311':scannerStatus==='scanning'?'#00e5cc':'#22c55e',
                border:`1px solid ${scannerStatus==='idle'?'var(--bdr)':scannerStatus==='recovery'?'rgba(252,163,17,.3)':scannerStatus==='scanning'?'#00e5cc44':'rgba(34,197,94,.3)'}`,
              }}>
                {scannerActive && <span style={{ width:5,height:5,borderRadius:'50%',background:scannerStatus==='recovery'?'#FCA311':'#22c55e',display:'inline-block',marginRight:4,animation:'scanPulse 1.2s ease infinite' }}/>}
                {scannerStatus==='idle'?'IDLE':scannerStatus==='scanning'?'SCANNING':scannerStatus==='recovery'?'RECOVERY':'FIRED'}
              </span>
            </div>
            {recoveryActive && (
              <div style={{ background:'rgba(252,163,17,.08)', border:'1px solid rgba(252,163,17,.25)', borderRadius:6, padding:'.28rem .5rem', marginBottom:'.35rem', fontSize:'.63rem', color:'#FCA311', fontWeight:700 }}>
                ⚡ Recovery: Over 3 / Under 6 active
              </div>
            )}
            <button className="bt-btn" onClick={scannerActive?()=>stopScanner():startScanner}
              style={{ width:'100%', padding:'.38rem', fontSize:'.77rem', background:scannerActive?'rgba(239,68,68,.12)':'#00e5cc18', color:scannerActive?'#ef4444':'#00e5cc', border:`1px solid ${scannerActive?'rgba(239,68,68,.3)':'#00e5cc44'}` }}>
              {scannerActive?'■  Stop Scanner':'▶  Start Scanner'}
            </button>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, padding:'.45rem .55rem', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
            {([
              { label:'P&L', value:`${totalPnl>=0?'+':''}${fmt2(totalPnl)}`, color:totalPnl>0?'#22c55e':totalPnl<0?'#ef4444':'var(--txt1)' },
              { label:'Win Rate', value:settled.length>0?`${winRate.toFixed(0)}%`:'--', color:winRate>=50?'#22c55e':winRate>0?'#ef4444':'var(--txt1)' },
              { label:'Settled', value:String(settled.length), color:'var(--txt0)' },
              { label:'Pending', value:String(trades.filter(t=>t.won===null && !t.failed).length), color:'#FCA311' },
            ] as const).map(s => (
              <div key={s.label} style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:6, padding:'.28rem .38rem' }}>
                <div style={{ fontSize:'.54rem', color:'var(--txt2)', textTransform:'uppercase', letterSpacing:'.05em' }}>{s.label}</div>
                <div style={{ fontSize:'.8rem', fontWeight:800, color:s.color, fontVariantNumeric:'tabular-nums' }}>{s.value}</div>
              </div>
            ))}
          </div>

          {tradeType === 'over_under' && scannerActive && (
            <div style={{ padding:'.38rem .58rem', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
              <div style={{ fontSize:'.58rem', color:'var(--txt1)', marginBottom:3, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' }}>Strategy</div>
              <div style={{ display:'flex', gap:4 }}>
                <div style={{ flex:1, background:'rgba(34,197,94,.08)', border:'1px solid rgba(34,197,94,.2)', borderRadius:5, padding:'.22rem .35rem', fontSize:'.6rem', color:'#22c55e', fontWeight:700 }}>
                  ● Under 8 / Over 1
                </div>
                <div style={{ flex:1, background:recoveryActive?'rgba(252,163,17,.1)':'var(--bg2)', border:`1px solid ${recoveryActive?'rgba(252,163,17,.28)':'var(--bdr)'}`, borderRadius:5, padding:'.22rem .35rem', fontSize:'.6rem', color:recoveryActive?'#FCA311':'var(--txt2)', fontWeight:700 }}>
                  {recoveryActive?'⚡ Over 3 / Under 6':'○ Recovery off'}
                </div>
              </div>
            </div>
          )}

          <div style={{ flex:1, overflowY:'auto', padding:'.45rem .62rem', fontFamily:"'SF Mono','Fira Code','Consolas',monospace", fontSize:'.67rem', lineHeight:1.85, background:'var(--bg2)' }}>
            {logLines.length===0
              ? <p style={{ color:'var(--txt2)', margin:0 }}>{scannerActive?'Monitoring markets…':'Start the scanner to begin.'}</p>
              : logLines.map(l => (
                <div key={l.id} style={{ color:l.color==='green'?'#22c55e':l.color==='amber'?'#FCA311':l.color==='red'?'#ef4444':l.color==='cyan'?'#00e5cc':l.color==='purple'?'#a78bfa':'var(--txt0)' }}>
                  <span style={{ color:'var(--txt2)', marginRight:'.28rem', fontSize:'.58rem' }}>{fmtTime(l.ts)}</span>{l.text}
                </div>
              ))}
            <div ref={logEndRef}/>
          </div>
          <div style={{ padding:'.3rem .55rem', borderTop:'1px solid #00e5cc14', background:'var(--bg2)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
            <span style={{ fontSize:'.56rem', color:'var(--txt2)' }}>primary≥40 · recovery≥80 · 20s cd</span>
            <button onClick={()=>setLogLines([])} style={{ background:'transparent', border:'none', color:'var(--txt2)', cursor:'pointer', fontSize:'.6rem' }}>Clear</button>
          </div>
        </div>

        {/* CENTER */}
        <div style={{ flex:1, minWidth:0, overflowY:'auto', padding:'.82rem .95rem', display:'flex', flexDirection:'column', gap:'.65rem' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <h1 style={{ margin:0, fontSize:'1.08rem', fontWeight:900, color:'var(--txt0)' }}>⣿ Bulk Trader</h1>
              <p style={{ margin:'1px 0 0', fontSize:'.67rem', color:'var(--txt2)' }}>Fire multiple contracts simultaneously on pattern signals</p>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:'1.22rem', fontWeight:900, color:'#00e5cc', fontVariantNumeric:'tabular-nums' }}>
                {livePrice!=null?livePrice.toFixed(pipSizeRef.current):'—'}
              </div>
              <div style={{ fontSize:'.6rem', color:'var(--txt2)' }}>
                {liveDigit!=null
                  ? <span>LIVE · <span style={{ color:DIGIT_COLORS[liveDigit], fontWeight:800 }}>digit {liveDigit}</span></span>
                  : 'LIVE PRICE'}
              </div>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(128px,1fr))', gap:'.52rem' }}>
            <div className="bt-card">
              <div className="bt-lbl">Market</div>
              <select className="bt-sel" value={symbol} onChange={e=>setSymbol(e.target.value)}>
                {MARKETS.map(m=><option key={m.symbol} value={m.symbol}>{m.label}</option>)}
              </select>
            </div>
            <div className="bt-card">
              <div className="bt-lbl">Trade Type</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {(['even_odd','over_under','matches_differs'] as const).map(t=>(
                  <button key={t} className="tt-chip" onClick={()=>setTradeType(t)} style={{
                    background:tradeType===t?'#00e5cc20':'var(--bg2)',
                    border:`1px solid ${tradeType===t?'#00e5cc':'var(--bdr)'}`,
                    color:tradeType===t?'#00e5cc':'var(--txt1)',
                  }}>{t==='even_odd'?'Even / Odd':t==='over_under'?'Over / Under':'Matches / Differs'}</button>
                ))}
              </div>
            </div>
            {(tradeType==='over_under'||tradeType==='matches_differs')&&(
              <div className="bt-card">
                <div className="bt-lbl">Digit {tradeType==='over_under'?<span style={{ color:'#00e5cc', fontSize:'.55rem' }}>(manual)</span>:null}</div>
                <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                  {Array.from({length:10},(_,d)=>(
                    <button key={d} onClick={()=>setDigit(d)} style={{
                      width:23,height:23,borderRadius:5,cursor:'pointer',
                      border:`1px solid ${digit===d?DIGIT_COLORS[d]:'var(--bdr)'}`,
                      background:digit===d?`${DIGIT_COLORS[d]}22`:'transparent',
                      color:digit===d?DIGIT_COLORS[d]:'var(--txt1)',
                      fontWeight:800,fontSize:'.68rem',
                    }}>{d}</button>
                  ))}
                </div>
                <p style={{ margin:'4px 0 0', fontSize:'.57rem', color:'var(--txt2)' }}>
                  {tradeType==='over_under'?'Scanner auto-selects Under 8 / Over 1':'Digit to differ from (manual)'}
                </p>
              </div>
            )}
            <div className="bt-card">
              <div className="bt-lbl">Stake ({currency})</div>
              <input className="bt-inp" type="number" min="0.35" step="0.01" value={stake} onChange={e=>setStake(e.target.value)}/>
            </div>
            <div className="bt-card">
              <div className="bt-lbl">No. of Bulk Trades</div>
              <input className="bt-inp" type="number" min="1" max="50" step="1" value={bulkCount} onChange={e=>setBulkCount(e.target.value)}/>
              <p style={{ margin:'4px 0 0', fontSize:'.57rem', color:'var(--txt2)' }}>Contracts per signal</p>
            </div>
            <div className="bt-card">
              <div className="bt-lbl">Ticks</div>
              <div style={{ display:'flex', gap:4 }}>
                {[30,60,100].map(n=>(
                  <button key={n} className="tw-chip" onClick={()=>setTicks(n)} style={{
                    background:ticks===n?'rgba(252,163,17,.12)':'var(--bg2)',
                    border:`1px solid ${ticks===n?'rgba(252,163,17,.5)':'var(--bdr)'}`,
                    color:ticks===n?'#FCA311':'var(--txt1)',
                  }}>{n}</button>
                ))}
              </div>
            </div>
            <div className="bt-card">
              <div className="bt-lbl">Scanner Mode</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                <button className="tw-chip" onClick={()=>setScanMode('once')} style={{
                  padding:'.38rem 0',
                  background:scanMode==='once'?'rgba(139,92,246,.15)':'var(--bg2)',
                  border:`1px solid ${scanMode==='once'?'rgba(139,92,246,.5)':'var(--bdr)'}`,
                  color:scanMode==='once'?'#a78bfa':'var(--txt1)',
                }}>⚡ One Shot</button>
                <button className="tw-chip" onClick={()=>setScanMode('continuous')} style={{
                  padding:'.38rem 0',
                  background:scanMode==='continuous'?'rgba(0,229,204,.12)':'var(--bg2)',
                  border:`1px solid ${scanMode==='continuous'?'#00e5cc55':'var(--bdr)'}`,
                  color:scanMode==='continuous'?'#00e5cc':'var(--txt1)',
                }}>∞ Auto Scan</button>
              </div>
              <p style={{ margin:'4px 0 0', fontSize:'.57rem', color:'var(--txt2)' }}>
                {scanMode==='once'?'Fires once then stops':'Runs until manually stopped'}
              </p>
            </div>
          </div>

          <div className="bt-card">
            <div className="bt-lbl">Distribution — last {ticks} ticks</div>
            <div style={{ display:'flex', gap:'.28rem', justifyContent:'space-around', flexWrap:'wrap', paddingTop:4 }}>
              {Array.from({length:10},(_,d)=><DigitGauge key={d} digit={d} count={digitCounts[d]} total={totalTicks} liveDigit={liveDigit}/>)}
            </div>
          </div>

          <div className="bt-card">
            <div className="bt-lbl">Last 60 Digits</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'3px', paddingTop:4 }}>
              {recentDigits.slice(-60).map((d,i,arr)=>(
                <span key={i} className="dot-cell" style={{
                  background:i===arr.length-1?DIGIT_COLORS[d]:`${DIGIT_COLORS[d]}18`,
                  color:i===arr.length-1?'#000':DIGIT_COLORS[d],
                  border:`1px solid ${DIGIT_COLORS[d]}44`,
                  transform:i===arr.length-1?'scale(1.25)':'none',
                  transition:'transform .15s',
                }}>{d}</span>
              ))}
            </div>
          </div>

          <div className="bt-card">
            <div className="bt-lbl">Manual — fires {parseInt(bulkCount)||1} contracts now</div>
            <div style={{ display:'flex', gap:'.52rem' }}>
              {tradeType==='even_odd'?<>
                <button className="bt-btn" disabled={isTrading} onClick={()=>handleManualTrade('DIGITEVEN')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#22c55e', color:'#000' }}>
                  {isTrading?'Trading…':`▲ Even ×${parseInt(bulkCount)||1}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={()=>handleManualTrade('DIGITODD')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading?'Trading…':`▼ Odd ×${parseInt(bulkCount)||1}`}
                </button>
              </>:tradeType==='over_under'?<>
                <button className="bt-btn" disabled={isTrading} onClick={()=>handleManualTrade('DIGITOVER')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#22c55e', color:'#000' }}>
                  {isTrading?'Trading…':`▲ Over ${digit} ×${parseInt(bulkCount)||1}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={()=>handleManualTrade('DIGITUNDER')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading?'Trading…':`▼ Under ${digit} ×${parseInt(bulkCount)||1}`}
                </button>
              </>:<>
                <button className="bt-btn" disabled={isTrading} onClick={()=>handleManualTrade('DIGITDIFF')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#8b5cf6', color:'#fff' }}>
                  {isTrading?'Trading…':`≠ Differs ${digit} ×${parseInt(bulkCount)||1}`}
                </button>
              </>}
            </div>
            {tradeError&&<p style={{ margin:'.38rem 0 0', fontSize:'.73rem', color:'#ef4444' }}>{tradeError}</p>}
          </div>
        </div>

        {/* RIGHT: Trade history */}
        <div style={{ width:212, flexShrink:0, borderLeft:'1px solid var(--bdr)', display:'flex', flexDirection:'column', background:'var(--bg1)' }}>
          <div style={{ padding:'.52rem .62rem', borderBottom:'1px solid var(--bdr)', flexShrink:0, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:'.78rem', fontWeight:800, color:'var(--txt0)' }}>Trade History</span>
            <span style={{ fontSize:'.6rem', color:'var(--txt2)' }}>{trades.length>0?trades.length:''}</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 52px 28px 52px', gap:2, padding:'.23rem .38rem', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
            {['Type','Stake','','P&L'].map((h,i)=>(
              <span key={i} style={{ fontSize:'.55rem', color:'var(--txt2)', fontWeight:700, textTransform:'uppercase', textAlign:i>=2?'center':i===1?'right':'left' as const }}>{h}</span>
            ))}
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'.12rem' }}>
            {trades.length===0
              ?<div style={{ padding:'2rem .8rem', textAlign:'center', color:'var(--txt2)', fontSize:'.7rem' }}>No trades yet.</div>
              :trades.map(t=>{
                const short  = t.contractType.replace('DIGIT','')
                const mkt    = MARKETS.find(m=>m.symbol===t.symbol)?.label.replace('Volatility ','V') ?? t.symbol
                const pnlClr = t.failed?'var(--txt1)':t.won===null?'#FCA311':t.won?'#22c55e':'#ef4444'
                const pnlTxt = t.failed?'rejected':t.won===null?'…':`${(t.profit??0)>=0?'+':''}${fmt2(t.profit??0)}`
                const srcClr = t.source==='recovery'?'#FCA311':t.source==='scanner'?'#00e5cc':'var(--txt0)'
                return (
                  <div key={t.id} className="hr-row" style={{ animation:'fadeIn .18s ease' }}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontSize:'.68rem', fontWeight:700, color:srcClr, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{short}{t.source==='recovery'?<span style={{ fontSize:'.54rem', marginLeft:2, opacity:.7 }}>R</span>:null}</div>
                      <div style={{ fontSize:'.55rem', color:'var(--txt2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{mkt}</div>
                    </div>
                    <div style={{ textAlign:'right', fontSize:'.67rem', color:'var(--txt1)', fontVariantNumeric:'tabular-nums' }}>{fmt2(t.stake)}</div>
                    <div style={{ textAlign:'center' }}>
                      {t.failed?<span style={{ color:'var(--txt1)', fontSize:'.58rem' }}>⊘</span>:t.won===null?<span style={{ color:'#FCA311', fontSize:'.58rem' }}>●</span>:t.won?<span style={{ color:'#22c55e', fontSize:'.58rem' }}>✓</span>:<span style={{ color:'#ef4444', fontSize:'.58rem' }}>✗</span>}
                    </div>
                    <div style={{ textAlign:'right', fontSize:'.68rem', fontWeight:700, color:pnlClr, fontVariantNumeric:'tabular-nums' }}>{pnlTxt}</div>
                  </div>
                )
              })}
          </div>
          {trades.length>0&&(
            <div style={{ padding:'.38rem', borderTop:'1px solid var(--bdr)', flexShrink:0 }}>
              <button onClick={()=>setTrades([])} style={{ width:'100%', padding:'.28rem', borderRadius:6, cursor:'pointer', background:'var(--bg2)', border:'1px solid var(--bdr)', color:'var(--txt2)', fontSize:'.67rem' }}>
                Clear history
              </button>
            </div>
          )}
        </div>

      </div>
    </>
  )
}
