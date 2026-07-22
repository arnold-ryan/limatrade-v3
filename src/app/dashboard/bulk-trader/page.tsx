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
// Scoring logic (entropy/persistence bonuses, thresholds, weights) lives entirely
// server-side now — see /api/signals/detect. This is just the response shape.
interface ScanResult {
  signal: boolean
  score: number
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITDIFF' | null
  barrier: number | null
  reason: string
  detail: string
}
const NO_SIGNAL: ScanResult = { signal: false, score: 0, contractType: null, barrier: null, reason: '', detail: '' }

async function detectPrimary(digits: number[], persistCount: number): Promise<ScanResult> {
  try {
    const r = await fetch('/api/signals/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'primary', digits, persistCount }),
    })
    if (!r.ok) return NO_SIGNAL
    return await r.json() as ScanResult
  } catch { return NO_SIGNAL }
}

async function detectSignal(
  digits: number[],
  tradeType: 'even_odd' | 'matches_differs',
  persistCount: number,
): Promise<ScanResult> {
  try {
    const r = await fetch('/api/signals/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: tradeType, digits, persistCount }),
    })
    if (!r.ok) return NO_SIGNAL
    return await r.json() as ScanResult
  } catch { return NO_SIGNAL }
}

interface TradeRow {
  id: number; ts: number; contractType: string; symbol: string
  stake: number; payout: number; won: boolean | null; profit: number | null
  source: 'manual' | 'scanner'
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
  const [scannerStatus, setScannerStatus] = useState<'idle'|'scanning'|'fired'>('idle')
  const [logLines,       setLogLines]       = useState<LogLine[]>([])
  const logIdRef        = useRef(0)
  const logEndRef       = useRef<HTMLDivElement>(null)

  /* scanner WS refs */
  const scannerWsRefs = useRef<Map<string,WebSocket>>(new Map())
  const scannerDigits = useRef<Map<string,number[]>>(new Map())

  /* primary strategy refs (UNDER 8 / OVER 1) */
  const primaryCooldowns = useRef<Map<string,number>>(new Map())
  const primaryPersists  = useRef<Map<string,number>>(new Map())
  // Detection now round-trips to the server — guards against firing a second
  // request for the same symbol while one is still in flight.
  const primaryChecking  = useRef<Set<string>>(new Set())

  /* general cooldowns for even_odd / matches_differs */
  const generalCooldowns = useRef<Map<string,number>>(new Map())
  const generalPersists  = useRef<Map<string,number>>(new Map())
  const generalChecking  = useRef<Set<string>>(new Set())

