'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { bg0, bg1, bdr, txt0, txt1, txt2 } from '@/lib/colors'

/**
 * Bulk Trader
 *
 * AI-powered multi-trade pattern scanner.
 * Monitors digit patterns across multiple Deriv synthetic markets
 * simultaneously and fires N bulk trades when a signal is detected.
 *
 * Supported contract types: Even/Odd, Over/Under
 *
 * WS pattern (identical to Speedbot):
 *  • Public ticks : wss://ws.binaryws.com/websockets/v3?app_id=1089
 *  • Bot / trade  : /api/user/ws-url → authorize with token → buy
 */

/* ── Constants ─────────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089'

const MARKETS = [
  { symbol: '1HZ100V',  label: 'Volatility 100 (1s) Index' },
  { symbol: '1HZ10V',   label: 'Volatility 10 (1s) Index'  },
  { symbol: '1HZ25V',   label: 'Volatility 25 (1s) Index'  },
  { symbol: '1HZ50V',   label: 'Volatility 50 (1s) Index'  },
  { symbol: '1HZ75V',   label: 'Volatility 75 (1s) Index'  },
  { symbol: 'R_10',     label: 'Volatility 10 Index'        },
  { symbol: 'R_25',     label: 'Volatility 25 Index'        },
  { symbol: 'R_50',     label: 'Volatility 50 Index'        },
  { symbol: 'R_75',     label: 'Volatility 75 Index'        },
  { symbol: 'R_100',    label: 'Volatility 100 Index'       },
  { symbol: 'BOOM1000', label: 'Boom 1000 Index'            },
  { symbol: 'BOOM500',  label: 'Boom 500 Index'             },
  { symbol: 'CRASH1000',label: 'Crash 1000 Index'           },
  { symbol: 'CRASH500', label: 'Crash 500 Index'            },
  { symbol: 'stpRNG',   label: 'Step Index'                 },
]

// Markets the AI scanner monitors simultaneously
const SCAN_SYMBOLS = ['1HZ100V', '1HZ75V', '1HZ50V', 'R_100', 'R_75']

const DIGIT_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#14b8a6',
  '#3b82f6','#8b5cf6','#ec4899','#06b6d4','#FCA311',
]

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function lastDigit(price: number, pipSize = 2): number {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}

/* ── Digit Gauge (circular SVG ring) ───────────────────────────────────────── */
function DigitGauge({ digit, count, total, color, isActive }: {
  digit:    number
  count:    number
  total:    number
  color:    string
  isActive: boolean   // true when this is the current last digit
}) {
  const r    = 27
  const circ = 2 * Math.PI * r
  const pct  = total ? count / total : 0
  const dash = pct * circ

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <div style={{ position: 'relative', width: 68, height: 68 }}>
        <svg width="68" height="68" style={{ transform: 'rotate(-90deg)' }}>
          {/* Track */}
          <circle cx="34" cy="34" r={r} fill="none"
            stroke={isActive ? `${color}30` : 'rgba(255,255,255,0.05)'}
            strokeWidth="5"
          />
          {/* Progress ring */}
          <circle cx="34" cy="34" r={r} fill="none"
            stroke={color}
            strokeWidth={isActive ? 6 : 4}
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.35s ease' }}
          />
        </svg>
        {/* Center label */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{
            fontSize: isActive ? 17 : 15,
            fontWeight: 900,
            color: isActive ? '#fff' : color,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
            textShadow: isActive ? `0 0 10px ${color}` : 'none',
            transition: 'all 0.2s',
          }}>
            {digit}
          </span>
          <span style={{ fontSize: 8, color: txt2, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
            {(pct * 100).toFixed(1)}%
          </span>
        </div>
      </div>
      <span style={{ fontSize: 9, color: txt2, fontVariantNumeric: 'tabular-nums' }}>
        {count}
      </span>
    </div>
  )
}

/* ── AI Scanner Modal ───────────────────────────────────────────────────────── */
function AiScannerModal({
  open, onClose,
  botReady, currency,
  stake, setStake,
  bulkCount, setBulkCount,
  logs, scanStatus,
  scanning, onStart, onStop,
}: {
  open:       boolean
  onClose:    () => void
  botReady:   boolean
  currency:   string
  stake:      string
  setStake:   (v: string) => void
  bulkCount:  string
  setBulkCount: (v: string) => void
  logs:       string[]
  scanStatus: string
  scanning:   boolean
  onStart:    () => void
  onStop:     () => void
}) {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  if (!open) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '1rem',
    }}>
      <div style={{
        width: '100%', maxWidth: 680,
        background: '#060d1a',
        border: '2px solid #00e5cc',
        borderRadius: 14,
        boxShadow: '0 0 60px rgba(0,229,204,0.25), 0 0 120px rgba(0,229,204,0.08)',
        overflow: 'hidden',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}>

        {/* Modal header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.8rem 1rem',
          background: 'rgba(0,229,204,0.06)',
          borderBottom: '1px solid rgba(0,229,204,0.18)',
        }}>
          <div>
            <div style={{
              fontSize: 9, fontWeight: 800, color: '#00e5cc',
              letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              AI MARKET MATRIX
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', marginTop: 2 }}>
              Analysis Dashboard — Digit Scanner
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 6,
            background: '#ef4444', border: 'none',
            color: '#fff', fontWeight: 800, fontSize: 15,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
          }}>×</button>
        </div>

        {/* Stake + Bulk count */}
        <div style={{ padding: '1rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          {[
            { key: 'stake',      label: 'STAKE',              value: stake,      set: setStake,      min: '0.35', max: '10000', step: '0.01' },
            { key: 'bulkCount',  label: 'NO. OF BULK TRADES', value: bulkCount,  set: setBulkCount,  min: '1',    max: '20',    step: '1'    },
          ].map(f => (
            <div key={f.key}>
              <div style={{
                display: 'inline-block',
                fontSize: 8, fontWeight: 800, color: '#00e5cc',
                letterSpacing: '0.1em', textTransform: 'uppercase',
                border: '1px solid rgba(0,229,204,0.35)',
                borderRadius: 3, padding: '2px 6px', marginBottom: 6,
              }}>
                {f.label}
              </div>
              <input
                type="number" min={f.min} max={f.max} step={f.step}
                value={f.value}
                onChange={e => f.set(e.target.value)}
                disabled={scanning}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: '#020810', border: '1px solid rgba(0,229,204,0.25)',
                  borderRadius: 6, color: '#fff',
                  fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                  padding: '0.55rem 0.75rem', outline: 'none',
                  textAlign: 'center',
                }}
              />
            </div>
          ))}
        </div>

        {/* Markets row */}
        <div style={{ padding: '0 1rem 0.6rem' }}>
          <div style={{
            display: 'inline-block',
            fontSize: 8, fontWeight: 800, color: '#00e5cc',
            letterSpacing: '0.1em', textTransform: 'uppercase',
            border: '1px solid rgba(0,229,204,0.35)',
            borderRadius: 3, padding: '2px 6px', marginBottom: 6,
          }}>
            MARKETS
          </div>
          <div style={{
            background: '#020810', border: '1px solid rgba(0,229,204,0.18)',
            borderRadius: 6, padding: '0.45rem 0.75rem',
            fontSize: 11, color: scanning ? '#00e5cc' : txt2,
            fontFamily: 'monospace',
          }}>
            {scanning
              ? `Scanning ${SCAN_SYMBOLS.join(', ')}...`
              : 'Waiting for scan data...'}
          </div>
        </div>

        {/* Terminal log */}
        <div style={{ padding: '0 1rem' }}>
          <div ref={logRef} style={{
            background: '#020810',
            border: '1px solid rgba(0,229,204,0.12)',
            borderRadius: 6,
            height: 178,
            overflowY: 'auto',
            padding: '0.7rem 0.8rem',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.65,
          }}>
            {logs.length === 0
              ? <span style={{ color: 'rgba(0,229,204,0.35)' }}>Awaiting scan initialization...</span>
              : logs.map((line, i) => {
                  const c = line.startsWith('[OK]')      ? '#00e5cc'
                          : line.startsWith('[WARNING]') ? '#FCA311'
                          : line.startsWith('[ERROR]') || line.startsWith('DANGER') ? '#ef4444'
                          : '#22c55e'
                  return <div key={i} style={{ color: c }}>{line}</div>
                })
            }
          </div>
        </div>

        {/* Status bar */}
        <div style={{ padding: '0.55rem 1rem' }}>
          <div style={{
            background: scanning ? 'rgba(0,229,204,0.07)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${scanning ? 'rgba(0,229,204,0.28)' : 'rgba(255,255,255,0.07)'}`,
            borderRadius: 6, padding: '0.4rem 0.75rem',
          }}>
            <div style={{
              fontSize: 8, fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: scanning ? '#00e5cc' : txt2,
            }}>
              {scanning ? 'SCANNING' : 'IDLE'}
            </div>
            <div style={{ fontSize: 11, color: scanning ? '#00e5cc' : txt2, marginTop: 2 }}>
              {scanStatus || 'Waiting for initialization...'}
            </div>
          </div>
        </div>

        {/* Start / Stop button */}
        <div style={{ padding: '0.4rem 1rem 1rem' }}>
          <button
            onClick={scanning ? onStop : onStart}
            disabled={!botReady && !scanning}
            style={{
              width: '100%', padding: '0.9rem',
              background: scanning
                ? 'linear-gradient(90deg, #00b8a3, #00e5cc)'
                : (!botReady ? 'rgba(255,255,255,0.04)' : 'rgba(0,229,204,0.12)'),
              border: `1px solid ${scanning ? '#00e5cc' : (!botReady ? 'rgba(255,255,255,0.1)' : 'rgba(0,229,204,0.3)')}`,
              borderRadius: 8,
              color: scanning ? '#000' : (!botReady ? txt2 : '#00e5cc'),
              fontWeight: 800, fontSize: 13,
              cursor: !botReady && !scanning ? 'not-allowed' : 'pointer',
              letterSpacing: '0.06em', textTransform: 'uppercase',
              transition: 'all 0.18s',
            }}
          >
            {scanning ? 'STOP SCANNER' : (!botReady ? 'Connecting…' : 'START SCANNER')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Page ───────────────────────────────────────────────────────────────────── */
export default function BulkTraderPage() {

  /* ── Config ── */
  const [symbol,     setSymbol]     = useState('R_100')
  const [tradeType,  setTradeType]  = useState<'DIGITEVEN' | 'DIGITOVER'>('DIGITEVEN')
  const [barrier,    setBarrier]    = useState(5)
  const [tickHistory,setTickHistory] = useState(120)

  /* ── Tick state ── */
  const [livePrice,    setLivePrice]    = useState<number | null>(null)
  const [recentDigits, setRecentDigits] = useState<number[]>([])
  const pipSizeRef = useRef(2)

  /* ── Bot state ── */
  const [botReady,     setBotReady]     = useState(false)
  const [botError,     setBotError]     = useState<string | null>(null)
  const [currency,     setCurrency]     = useState('USD')
  const [accountLabel, setAccountLabel] = useState('')

  /* ── Scanner state ── */
  const [scannerOpen,  setScannerOpen]  = useState(false)
  const [scanning,     setScanning]     = useState(false)
  const [scanLogs,     setScanLogs]     = useState<string[]>([])
  const [scanStatus,   setScanStatus]   = useState('Waiting for initialization...')
  const [stake,        setStake]        = useState('1.00')
  const [bulkCount,    setBulkCount]    = useState('5')

  /* ── Refs ── */
  const botWsRef        = useRef<WebSocket | null>(null)
  const scanWsRef       = useRef<WebSocket | null>(null)
  const scanningRef     = useRef(false)
  const intentionalClose = useRef(false)
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectCount  = useRef(0)
  const reqIdRef        = useRef(300)

  // Keep config in refs to avoid stale closures in WS handlers
  const symbolRef    = useRef('R_100')
  const tradeTypeRef = useRef<'DIGITEVEN' | 'DIGITOVER'>('DIGITEVEN')
  const barrierRef   = useRef(5)
  const stakeRef     = useRef('1.00')
  const bulkCountRef = useRef('5')
  const currencyRef  = useRef('USD')

  useEffect(() => { symbolRef.current    = symbol    }, [symbol])
  useEffect(() => { tradeTypeRef.current = tradeType }, [tradeType])
  useEffect(() => { barrierRef.current   = barrier   }, [barrier])
  useEffect(() => { stakeRef.current     = stake     }, [stake])
  useEffect(() => { bulkCountRef.current = bulkCount }, [bulkCount])
  useEffect(() => { currencyRef.current  = currency  }, [currency])

  /* ── Derived: digit counts ── */
  const total        = recentDigits.length
  const digitCounts  = Array.from({ length: 10 }, (_, d) => ({
    digit: d,
    count: recentDigits.filter(x => x === d).length,
  }))
  const currentDigit = recentDigits[recentDigits.length - 1] ?? null

  const evenCount  = recentDigits.filter(d => d % 2 === 0).length
  const oddCount   = total - evenCount
  const overCount  = recentDigits.filter(d => d > barrier).length
  const underCount = total - overCount

  /* ── Public WS: tick data ── */
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        end:    'latest',
        count:  tickHistory,
        style:  'ticks',
        subscribe: 1,
        req_id: 1,
      }))
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.msg_type === 'history') {
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps != null) pipSizeRef.current = ps
        const hist = (msg as { history: { prices: number[] } }).history.prices
        setRecentDigits(hist.map(p => lastDigit(Number(p), pipSizeRef.current)))
      }

      if (msg.msg_type === 'tick') {
        const t = (msg as { tick: { quote: number; pip_size?: number } }).tick
        if (t.pip_size != null) pipSizeRef.current = t.pip_size
        const q = t.quote
        setLivePrice(q)
        setRecentDigits(prev => [...prev.slice(-(tickHistory - 1)), lastDigit(q, pipSizeRef.current)])
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
  }, [symbol, tickHistory])

  /* ── Bot WS: authenticated trading ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    intentionalClose.current = false

    function backoff(n: number) { return Math.min(2000 * 2 ** n, 30_000) }

    async function connect() {
      setBotError(null)
      setBotReady(false)

      try {
        const r = await fetch('/api/user/balance', { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json() as {
            activeAccountId: string
            accounts: { accountId: string; currency: string; isDemo: boolean }[]
          }
          const acc = d.accounts.find(a => a.accountId === d.activeAccountId)
          if (acc) {
            setCurrency(acc.currency)
            currencyRef.current = acc.currency
            setAccountLabel(acc.isDemo ? 'Demo' : 'Real')
          }
        }
      } catch { /**/ }

      let wsUrl = ''
      let wsToken = ''
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) {
          if (r.status === 401) { intentionalClose.current = true; window.location.href = '/'; return }
          scheduleReconnect()
          return
        }
        ;({ wsUrl, token: wsToken } = await r.json() as { wsUrl: string; token: string })
      } catch {
        scheduleReconnect()
        return
      }

      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0
        ws!.send(JSON.stringify({ authorize: wsToken }))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30_000)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        // Authorize → ready
        if (msg.authorize) {
          setBotReady(true)
          setBotError(null)
          ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
          return
        }

        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          const fatal = ['AuthorizationRequired', 'InvalidToken', 'InvalidAppID']
          if (err.code && fatal.includes(err.code)) {
            intentionalClose.current = true
            setBotError('Session expired — please log in again.')
            return
          }
          // Non-fatal trade error: log to scanner
          addLog(`[ERROR] ${err.message ?? 'Trade error'}`)
          return
        }

        if (msg.msg_type === 'balance') {
          const b = (msg as { balance: { balance: number; currency: string } }).balance
          window.dispatchEvent(new CustomEvent('deriv-balance', {
            detail: { balance: b.balance, currency: b.currency },
          }))
        }

        if (msg.msg_type === 'buy') {
          const buy = msg.buy as { contract_id: number; buy_price: number }
          addLog(`[OK] Contract #${buy.contract_id} placed · ${buy.buy_price.toFixed(2)} ${currencyRef.current}`)
        }
      }

      ws.onerror = () => {}
      ws.onclose = () => {
        setBotReady(false)
        botWsRef.current = null
        if (ping) { clearInterval(ping); ping = null }
        if (!intentionalClose.current) {
          if (reconnectCount.current >= 5) {
            setBotError('Connection lost — please refresh.')
            return
          }
          const delay = backoff(reconnectCount.current++)
          setBotError(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`)
          scheduleReconnect(delay)
        }
      }
    }

    function scheduleReconnect(delay = 2000) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => { if (!intentionalClose.current) connect() }, delay)
    }

    connect()

    return () => {
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (ping) clearInterval(ping)
      ws?.close()
      botWsRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Add log line ── */
  const addLog = useCallback((line: string) => {
    setScanLogs(prev => [...prev.slice(-200), line])
  }, [])

  /* ── AI Pattern detection ── */
  const detectPattern = useCallback((
    digits: number[],
    tt: 'DIGITEVEN' | 'DIGITOVER',
    bar: number
  ): { signal: boolean; direction: string; confidence: number } => {
    if (digits.length < 20) return { signal: false, direction: '', confidence: 0 }
    const recent = digits.slice(-30)
    const n      = recent.length

    if (tt === 'DIGITEVEN') {
      const evenCount = recent.filter(d => d % 2 === 0).length
      const evenPct   = evenCount / n

      // Trailing streak of same parity
      const lastParity = recent[recent.length - 1] % 2
      let streak = 0
      for (let i = recent.length - 1; i >= 0 && recent[i] % 2 === lastParity; i--) streak++
      if (streak >= 5) {
        return { signal: true, direction: lastParity === 0 ? 'ODD' : 'EVEN', confidence: Math.min(55 + streak * 8, 96) }
      }

      if (evenPct > 0.66) return { signal: true, direction: 'ODD',  confidence: Math.round(evenPct   * 100) }
      if (evenPct < 0.34) return { signal: true, direction: 'EVEN', confidence: Math.round((1 - evenPct) * 100) }
      return { signal: false, direction: '', confidence: 0 }
    }

    if (tt === 'DIGITOVER') {
      const overCount = recent.filter(d => d > bar).length
      const overPct   = overCount / n

      // Trap analysis: digits ≤ 2 or ≥ 7
      const trapCount = recent.filter(d => d <= 2 || d >= 7).length
      const trapPct   = trapCount / n

      if (overPct > 0.68) return { signal: true, direction: 'UNDER', confidence: Math.round(overPct * 100) }
      if (overPct < 0.32) return { signal: true, direction: 'OVER',  confidence: Math.round((1 - overPct) * 100) }
      if (trapPct > 0.70) {
        return { signal: true, direction: bar >= 5 ? 'OVER' : 'UNDER', confidence: Math.round(trapPct * 88) }
      }
      return { signal: false, direction: '', confidence: 0 }
    }

    return { signal: false, direction: '', confidence: 0 }
  }, [])

  /* ── Fire N bulk trades ── */
  const fireBulkTrades = useCallback((direction: string, mktSymbol: string) => {
    const ws = botWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const amount = parseFloat(stakeRef.current) || 1.00
    const count  = Math.min(parseInt(bulkCountRef.current) || 5, 20)
    const bar    = barrierRef.current
    const cur    = currencyRef.current

    const ct = direction === 'EVEN'  ? 'DIGITEVEN'
             : direction === 'ODD'   ? 'DIGITODD'
             : direction === 'OVER'  ? 'DIGITOVER'
             : direction === 'UNDER' ? 'DIGITUNDER'
             : 'DIGITEVEN'

    const needsBarrier = ct === 'DIGITOVER' || ct === 'DIGITUNDER'

    addLog(`[OK] FIRING ${count}× ${direction} on ${mktSymbol} @ ${amount.toFixed(2)} ${cur}`)

    for (let i = 0; i < count; i++) {
      ws.send(JSON.stringify({
        buy:    '1',
        price:  1000,
        req_id: ++reqIdRef.current,
        parameters: {
          contract_type:     ct,
          underlying_symbol: mktSymbol,
          duration:          1,
          duration_unit:     't',
          amount,
          basis:             'stake',
          currency:          cur,
          ...(needsBarrier ? { barrier: String(bar) } : {}),
        },
      }))
    }
  }, [addLog])

  /* ── Start scanner ── */
  const startScanner = useCallback(async () => {
    if (scanningRef.current) return

    setScanLogs([])
    setScanStatus('Initializing scanner...')
    setScanning(true)
    scanningRef.current = true

    addLog('[OK] Synthetic stream linked')
    addLog('[INFO] Reading volatility clusters...')

    const scanWs = new WebSocket(PUBLIC_WS_URL)
    scanWsRef.current = scanWs

    const scanDigits: Record<string, number[]>  = {}
    const scanPips:   Record<string, number>    = {}
    const cooldown:   Record<string, number>    = {}  // prevent re-firing for 30s after signal
    SCAN_SYMBOLS.forEach(s => { scanDigits[s] = []; scanPips[s] = 2; cooldown[s] = 0 })

    let reqId = 500

    scanWs.onopen = () => {
      addLog('[INFO] Checking last digit sequence...')
      addLog('[OK] Pattern scanner armed')
      addLog('[INFO] Searching last 4 <= 2 and >= 7 traps...')
      addLog('[INFO] Compiling trade route...')
      addLog(`[INFO] Scanning digit patterns on ${SCAN_SYMBOLS.length} Volatility markets...`)
      setScanStatus('Scanning live markets...')

      SCAN_SYMBOLS.forEach(sym => {
        scanWs.send(JSON.stringify({
          ticks_history: sym,
          end:     'latest',
          count:   50,
          style:   'ticks',
          subscribe: 1,
          req_id:  ++reqId,
        }))
      })
    }

    scanWs.onmessage = (ev) => {
      if (!scanningRef.current) return
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.msg_type === 'history') {
        const echo = msg.echo_req as { ticks_history?: string }
        const sym  = echo?.ticks_history
        if (!sym || !scanDigits[sym]) return
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps) scanPips[sym] = ps
        const hist = (msg as { history: { prices: number[] } }).history.prices
        scanDigits[sym] = hist.map(p => lastDigit(Number(p), scanPips[sym]))
        addLog(`[INFO] ${sym}: ${hist.length} ticks loaded`)
      }

      if (msg.msg_type === 'tick') {
        const t   = (msg as { tick: { symbol: string; quote: number; pip_size?: number } }).tick
        const sym = t.symbol
        if (!sym || scanDigits[sym] === undefined) return
        if (t.pip_size) scanPips[sym] = t.pip_size
        const d = lastDigit(t.quote, scanPips[sym])
        scanDigits[sym] = [...scanDigits[sym].slice(-49), d]

        // Run pattern detection on all scanned markets
        const now = Date.now()
        SCAN_SYMBOLS.forEach(s => {
          if (scanDigits[s].length < 20) return
          if (now - (cooldown[s] ?? 0) < 30_000) return  // 30s cooldown per market

          const result = detectPattern(scanDigits[s], tradeTypeRef.current, barrierRef.current)
          if (result.signal && result.confidence >= 62) {
            cooldown[s] = now
            addLog(`[WARNING] Signal pressure rising on ${s}`)
            addLog(`DANGER TI TI TI TI...`)
            addLog(`[OK] Pattern → ${result.direction} on ${s} (${result.confidence}% confidence)`)
            fireBulkTrades(result.direction, s)
            // Reset digits so same pattern doesn't re-trigger immediately
            scanDigits[s] = []
          }
        })
      }
    }

    scanWs.onerror = () => {
      addLog('[ERROR] Scanner connection error')
      setScanStatus('Scanner error — check connection')
    }

    scanWs.onclose = () => {
      if (scanningRef.current) {
        addLog('[WARNING] Scanner stream closed')
        setScanStatus('Scanner disconnected')
        setScanning(false)
        scanningRef.current = false
      }
    }
  }, [addLog, detectPattern, fireBulkTrades])

  /* ── Stop scanner ── */
  const stopScanner = useCallback(() => {
    scanningRef.current = false
    setScanning(false)
    setScanStatus('Scanner stopped')
    addLog('[INFO] Scanner stopped by user')
    if (scanWsRef.current) {
      try {
        if (scanWsRef.current.readyState === WebSocket.OPEN)
          scanWsRef.current.send(JSON.stringify({ forget_all: 'ticks', req_id: 9998 }))
        scanWsRef.current.close()
      } catch { /**/ }
      scanWsRef.current = null
    }
  }, [addLog])

  // Cleanup scanner on unmount
  useEffect(() => () => {
    scanningRef.current = false
    try { scanWsRef.current?.close() } catch { /**/ }
  }, [])

  /* ── Shared styles ── */
  const inputSt: React.CSSProperties = {
    background: bg1, border: `1px solid ${bdr}`,
    borderRadius: 8, color: txt0, fontSize: '0.82rem',
    padding: '0.45rem 0.65rem', width: '100%', outline: 'none',
    boxSizing: 'border-box',
  }
  const labelSt: React.CSSProperties = {
    fontSize: '0.62rem', fontWeight: 700, color: txt2,
    textTransform: 'uppercase', letterSpacing: '0.07em',
    display: 'block', marginBottom: '0.3rem',
  }
  const cardSt: React.CSSProperties = {
    background: bg1, border: `1px solid ${bdr}`, borderRadius: 12, padding: '1rem',
  }

  const isOverUnder = tradeType === 'DIGITOVER'

  /* ── Render ── */
  return (
    <div style={{ background: bg0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.85rem 1.5rem',
        borderBottom: `1px solid ${bdr}`,
        background: bg1, flexShrink: 0,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: txt0, letterSpacing: '-0.01em' }}>
            Bulk Trader
          </h1>
          <p style={{ margin: 0, fontSize: '0.7rem', color: txt2, marginTop: 1 }}>
            AI-powered multi-trade digit pattern scanner
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          {livePrice != null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.58rem', color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#FCA311', fontVariantNumeric: 'tabular-nums' }}>
                {livePrice.toFixed(pipSizeRef.current)}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: botError ? '#ef4444' : botReady ? '#22c55e' : '#FCA311',
              boxShadow: botReady && !botError ? '0 0 6px #22c55e88' : 'none',
            }} />
            <span style={{ fontSize: '0.72rem', color: txt2 }}>
              {botError ? 'Error' : botReady ? `${accountLabel || 'Connected'} · ${currency}` : 'Connecting…'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Error banner ── */}
      {botError && (
        <div style={{
          padding: '0.55rem 1.5rem',
          background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)',
          color: '#fca5a5', fontSize: '0.78rem', flexShrink: 0,
        }}>
          ⚠ {botError}
        </div>
      )}

      {/* ── Body ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        flex: 1, minHeight: 0, overflow: 'hidden',
      }}>

        {/* ════ LEFT: Config ════ */}
        <div style={{
          borderRight: `1px solid ${bdr}`,
          overflowY: 'auto',
          padding: '1.25rem 1rem',
          display: 'flex', flexDirection: 'column', gap: '1rem',
          background: bg0,
        }}>

          {/* Market + Trade Type */}
          <div style={cardSt}>
            <span style={labelSt}>Market</span>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              style={{ ...inputSt, cursor: 'pointer', marginBottom: '0.75rem' }}
            >
              {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
            </select>

            <span style={labelSt}>Trade Type</span>
            <select
              value={tradeType}
              onChange={e => setTradeType(e.target.value as 'DIGITEVEN' | 'DIGITOVER')}
              style={{ ...inputSt, cursor: 'pointer', marginBottom: isOverUnder ? '0.75rem' : 0 }}
            >
              <option value="DIGITEVEN">Even / Odd</option>
              <option value="DIGITOVER">Over / Under</option>
            </select>

            {isOverUnder && (
              <>
                <span style={labelSt}>Barrier Digit</span>
                <select
                  value={barrier}
                  onChange={e => setBarrier(parseInt(e.target.value))}
                  style={{ ...inputSt, cursor: 'pointer' }}
                >
                  {[0,1,2,3,4,5,6,7,8,9].map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </>
            )}
          </div>

          {/* Tick history */}
          <div style={cardSt}>
            <span style={labelSt}>Ticks to Track</span>
            <input
              type="number" min="20" max="500" step="10"
              value={tickHistory}
              onChange={e => setTickHistory(Math.max(20, Math.min(500, parseInt(e.target.value) || 120)))}
              style={inputSt}
            />
            <div style={{ marginTop: 5, fontSize: 10, color: txt2 }}>
              Showing last {total} ticks
            </div>
          </div>

          {/* Pattern summary */}
          <div style={cardSt}>
            <span style={labelSt}>Live Pattern</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {!isOverUnder ? (
                <>
                  <StatBox label={`Even (${evenCount})`} value={total ? (evenCount/total*100).toFixed(1)+'%' : '—'} color="#FCA311" />
                  <StatBox label={`Odd (${oddCount})`}  value={total ? (oddCount/total*100).toFixed(1)+'%'  : '—'} color="#ef4444" />
                </>
              ) : (
                <>
                  <StatBox label={`Over ${barrier} (${overCount})`}   value={total ? (overCount/total*100).toFixed(1)+'%'  : '—'} color="#22c55e" />
                  <StatBox label={`Under ${barrier} (${underCount})`} value={total ? (underCount/total*100).toFixed(1)+'%' : '—'} color="#3b82f6" />
                </>
              )}
            </div>
          </div>

          {/* AI Scanner launch button */}
          <button
            onClick={() => setScannerOpen(true)}
            style={{
              padding: '0.9rem',
              background: scanning
                ? 'rgba(0,229,204,0.12)'
                : 'linear-gradient(135deg, rgba(0,229,204,0.12), rgba(0,229,204,0.04))',
              border: `1px solid ${scanning ? 'rgba(0,229,204,0.5)' : 'rgba(0,229,204,0.3)'}`,
              borderRadius: 10,
              color: '#00e5cc',
              fontWeight: 800, fontSize: '0.85rem',
              cursor: 'pointer',
              letterSpacing: '0.05em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.18s',
              boxShadow: scanning ? '0 0 16px rgba(0,229,204,0.15)' : 'none',
            }}
          >
            <span style={{ fontSize: '1rem' }}>🤖</span>
            <span>AI Scanner</span>
            {scanning && (
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: '#00e5cc',
                boxShadow: '0 0 8px #00e5cc',
                animation: 'bt-pulse 1s ease infinite',
              }} />
            )}
          </button>

          {/* Scanner status strip (if active) */}
          {scanning && (
            <div style={{
              background: 'rgba(0,229,204,0.05)',
              border: '1px solid rgba(0,229,204,0.18)',
              borderRadius: 10, padding: '0.7rem 0.85rem',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: '#00e5cc', boxShadow: '0 0 8px #00e5cc',
                animation: 'bt-pulse 1s ease infinite',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#00e5cc', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  SCANNER ACTIVE
                </div>
                <div style={{ fontSize: 10, color: txt2, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {scanStatus}
                </div>
              </div>
              <button
                onClick={stopScanner}
                style={{
                  padding: '0.28rem 0.7rem', flexShrink: 0,
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.28)',
                  borderRadius: 6, color: '#ef4444',
                  fontSize: 10, fontWeight: 700, cursor: 'pointer',
                }}
              >
                Stop
              </button>
            </div>
          )}
        </div>

        {/* ════ RIGHT: Digit gauges + tick stream ════ */}
        <div style={{ overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Current tick hero */}
          <div style={{
            ...cardSt,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '1rem 1.5rem',
          }}>
            <div>
              <div style={{ fontSize: 10, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
                Current Tick · {MARKETS.find(m => m.symbol === symbol)?.label ?? symbol}
              </div>
              <div style={{ fontSize: 34, fontWeight: 900, color: '#FCA311', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {livePrice != null ? livePrice.toFixed(pipSizeRef.current) : <span style={{ color: txt2, fontSize: 20 }}>Loading…</span>}
              </div>
            </div>
            {currentDigit !== null && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
                  Last Digit
                </div>
                <div style={{
                  fontSize: 56, fontWeight: 900, lineHeight: 1,
                  color: DIGIT_COLORS[currentDigit],
                  textShadow: `0 0 20px ${DIGIT_COLORS[currentDigit]}80`,
                }}>
                  {currentDigit}
                </div>
              </div>
            )}
          </div>

          {/* Digit distribution gauges */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14 }}>
              Digit Distribution · Last {total} ticks
            </div>
            {total === 0 ? (
              <div style={{ color: txt2, fontSize: '0.8rem', padding: '1rem 0' }}>Waiting for tick data…</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 10 }}>
                {digitCounts.map(({ digit, count }) => (
                  <DigitGauge
                    key={digit}
                    digit={digit}
                    count={count}
                    total={total}
                    color={DIGIT_COLORS[digit]}
                    isActive={digit === currentDigit}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Recent digit stream */}
          <div style={cardSt}>
            <div style={{ fontSize: 10, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>
              Last 60 Digits
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {recentDigits.slice(-60).map((d, i, arr) => {
                const isLast = i === arr.length - 1
                return (
                  <div key={i} style={{
                    width: 26, height: 26, borderRadius: 6,
                    background: isLast ? `${DIGIT_COLORS[d]}28` : `${DIGIT_COLORS[d]}0e`,
                    border:     `1.5px solid ${DIGIT_COLORS[d]}${isLast ? 'cc' : '40'}`,
                    color:      DIGIT_COLORS[d],
                    fontSize:   11, fontWeight: isLast ? 900 : 700,
                    display:    'flex', alignItems: 'center', justifyContent: 'center',
                    transform:  isLast ? 'scale(1.18)' : 'scale(1)',
                    transition: 'transform 0.1s',
                    boxShadow:  isLast ? `0 0 8px ${DIGIT_COLORS[d]}60` : 'none',
                  }}>
                    {d}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Recent scanner logs (last 8 lines, read-only preview) */}
          {scanLogs.length > 0 && (
            <div style={{ ...cardSt, padding: '0.85rem 1rem' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                Scanner Log
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.7 }}>
                {scanLogs.slice(-8).map((line, i) => {
                  const c = line.startsWith('[OK]')      ? '#00e5cc'
                          : line.startsWith('[WARNING]') ? '#FCA311'
                          : line.startsWith('[ERROR]') || line.startsWith('DANGER') ? '#ef4444'
                          : '#22c55e'
                  return <div key={i} style={{ color: c }}>{line}</div>
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── AI Scanner Modal ── */}
      <AiScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        botReady={botReady}
        currency={currency}
        stake={stake}
        setStake={setStake}
        bulkCount={bulkCount}
        setBulkCount={setBulkCount}
        logs={scanLogs}
        scanStatus={scanStatus}
        scanning={scanning}
        onStart={startScanner}
        onStop={stopScanner}
      />

      <style>{`
        @keyframes bt-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0,229,204,0.5); }
          50%       { opacity: 0.8; box-shadow: 0 0 0 5px rgba(0,229,204,0); }
        }
      `}</style>
    </div>
  )
}

/* ── Small stat box ─────────────────────────────────────────────────────────── */
function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: `${color}0d`,
      border:     `1px solid ${color}28`,
      borderRadius: 8, padding: '0.55rem 0.65rem', textAlign: 'center',
    }}>
      <div style={{ fontSize: 17, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: txt2, marginTop: 2 }}>{label}</div>
    </div>
  )
}
