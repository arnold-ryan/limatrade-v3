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

/* ─── AI Scanner log line ────────────────────────────────────────────────── */
interface LogLine {
  id:    number
  text:  string
  color: 'green' | 'amber' | 'red' | 'cyan' | 'white'
  ts:    number
}

/* ─── Pattern detection (pure function) ─────────────────────────────────── */
interface PatternResult {
  signal:     boolean
  confidence: number  // 0-100
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | null
  barrier:    number | null
  reason:     string
}

function detectPattern(digits: number[], tradeType: 'even_odd' | 'over_under', barrier: number): PatternResult {
  if (digits.length < 20) return { signal: false, confidence: 0, contractType: null, barrier: null, reason: 'Need ≥20 ticks' }

  const recent = digits.slice(-60)
  const last30 = digits.slice(-30)

  if (tradeType === 'even_odd') {
    // Count even/odd in recent
    const evenCount = recent.filter(d => d % 2 === 0).length
    const oddCount  = recent.length - evenCount
    const evenPct   = evenCount / recent.length
    const oddPct    = oddCount  / recent.length

    // Trailing streak
    let streak = 1
    const lastVal = recent[recent.length - 1] % 2
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i] % 2 === lastVal) streak++
      else break
    }

    if (streak >= 5) {
      const betType = lastVal === 0 ? 'DIGITODD' : 'DIGITEVEN'
      const conf = Math.min(95, 60 + streak * 5)
      return {
        signal: true,
        confidence: conf,
        contractType: betType,
        barrier: null,
        reason: `${streak}-digit ${lastVal === 0 ? 'even' : 'odd'} streak → bet ${betType === 'DIGITEVEN' ? 'Even' : 'Odd'}`,
      }
    }

    if (evenPct > 0.66) {
      return {
        signal: true,
        confidence: Math.round(evenPct * 100),
        contractType: 'DIGITODD',
        barrier: null,
        reason: `${Math.round(evenPct * 100)}% even in last 60 → bet Odd`,
      }
    }
    if (oddPct > 0.66) {
      return {
        signal: true,
        confidence: Math.round(oddPct * 100),
        contractType: 'DIGITEVEN',
        barrier: null,
        reason: `${Math.round(oddPct * 100)}% odd in last 60 → bet Even`,
      }
    }

    return { signal: false, confidence: 0, contractType: null, barrier: null, reason: 'No pattern' }
  }

  // over_under
  const overCount  = last30.filter(d => d > barrier).length
  const underCount = last30.filter(d => d < barrier).length
  const overPct    = overCount  / last30.length
  const underPct   = underCount / last30.length

  // Trap digits: ≤2 or ≥7 are "trap" for over/under 5
  const trapCount = last30.filter(d => d <= 2 || d >= 7).length
  const trapPct   = trapCount / last30.length

  if (trapPct > 0.70) {
    return {
      signal: true,
      confidence: Math.round(trapPct * 100),
      contractType: 'DIGITOVER',
      barrier: barrier,
      reason: `${Math.round(trapPct * 100)}% trap digits → Over ${barrier}`,
    }
  }

  if (overPct > 0.66) {
    return {
      signal: true,
      confidence: Math.round(overPct * 100),
      contractType: 'DIGITUNDER',
      barrier: barrier,
      reason: `${Math.round(overPct * 100)}% over ${barrier} → bet Under`,
    }
  }
  if (underPct > 0.66) {
    return {
      signal: true,
      confidence: Math.round(underPct * 100),
      contractType: 'DIGITOVER',
      barrier: barrier,
      reason: `${Math.round(underPct * 100)}% under ${barrier} → bet Over`,
    }
  }

  return { signal: false, confidence: 0, contractType: null, barrier: null, reason: 'No pattern' }
}