  const scannerBotWsRef  = useRef<WebSocket|null>(null)
  const scannerActiveRef = useRef(false)
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
   * Buys a contract directly, without a prior proposal — this is what lets Bulk
   * Trader fire N identical contracts in the same instant. A `proposal` subscription
   * is deduped by Deriv on its contract parameters (not req_id), so N concurrent
   * proposal requests for the *same* contract collide and all but one get rejected
   * with "You are already subscribed to proposal." A direct buy has no such
   * subscription and no such limit — each is a self-contained quote-and-execute
   * round trip, so all n fire truly simultaneously.
   *
   * `price` is the most the trader is willing to pay. With basis:'stake' the actual
   * charge (ask_price) is always ~equal to `amount` by definition — you're specifying
   * how much to risk, not a payout target — so capping slightly above the stake is
   * the correct slippage guard here, not the flat $1000 ceiling this used to have
   * (which silently rejected any stake whose real ask_price happened to exceed it).
   */
  const fireBuy = useCallback((
    ws: WebSocket, contractType: string, barrierVal: number|null,
    stakeVal: number, sym: string, cur: string, rowId: number,
    pending: Map<number,{rowId:number;stake:number}>,
  ) => {
    const reqId = ++reqIdRef.current
    pending.set(reqId, { rowId, stake:stakeVal })
    ws.send(JSON.stringify({
      buy:'1', price:+(stakeVal * 1.02).toFixed(2), req_id:reqId,
      parameters: {
        contract_type:contractType, underlying_symbol:sym,
        duration:5, duration_unit:'t', amount:stakeVal, basis:'stake', currency:cur,
        ...(barrierVal !== null ? { barrier:String(barrierVal) } : {}),
      },
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

  const handleManualTrade = useCallback(async (contractType: string) => {
    if (isTrading) return
    setIsTrading(true); setTradeError(null)
    const stakeVal = parseFloat(stake) || 1
    const n        = parseInt(bulkCount) || 1
    const barrierVal = (tradeType === 'over_under' || tradeType === 'matches_differs') ? digit : null
    const ws = await connectBotWs()
    if (!ws) { setTradeError('Connection failed'); setIsTrading(false); return }
    intentionalClose.current = false
    const pending  = new Map<number,{rowId:number;stake:number}>()
    const reqToRow = new Map<number,number>()
    const cidToStake = new Map<number,number>()
    let doneCount = 0
    const finishOne = () => { doneCount++; if (doneCount >= n) { intentionalClose.current = true; ws.close(); setIsTrading(false) } }

    ws.onmessage = (ev) => {
      let msg: Record<string,unknown>; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:(msg.balance as Record<string,unknown>)?.balance, currency:(msg.balance as Record<string,unknown>)?.currency } }))
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
      if (msg.error && msg.msg_type !== 'buy') {
        setTradeError((msg.error as Record<string,unknown>)?.message as string ?? 'Trade error'); intentionalClose.current = true; ws.close(); setIsTrading(false)
      }
    }
    ws.onclose = () => { if (!intentionalClose.current) setIsTrading(false) }
    ws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))
    // Fire all n buys in the same synchronous burst — true simultaneous execution.
    for (let i = 0; i < n; i++) {
      const rowId = addTrade(contractType, symbol, stakeVal, 'manual')
      fireBuy(ws, contractType, barrierVal, stakeVal, symbol, currency, rowId, pending)
    }
  }, [isTrading, stake, bulkCount, tradeType, digit, symbol, currency, connectBotWs, addTrade, fireBuy, settleTrade, failTrade])

  const startScanner = useCallback(async () => {
    setScannerActive(true); setScannerStatus('scanning'); setLogLines([])
    scanPendingCount.current = 0
    scanTradeTypeRef.current = tradeType
    scanStakeRef.current     = stake
    scanCountRef.current     = parseInt(bulkCount) || 1
    scanCurrencyRef.current  = currency
    scanModeRef.current      = scanMode

    const isOU = tradeType === 'over_under'
    log('━━━ AI BULK SCANNER V2 ━━━', 'cyan')
    if (isOU) {
      log('Mode: Over/Under — Under 8 + Over 1 (80% natural)', 'white')
    } else {
      log(`Mode: ${tradeType === 'even_odd' ? 'Even / Odd' : 'Matches / Differs (DIGITDIFF, auto-digit)'}`, 'white')
    }
    log(`Markets: ${SCAN_SYMBOLS.join('  ·  ')}`, 'white')

    const bws = await connectBotWs()
    if (!bws) { log('ERROR: trading WS failed', 'red'); setScannerActive(false); setScannerStatus('idle'); return }
    scannerBotWsRef.current = bws
    const scanPending  = new Map<number,{rowId:number;stake:number}>()
    const scanReqToRow = new Map<number,number>()
    const scanCidToStake = new Map<number,number>()

    const scanFinishOne = () => {
      scanPendingCount.current = Math.max(0, scanPendingCount.current - 1)
      if (scanPendingCount.current === 0 && scanModeRef.current === 'once' && scannerBotWsRef.current) {
        try { scannerBotWsRef.current.close() } catch { /**/ }
        scannerBotWsRef.current = null
      }
    }

    // Fires a contract directly (no proposal) — Deriv dedupes proposal subscriptions
    // by contract parameters, so firing scanCountRef.current identical proposals at
    // once for one signal gets all but one rejected as "already subscribed to
    // proposal". A direct buy has no such subscription, so all of them fire truly
    // simultaneously. price is capped just above the stake since basis:'stake'
    // means the actual charge always ~equals the stake by definition.
    const scanFireBuy = (ct: string, barrierVal: number|null, sym: string, rowId: number) => {
      const stakeVal = parseFloat(scanStakeRef.current) || 1
      const reqId = ++reqIdRef.current
      scanPending.set(reqId, { rowId, stake:stakeVal })
      bws.send(JSON.stringify({
        buy:'1', price:+(stakeVal * 1.02).toFixed(2), req_id:reqId,
        parameters: {
          contract_type:ct, underlying_symbol:sym, duration:5, duration_unit:'t',
          amount:stakeVal, basis:'stake', currency:scanCurrencyRef.current,
          ...(barrierVal !== null ? { barrier:String(barrierVal) } : {}),
        },
      }))
    }

    bws.onmessage = (ev) => {
      let msg: Record<string,unknown>; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:(msg.balance as Record<string,unknown>)?.balance, currency:(msg.balance as Record<string,unknown>)?.currency } }))
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
        if (rowId != null) {
          settleTrade(rowId, payout, stk)
          const won = payout > stk
          log(`  ${won ? '\u2713 WIN' : '\u2717 LOSS'} ${won?'+':''}${fmt2(payout-stk)} ${scanCurrencyRef.current}`, won ? 'green' : 'red')
          scanFinishOne()
        }
      }
      if (msg.error && msg.msg_type !== 'buy') {
        log(`  ERROR: ${(msg.error as Record<string,unknown>)?.message}`, 'red')
      }
    }
    bws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))

    SCAN_SYMBOLS.forEach(sym => {
      scannerDigits.current.set(sym, [])
      primaryPersists.current.set(sym, 0)
      generalPersists.current.set(sym, 0)
      let localPipSize = 2, tickCount = 0

      const ws = new WebSocket(PUBLIC_WS_URL)
      scannerWsRefs.current.set(sym, ws)
      ws.onopen = () => ws.send(JSON.stringify({ ticks_history:sym, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
      ws.onmessage = async (ev) => {
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
            // Detection is now a server round trip — skip this tick if the
            // previous check for this symbol hasn't come back yet.
            if (Date.now() - pCool >= 20_000 && !primaryChecking.current.has(sym)) {
              primaryChecking.current.add(sym)
              const pPersist = primaryPersists.current.get(sym) ?? 0
              const pResult  = await detectPrimary(digits, pPersist)
              primaryChecking.current.delete(sym)
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
                      scanFireBuy(pResult.contractType, pResult.barrier, sym, rowId)
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

            return
          }

          /* ── Even/Odd and Matches/Differs ── */
          const gCool = generalCooldowns.current.get(sym) ?? 0
          if (Date.now() - gCool < 20_000) return
          if (generalChecking.current.has(sym)) return
          generalChecking.current.add(sym)
          const gPersist = generalPersists.current.get(sym) ?? 0
          const result   = await detectSignal(digits, tt as 'even_odd'|'matches_differs', gPersist)
          generalChecking.current.delete(sym)
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
                  scanFireBuy(result.contractType, result.barrier, sym, rowId)
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
  }, [tradeType, stake, bulkCount, currency, scanMode, connectBotWs, addTrade, settleTrade, log, failTrade])

  const stopScanner = useCallback((keepBotWs = false) => {
    setScannerActive(false); setScannerStatus('idle')
    log('━━━ SCANNER STOPPED ━━━', 'amber')
    scannerWsRefs.current.forEach(ws => { try { ws.close() } catch { /**/ } })
    scannerWsRefs.current.clear(); scannerDigits.current.clear()
    primaryCooldowns.current.clear(); primaryPersists.current.clear(); primaryChecking.current.clear()
    generalCooldowns.current.clear(); generalPersists.current.clear(); generalChecking.current.clear()
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

  useEffect(() => { scannerActiveRef.current = scannerActive }, [scannerActive])

  // The scanner's trading WS is opened once when it starts and stays open —
  // bound to whichever account was active at that moment — for as long as it
  // keeps running. If the trader switches Real/Demo from the header without
  // stopping it first, it would otherwise keep firing on the ORIGINAL account
  // while the header shows the new one. With real money involved, that's not
  // a cosmetic bug, so we force-stop the scanner the instant an account
  // switch happens rather than trying to silently re-target it mid-run.
  useEffect(() => {
    const onAccountSwitch = () => {
      if (scannerActiveRef.current) {
        log('━━━ ACCOUNT SWITCHED — scanner stopped for your safety ━━━', 'red')
        stopScanner()
        setTradeError('Account switched — the scanner was stopped so it can never fire on the wrong account. Restart it to keep trading on the new account.')
      }
    }
    window.addEventListener('deriv-account-switch', onAccountSwitch)
    return () => window.removeEventListener('deriv-account-switch', onAccountSwitch)
  }, [stopScanner, log])

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
      `}</style>

      <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

        {/* LEFT: Scanner */}
        <div style={{ width:250, flexShrink:0, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', background:'var(--bg1)' }}>
          <div style={{ padding:'.58rem .72rem', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'.35rem' }}>
              <span style={{ fontSize:'.8rem', fontWeight:800, color:'var(--txt0)' }}>AI Scanner V2</span>
              <span style={{
                padding:'.18rem .5rem', borderRadius:20, fontSize:'.61rem', fontWeight:700,
                background:scannerStatus==='idle'?'var(--bg2)':scannerStatus==='scanning'?'#00e5cc18':'rgba(34,197,94,.15)',
                color:scannerStatus==='idle'?'var(--txt2)':scannerStatus==='scanning'?'#00e5cc':'#22c55e',
                border:`1px solid ${scannerStatus==='idle'?'var(--bdr)':scannerStatus==='scanning'?'#00e5cc44':'rgba(34,197,94,.3)'}`,
              }}>
                {scannerActive && <span style={{ width:5,height:5,borderRadius:'50%',background:'#22c55e',display:'inline-block',marginRight:4,animation:'scanPulse 1.2s ease infinite' }}/>}
                {scannerStatus==='idle'?'IDLE':scannerStatus==='scanning'?'SCANNING':'FIRED'}
              </span>
            </div>
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
              <div style={{ background:'rgba(34,197,94,.08)', border:'1px solid rgba(34,197,94,.2)', borderRadius:5, padding:'.22rem .35rem', fontSize:'.6rem', color:'#22c55e', fontWeight:700 }}>
                ● Under 8 / Over 1
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
            <span style={{ fontSize:'.56rem', color:'var(--txt2)' }}>score≥40 · 20s cd</span>
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
                const srcClr = t.source==='scanner'?'#00e5cc':'var(--txt0)'
                return (
                  <div key={t.id} className="hr-row" style={{ animation:'fadeIn .18s ease' }}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontSize:'.68rem', fontWeight:700, color:srcClr, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{short}</div>
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