/* ─── Digit Gauge ────────────────────────────────────────────────────────── */
function DigitGauge({ digit, count, total, liveDigit }: {
  digit: number; count: number; total: number; liveDigit: number | null
}) {
  const pct   = total > 0 ? (count / total) * 100 : 0
  const r     = 20
  const circ  = 2 * Math.PI * r
  const dash  = (pct / 100) * circ
  const isLive = liveDigit === digit

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <svg width="52" height="52" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" />
        <circle
          cx="26" cy="26" r={r} fill="none"
          stroke={isLive ? '#fff' : DIGIT_COLORS[digit]}
          strokeWidth={isLive ? 6 : 4}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.3s ease', filter: isLive ? `drop-shadow(0 0 6px ${DIGIT_COLORS[digit]})` : 'none' }}
        />
        <text x="26" y="30" textAnchor="middle" fontSize="13" fontWeight="800"
          fill={isLive ? '#fff' : DIGIT_COLORS[digit]}>{digit}</text>
      </svg>
      <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.5)' }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  )
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export default function BulkTraderPage() {
  // ── UI state ──
  const [symbol,      setSymbol]      = useState('1HZ100V')
  const [tradeType,   setTradeType]   = useState<'even_odd' | 'over_under'>('even_odd')
  const [barrier,     setBarrier]     = useState(5)
  const [stake,       setStake]       = useState('1.00')
  const [tradeCount,  setTradeCount]  = useState(3)
  const [tickHistory, setTickHistory] = useState(60)

  // ── Tick data ──
  const [livePrice,    setLivePrice]    = useState<number | null>(null)
  const [recentDigits, setRecentDigits] = useState<number[]>([])
  const [digitCounts,  setDigitCounts]  = useState<number[]>(Array(10).fill(0))
  const pipSizeRef = useRef(2)

  // ── Trade state ──
  const [isTrading,   setIsTrading]   = useState(false)
  const [tradeError,  setTradeError]  = useState<string | null>(null)
  const [lastResult,  setLastResult]  = useState<{ won: boolean; profit: number } | null>(null)
  const [totalPnl,    setTotalPnl]    = useState(0)
  const [currency,    setCurrency]    = useState('USD')
  const botWsRef      = useRef<WebSocket | null>(null)
  const reqIdRef      = useRef(0)
  const pendingBuys   = useRef(new Map<number, number>()) // contractId → stake
  const intentionalClose = useRef(false)

  // ── AI Scanner ──
  const [scannerOpen,   setScannerOpen]   = useState(false)
  const [scannerActive, setScannerActive] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<'idle' | 'scanning' | 'fired'>('idle')
  const [logLines,      setLogLines]      = useState<LogLine[]>([])
  const logIdRef        = useRef(0)
  const scannerWsRefs   = useRef<Map<string, WebSocket>>(new Map())
  const scannerDigits   = useRef<Map<string, number[]>>(new Map())
  const cooldowns       = useRef<Map<string, number>>(new Map())
  const scannerBotWsRef = useRef<WebSocket | null>(null)

  // ── Digit counts sync ──
  useEffect(() => {
    const counts = Array(10).fill(0)
    recentDigits.slice(-tickHistory).forEach(d => counts[d]++)
    setDigitCounts(counts)
  }, [recentDigits, tickHistory])

  // ── Public WS: ticks ──
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        end:   'latest',
        count: 100,
        style: 'ticks',
        subscribe: 1,
        req_id: 1,
      }))
    }
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }

      if (msg.msg_type === 'history') {
        if (msg.pip_size != null) pipSizeRef.current = msg.pip_size
        const prices: number[] = msg.history?.prices ?? []
        setRecentDigits(prices.map(p => lastDigit(Number(p), pipSizeRef.current)).slice(-100))
        setLivePrice(prices[prices.length - 1] ?? null)
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
    ws.onerror = () => {}
    ws.onclose = () => {}
    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 9999 })) } catch { /**/ }
      }
      ws.close()
      setLivePrice(null)
      setRecentDigits([])
    }
  }, [symbol])

  // ── Logger helper ──
  const log = useCallback((text: string, color: LogLine['color'] = 'white') => {
    const id = ++logIdRef.current
    setLogLines(prev => [...prev.slice(-200), { id, text, color, ts: Date.now() }])
  }, [])

  // ── Connect bot WS ──
  const connectBotWs = useCallback(async (): Promise<WebSocket | null> => {
    try {
      const r = await fetch('/api/user/ws-url')
      if (!r.ok) {
        if (r.status === 401) { window.location.href = '/'; return null }
        return null
      }
      const { wsUrl } = await r.json()
      const ws = new WebSocket(wsUrl)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('WS connect failed'))
        setTimeout(() => reject(new Error('timeout')), 10_000)
      })
      // Subscribe to balance and account info
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
      // Get currency
      try {
        const br = await fetch('/api/user/balance')
        if (br.ok) {
          const { accounts, activeAccountId } = await br.json()
          const active = accounts?.find((a: any) => a.accountId === activeAccountId) ?? accounts?.[0]
          if (active?.currency) setCurrency(active.currency)
        }
      } catch { /**/ }
      return ws
    } catch {
      return null
    }
  }, [])

  // ── Fire N bulk trades on a WS ──
  const fireTrades = useCallback((
    ws: WebSocket,
    contractType: string,
    barrierVal: number | null,
    stakeVal: number,
    count: number,
    sym: string,
    cur: string,
  ) => {
    for (let i = 0; i < count; i++) {
      const reqId = ++reqIdRef.current
      ws.send(JSON.stringify({
        buy: '1',
        price: 1000,
        req_id: reqId,
        parameters: {
          contract_type:     contractType,
          underlying_symbol: sym,
          duration:          5,
          duration_unit:     't',
          amount:            stakeVal,
          basis:             'stake',
          currency:          cur,
          ...(barrierVal !== null ? { barrier: String(barrierVal) } : {}),
        },
      }))
    }
  }, [])

  // ── Manual bulk trade ──
  const handleManualTrade = useCallback(async (contractType: string) => {
    if (isTrading) return
    setIsTrading(true)
    setTradeError(null)

    const stakeVal = parseFloat(stake) || 1.00
    const ws = await connectBotWs()
    if (!ws) { setTradeError('Connection failed'); setIsTrading(false); return }
    botWsRef.current = ws
    intentionalClose.current = false

    let settled = 0
    let pnl     = 0
    const n     = tradeCount

    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') {
        window.dispatchEvent(new CustomEvent('deriv-balance', {
          detail: { balance: msg.balance?.balance, currency: msg.balance?.currency },
        }))
      }
      if (msg.msg_type === 'buy') {
        if (msg.buy?.contract_id) pendingBuys.current.set(msg.buy.contract_id, stakeVal)
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const profit = (msg.transaction.amount ?? 0) - stakeVal
        pnl += profit
        settled++
        if (settled >= n) {
          setLastResult({ won: pnl > 0, profit: pnl })
          setTotalPnl(prev => prev + pnl)
          intentionalClose.current = true
          ws.close()
          setIsTrading(false)
        }
      }
      if (msg.error) {
        setTradeError(msg.error.message ?? 'Trade error')
        intentionalClose.current = true
        ws.close()
        setIsTrading(false)
      }
    }
    ws.onclose = () => {
      if (!intentionalClose.current) setIsTrading(false)
    }

    // Subscribe transaction stream then fire trades
    ws.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))
    fireTrades(ws, contractType, tradeType === 'over_under' ? barrier : null, stakeVal, n, symbol, currency)
  }, [isTrading, stake, tradeCount, tradeType, barrier, symbol, currency, connectBotWs, fireTrades])

  // ── AI Scanner start/stop ──
  const startScanner = useCallback(async () => {
    setScannerActive(true)
    setScannerStatus('scanning')
    setLogLines([])
    log('━━━ AI BULK SCANNER STARTED ━━━', 'cyan')
    log(`Monitoring: ${SCAN_SYMBOLS.join(', ')}`, 'white')
    log(`Trade type: ${tradeType === 'even_odd' ? 'Even/Odd' : `Over/Under ${barrier}`}`, 'white')
    log(`Stake: ${stake} × ${tradeCount} trades per signal`, 'white')
    log('Scanning for patterns...', 'green')

    // Connect bot WS for scanner trades
    const bws = await connectBotWs()
    if (!bws) { log('ERROR: Could not connect trading WS', 'red'); setScannerActive(false); setScannerStatus('idle'); return }
    scannerBotWsRef.current = bws

    bws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') {
        window.dispatchEvent(new CustomEvent('deriv-balance', {
          detail: { balance: msg.balance?.balance, currency: msg.balance?.currency },
        }))
      }
      if (msg.msg_type === 'buy') {
        log(`  ✓ Contract bought: ${msg.buy?.contract_id}`, 'green')
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const profit = msg.transaction.amount ?? 0
        const won = profit > 0
        log(`  ${won ? '✓ WIN' : '✗ LOSS'} +${fmt2(profit)} ${currency}`, won ? 'green' : 'red')
        setTotalPnl(prev => prev + profit)
      }
      if (msg.error) {
        log(`  ERROR: ${msg.error.message}`, 'red')
      }
    }
    bws.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))

    // Open one public WS per scan symbol
    SCAN_SYMBOLS.forEach(sym => {
      scannerDigits.current.set(sym, [])
      const ws = new WebSocket(PUBLIC_WS_URL)
      scannerWsRefs.current.set(sym, ws)

      ws.onopen = () => {
        ws.send(JSON.stringify({
          ticks_history: sym,
          end:   'latest',
          count: 100,
          style: 'ticks',
          subscribe: 1,
          req_id: 1,
        }))
      }

      let localPipSize = 2
      ws.onmessage = (ev) => {
        let msg: any
        try { msg = JSON.parse(ev.data) } catch { return }

        if (msg.msg_type === 'history') {
          if (msg.pip_size != null) localPipSize = msg.pip_size
          const prices: number[] = msg.history?.prices ?? []
          scannerDigits.current.set(sym, prices.map(p => lastDigit(Number(p), localPipSize)))
        }
        if (msg.msg_type === 'tick') {
          if (msg.tick?.pip_size != null) localPipSize = msg.tick.pip_size
          const q = msg.tick?.quote
          if (q != null) {
            const digits = scannerDigits.current.get(sym) ?? []
            digits.push(lastDigit(Number(q), localPipSize))
            if (digits.length > 200) digits.shift()
            scannerDigits.current.set(sym, digits)

            // Only check every 5 ticks to avoid spam
            if (digits.length % 5 !== 0) return

            // Check cooldown (30s per market)
            const lastFired = cooldowns.current.get(sym) ?? 0
            if (Date.now() - lastFired < 30_000) return

            const result = detectPattern(digits, tradeType, barrier)
            if (result.signal && result.confidence >= 62 && result.contractType) {
              const mkt = MARKETS.find(m => m.symbol === sym)?.label ?? sym
              log(`━━━ SIGNAL: ${mkt} ━━━`, 'cyan')
              log(`  ${result.reason}`, 'amber')
              log(`  Confidence: ${result.confidence}%`, 'amber')
              log(`  Firing ${tradeCount}× ${result.contractType} @ ${stake} ${currency}`, 'white')

              cooldowns.current.set(sym, Date.now())
              setScannerStatus('fired')
              setTimeout(() => setScannerStatus('scanning'), 3000)

              if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
                fireTrades(
                  scannerBotWsRef.current,
                  result.contractType,
                  result.barrier,
                  parseFloat(stake) || 1,
                  tradeCount,
                  sym,
                  currency,
                )
              }
            }
          }
        }
      }
      ws.onerror = () => log(`WS error on ${sym}`, 'red')
    })
  }, [tradeType, barrier, stake, tradeCount, currency, connectBotWs, fireTrades, log])

  const stopScanner = useCallback(() => {
    setScannerActive(false)
    setScannerStatus('idle')
    log('━━━ SCANNER STOPPED ━━━', 'amber')
    scannerWsRefs.current.forEach(ws => { try { ws.close() } catch { /**/ } })
    scannerWsRefs.current.clear()
    scannerDigits.current.clear()
    cooldowns.current.clear()
    if (scannerBotWsRef.current) { try { scannerBotWsRef.current.close() } catch { /**/ } }
    scannerBotWsRef.current = null
  }, [log])

  // Cleanup on unmount
  useEffect(() => () => { stopScanner() }, [stopScanner])

  const liveDigit = livePrice != null ? lastDigit(livePrice, pipSizeRef.current) : null
  const totalTicks = recentDigits.slice(-tickHistory).length
  const stakeVal   = parseFloat(stake) || 0

  /* ─── Render ──────────────────────────────────────────────────────────── */
  return (
    <>
      <style>{`
        .bt-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          padding: 1rem 1.25rem;
        }
        .bt-label {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: rgba(229,229,229,0.45);
          text-transform: uppercase;
          margin-bottom: 0.5rem;
        }
        .bt-select {
          width: 100%;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 9px;
          color: #e5e5e5;
          padding: 0.55rem 0.75rem;
          font-size: 0.85rem;
          outline: none;
          cursor: pointer;
        }
        .bt-input {
          width: 100%;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 9px;
          color: #e5e5e5;
          padding: 0.55rem 0.75rem;
          font-size: 0.9rem;
          outline: none;
          box-sizing: border-box;
        }
        .bt-input:focus { border-color: ${ACCENT}; }
        .bt-btn {
          border: none;
          border-radius: 10px;
          font-weight: 800;
          font-size: 0.9rem;
          cursor: pointer;
          padding: 0.65rem 1.25rem;
          transition: opacity 0.15s;
        }
        .bt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .type-chip {
          padding: 0.5rem 1rem;
          border-radius: 8px;
          font-size: 0.82rem;
          font-weight: 700;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s;
        }
        .digit-stream-dot {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 5px;
          font-size: 0.72rem;
          font-weight: 800;
          flex-shrink: 0;
        }
        .scanner-modal-bg {
          position: fixed; inset: 0; z-index: 999;
          background: rgba(0,0,0,0.88); backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
          padding: 1rem;
        }
        .scanner-modal {
          background: #080f0e;
          border: 1px solid ${ACCENT}44;
          border-radius: 16px;
          width: 100%; max-width: 640px;
          max-height: 85vh;
          display: flex; flex-direction: column;
          overflow: hidden;
          box-shadow: 0 0 60px ${ACCENT}22;
        }
        .log-line-green { color: #22c55e; }
        .log-line-amber { color: #FCA311; }
        .log-line-red   { color: #ef4444; }
        .log-line-cyan  { color: ${ACCENT}; }
        .log-line-white { color: rgba(229,229,229,0.8); }
      `}</style>

      <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '900px', margin: '0 auto' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 900, color: '#fff' }}>⣿ Bulk Trader</h1>
            <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'rgba(229,229,229,0.4)' }}>
              Fire multiple contracts simultaneously on pattern signals
            </p>
          </div>
          {/* Live price */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 900, color: ACCENT, fontVariantNumeric: 'tabular-nums' }}>
              {livePrice != null ? livePrice.toFixed(pipSizeRef.current) : '—'}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.4)' }}>LIVE PRICE</div>
          </div>
        </div>

        {/* ── Controls row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '0.75rem' }}>
          {/* Market */}
          <div className="bt-card">
            <div className="bt-label">Market</div>
            <select className="bt-select" value={symbol} onChange={e => setSymbol(e.target.value)}>
              {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
            </select>
          </div>

          {/* Trade Type */}
          <div className="bt-card">
            <div className="bt-label">Trade Type</div>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {(['even_odd', 'over_under'] as const).map(t => (
                <button
                  key={t}
                  className="type-chip"
                  onClick={() => setTradeType(t)}
                  style={{
                    flex: 1,
                    background: tradeType === t ? `${ACCENT}22` : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${tradeType === t ? ACCENT : 'rgba(255,255,255,0.1)'}`,
                    color: tradeType === t ? ACCENT : 'rgba(229,229,229,0.55)',
                  }}
                >
                  {t === 'even_odd' ? 'Even/Odd' : 'Over/Under'}
                </button>
              ))}
            </div>
          </div>

          {/* Barrier (Over/Under only) */}
          {tradeType === 'over_under' && (
            <div className="bt-card">
              <div className="bt-label">Barrier Digit</div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <button
                    key={d}
                    onClick={() => setBarrier(d)}
                    style={{
                      width: '28px', height: '28px', borderRadius: '6px',
                      border: `1px solid ${barrier === d ? DIGIT_COLORS[d] : 'rgba(255,255,255,0.1)'}`,
                      background: barrier === d ? `${DIGIT_COLORS[d]}22` : 'transparent',
                      color: barrier === d ? DIGIT_COLORS[d] : 'rgba(229,229,229,0.5)',
                      fontWeight: 800, fontSize: '0.8rem', cursor: 'pointer',
                    }}
                  >{d}</button>
                ))}
              </div>
            </div>
          )}

          {/* Stake */}
          <div className="bt-card">
            <div className="bt-label">Stake ({currency})</div>
            <input
              className="bt-input"
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              onChange={e => setStake(e.target.value)}
            />
          </div>

          {/* Trade count */}
          <div className="bt-card">
            <div className="bt-label">Trades per Signal</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {[1,3,5,10].map(n => (
                <button
                  key={n}
                  onClick={() => setTradeCount(n)}
                  style={{
                    flex: 1, padding: '0.45rem 0', borderRadius: '7px',
                    border: `1px solid ${tradeCount === n ? ACCENT : 'rgba(255,255,255,0.1)'}`,
                    background: tradeCount === n ? `${ACCENT}22` : 'rgba(255,255,255,0.04)',
                    color: tradeCount === n ? ACCENT : 'rgba(229,229,229,0.5)',
                    fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer',
                  }}
                >{n}</button>
              ))}
            </div>
          </div>

          {/* Tick history window */}
          <div className="bt-card">
            <div className="bt-label">Analysis Window</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {[30,60,100].map(n => (
                <button
                  key={n}
                  onClick={() => setTickHistory(n)}
                  style={{
                    flex: 1, padding: '0.45rem 0', borderRadius: '7px',
                    border: `1px solid ${tickHistory === n ? 'rgba(252,163,17,0.6)' : 'rgba(255,255,255,0.1)'}`,
                    background: tickHistory === n ? 'rgba(252,163,17,0.1)' : 'rgba(255,255,255,0.04)',
                    color: tickHistory === n ? '#FCA311' : 'rgba(229,229,229,0.5)',
                    fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer',
                  }}
                >{n}</button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Digit gauges ── */}
        <div className="bt-card">
          <div className="bt-label">Digit Distribution (last {tickHistory} ticks)</div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-around', flexWrap: 'wrap', paddingTop: '0.25rem' }}>
            {Array.from({ length: 10 }, (_, d) => (
              <DigitGauge
                key={d}
                digit={d}
                count={digitCounts[d]}
                total={totalTicks}
                liveDigit={liveDigit}
              />
            ))}
          </div>
        </div>

        {/* ── Last 60 digits stream ── */}
        <div className="bt-card">
          <div className="bt-label">Last 60 Digits</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', paddingTop: '0.25rem' }}>
            {recentDigits.slice(-60).map((d, i, arr) => (
              <span
                key={i}
                className="digit-stream-dot"
                style={{
                  background: i === arr.length - 1 ? DIGIT_COLORS[d] : `${DIGIT_COLORS[d]}22`,
                  color: i === arr.length - 1 ? '#000' : DIGIT_COLORS[d],
                  border: `1px solid ${DIGIT_COLORS[d]}44`,
                  transform: i === arr.length - 1 ? 'scale(1.2)' : 'none',
                  transition: 'transform 0.15s',
                }}
              >{d}</span>
            ))}
          </div>
        </div>

        {/* ── Manual trade buttons ── */}
        <div className="bt-card">
          <div className="bt-label">Manual Bulk Trade — fires {tradeCount} contracts simultaneously</div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {tradeType === 'even_odd' ? (
              <>
                <button
                  className="bt-btn"
                  disabled={isTrading}
                  onClick={() => handleManualTrade('DIGITEVEN')}
                  style={{ background: '#22c55e', color: '#000', flex: 1 }}
                >
                  {isTrading ? 'Trading…' : `▲ Even ×${tradeCount}`}
                </button>
                <button
                  className="bt-btn"
                  disabled={isTrading}
                  onClick={() => handleManualTrade('DIGITODD')}
                  style={{ background: '#ef4444', color: '#fff', flex: 1 }}
                >
                  {isTrading ? 'Trading…' : `▼ Odd ×${tradeCount}`}
                </button>
              </>
            ) : (
              <>
                <button
                  className="bt-btn"
                  disabled={isTrading}
                  onClick={() => handleManualTrade('DIGITOVER')}
                  style={{ background: '#22c55e', color: '#000', flex: 1 }}
                >
                  {isTrading ? 'Trading…' : `▲ Over ${barrier} ×${tradeCount}`}
                </button>
                <button
                  className="bt-btn"
                  disabled={isTrading}
                  onClick={() => handleManualTrade('DIGITUNDER')}
                  style={{ background: '#ef4444', color: '#fff', flex: 1 }}
                >
                  {isTrading ? 'Trading…' : `▼ Under ${barrier} ×${tradeCount}`}
                </button>
              </>
            )}

            {/* Total P&L */}
            {totalPnl !== 0 && (
              <div style={{
                padding: '0.55rem 1rem', borderRadius: '10px',
                background: totalPnl > 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                border: `1px solid ${totalPnl > 0 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                color: totalPnl > 0 ? '#22c55e' : '#ef4444',
                fontSize: '0.9rem', fontWeight: 800,
              }}>
                {totalPnl > 0 ? '+' : ''}{fmt2(totalPnl)} {currency}
              </div>
            )}
          </div>
          {tradeError && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#ef4444' }}>{tradeError}</p>
          )}
          {lastResult && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.82rem', color: lastResult.won ? '#22c55e' : '#ef4444' }}>
              {lastResult.won ? '✓ Win' : '✗ Loss'} — {lastResult.profit > 0 ? '+' : ''}{fmt2(lastResult.profit)} {currency}
            </p>
          )}
        </div>

        {/* ── AI Scanner strip ── */}
        <div className="bt-card" style={{ borderColor: scannerActive ? `${ACCENT}44` : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <div className="bt-label" style={{ marginBottom: '2px' }}>AI Pattern Scanner</div>
              <p style={{ margin: 0, fontSize: '0.76rem', color: 'rgba(229,229,229,0.45)' }}>
                Monitors {SCAN_SYMBOLS.length} markets simultaneously · 30s cooldown per market
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              {/* Status indicator */}
              <span style={{
                padding: '0.3rem 0.75rem', borderRadius: '20px', fontSize: '0.72rem', fontWeight: 700,
                background: scannerStatus === 'idle' ? 'rgba(255,255,255,0.06)'
                  : scannerStatus === 'scanning' ? 'rgba(0,229,204,0.1)'
                  : 'rgba(252,163,17,0.15)',
                color: scannerStatus === 'idle' ? 'rgba(229,229,229,0.4)'
                  : scannerStatus === 'scanning' ? ACCENT
                  : '#FCA311',
                border: `1px solid ${scannerStatus === 'idle' ? 'rgba(255,255,255,0.08)' : scannerStatus === 'scanning' ? `${ACCENT}44` : 'rgba(252,163,17,0.3)'}`,
              }}>
                {scannerStatus === 'idle' ? '● IDLE'
                  : scannerStatus === 'scanning' ? '◉ SCANNING'
                  : '⚡ FIRED'}
              </span>
              <button
                className="bt-btn"
                onClick={() => setScannerOpen(true)}
                style={{ background: 'rgba(255,255,255,0.07)', color: '#e5e5e5', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.8rem', padding: '0.45rem 0.9rem' }}
              >View Logs</button>
              <button
                className="bt-btn"
                onClick={scannerActive ? stopScanner : startScanner}
                style={{
                  background: scannerActive ? 'rgba(239,68,68,0.15)' : `${ACCENT}22`,
                  color: scannerActive ? '#ef4444' : ACCENT,
                  border: `1px solid ${scannerActive ? 'rgba(239,68,68,0.35)' : `${ACCENT}44`}`,
                  padding: '0.45rem 1rem',
                }}
              >
                {scannerActive ? '■ Stop' : '▶ Start'}
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* ── AI Scanner Modal ── */}
      {scannerOpen && (
        <div className="scanner-modal-bg" onClick={e => { if (e.target === e.currentTarget) setScannerOpen(false) }}>
          <div className="scanner-modal">
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.9rem 1.25rem',
              borderBottom: `1px solid ${ACCENT}33`,
              background: 'rgba(0,229,204,0.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ color: ACCENT, fontSize: '1rem' }}>⣿</span>
                <span style={{ color: ACCENT, fontWeight: 800, fontSize: '0.95rem', letterSpacing: '0.08em' }}>
                  AI BULK SCANNER
                </span>
                {scannerActive && (
                  <span style={{
                    width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e',
                    display: 'inline-block',
                    boxShadow: '0 0 8px #22c55e',
                    animation: 'scanPulse 1.2s ease-in-out infinite',
                  }} />
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="bt-btn"
                  onClick={scannerActive ? stopScanner : startScanner}
                  style={{
                    background: scannerActive ? 'rgba(239,68,68,0.15)' : `${ACCENT}22`,
                    color: scannerActive ? '#ef4444' : ACCENT,
                    border: `1px solid ${scannerActive ? 'rgba(239,68,68,0.3)' : `${ACCENT}44`}`,
                    fontSize: '0.8rem', padding: '0.35rem 0.8rem',
                  }}
                >{scannerActive ? '■ Stop' : '▶ Start'}</button>
                <button
                  onClick={() => setScannerOpen(false)}
                  style={{
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                    color: 'rgba(229,229,229,0.5)', borderRadius: '7px',
                    padding: '0.35rem 0.65rem', cursor: 'pointer', fontSize: '0.85rem',
                  }}
                >✕</button>
              </div>
            </div>

            {/* Terminal log */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '0.75rem 1rem',
              fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
              fontSize: '0.78rem', lineHeight: 1.7,
              background: '#040b0a',
            }}>
              {logLines.length === 0 ? (
                <p style={{ color: 'rgba(229,229,229,0.25)', margin: 0 }}>
                  {scannerActive ? 'Waiting for signals...' : 'Start the scanner to begin monitoring.'}
                </p>
              ) : (
                logLines.map(line => (
                  <div key={line.id} className={`log-line-${line.color}`}>
                    <span style={{ color: 'rgba(229,229,229,0.2)', marginRight: '0.5rem', fontSize: '0.7rem' }}>
                      {new Date(line.ts).toLocaleTimeString()}
                    </span>
                    {line.text}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div style={{
              padding: '0.6rem 1rem',
              borderTop: `1px solid ${ACCENT}22`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: '0.72rem', color: 'rgba(229,229,229,0.3)',
            }}>
              <span>Confidence threshold: 62% · Cooldown: 30s/market</span>
              <button
                onClick={() => setLogLines([])}
                style={{ background: 'transparent', border: 'none', color: 'rgba(229,229,229,0.3)', cursor: 'pointer', fontSize: '0.72rem' }}
              >Clear</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes scanPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
      `}</style>
    </>
  )
}
