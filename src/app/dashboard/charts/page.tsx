'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Manual Trader — full-featured manual trading interface
 *
 * Deriv API (verified against schemas):
 *  Public WS  : wss://api.derivws.com/trading/v1/options/ws/public
 *    ticks_history : subscribe:1, style:'ticks', count:100  → pip_size on history + tick
 *
 *  Auth WS    : OTP URL from /api/user/ws-url
 *    proposal              : contract_type, underlying_symbol, duration, duration_unit,
 *                            amount, basis:'stake', currency, barrier? (digit string for
 *                            OVER/UNDER/MATCH/DIFF; relative e.g. "+0.10" for TOUCH)
 *    buy                   : { buy: proposal_id, price: ask_price * 1.02 }
 *    sell                  : { sell: contract_id, price: 0 }  (price:0 = market sell)
 *    transaction           : { transaction:1, subscribe:1 }   detect buys & sells
 *    proposal_open_contract: { proposal_open_contract:1, subscribe:1 }  ← no contract_id
 *                            → streams ALL open positions; schema confirms optional contract_id
 *    profit_table          : { profit_table:1, description:1, limit:25, sort:'DESC' }
 *    balance               : { balance:1, subscribe:1 }
 *    forget_all            : 'proposal' before each resubscription cycle
 */

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'
const MAX_RECONNECT  = 5

const MARKETS = [
  { symbol: 'R_10',      label: 'Volatility 10 Index'        },
  { symbol: 'R_25',      label: 'Volatility 25 Index'        },
  { symbol: 'R_50',      label: 'Volatility 50 Index'        },
  { symbol: 'R_75',      label: 'Volatility 75 Index'        },
  { symbol: 'R_100',     label: 'Volatility 100 Index'       },
  { symbol: '1HZ10V',    label: 'Volatility 10 (1s) Index'  },
  { symbol: '1HZ25V',    label: 'Volatility 25 (1s) Index'  },
  { symbol: '1HZ50V',    label: 'Volatility 50 (1s) Index'  },
  { symbol: '1HZ75V',    label: 'Volatility 75 (1s) Index'  },
  { symbol: '1HZ100V',   label: 'Volatility 100 (1s) Index' },
  { symbol: 'BOOM1000',  label: 'Boom 1000 Index'           },
  { symbol: 'BOOM500',   label: 'Boom 500 Index'            },
  { symbol: 'CRASH1000', label: 'Crash 1000 Index'          },
  { symbol: 'CRASH500',  label: 'Crash 500 Index'           },
  { symbol: 'stpRNG',    label: 'Step Index'                },
  { symbol: 'JD10',      label: 'Jump 10 Index'             },
  { symbol: 'JD25',      label: 'Jump 25 Index'             },
  { symbol: 'JD50',      label: 'Jump 50 Index'             },
  { symbol: 'JD75',      label: 'Jump 75 Index'             },
  { symbol: 'JD100',     label: 'Jump 100 Index'            },
]

type TradeCategory = 'riseFall' | 'digits' | 'touch'

// For rise/fall we subscribe both CALL + PUT simultaneously (req_id 10 & 11)
// For digits and touch we subscribe only the selected type (req_id 10)
const DIGIT_BARRIER_TYPES = new Set(['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'])

const CONTRACT_LABELS: Record<string, string> = {
  CALL:       'Rise',
  PUT:        'Fall',
  DIGITEVEN:  'Even',
  DIGITODD:   'Odd',
  DIGITOVER:  'Over',
  DIGITUNDER: 'Under',
  DIGITMATCH: 'Match',
  DIGITDIFF:  'Differ',
  ONETOUCH:   'One Touch',
  NOTOUCH:    'No Touch',
}

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface ProposalSnap {
  id:        string
  ask_price: number
  payout:    number
  error?:    string
}

interface OpenPos {
  contract_id:     number
  contract_type:   string
  underlying:      string
  buy_price:       number
  payout:          number
  profit:          number
  status:          string   // 'open' | 'won' | 'lost' | 'sold'
  is_sold:         number
  is_valid_to_sell:number
  currency:        string
  purchase_time:   number
  longcode:        string
  subId:           string   // subscription id for forget
  settling?:       boolean  // true briefly after is_sold=1 so we can show result
}

interface HistRow {
  contract_id:     number
  contract_type:   string
  underlying:      string
  buy_price:       number
  sell_price:      number
  purchase_time:   number
  sell_time:       number | null
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function fmt2(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function lastDigit(price: number, pipSize = 2): number {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}

function fmtTime(epoch: number) {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/* ─── PriceChart (canvas, same pattern as Speedbot) ─────────────────────── */
function PriceChart({ prices, livePrice, label }: {
  prices:     number[]
  livePrice:  number | null
  label:      string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visible   = prices.slice(-300)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || visible.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    canvas.width  = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    const lo = Math.min(...visible)
    const hi = Math.max(...visible)
    const range = hi - lo || 1
    const padL = 58, padR = 14, padT = 10, padB = 20
    const cW = W - padL - padR
    const cH = H - padT - padB
    const xOf = (i: number) => padL + (i / (visible.length - 1)) * cW
    const yOf = (p: number) => padT + (1 - (p - lo) / range) * cH

    ctx.fillStyle = '#060f1c'
    ctx.fillRect(0, 0, W, H)

    const gridLines = 4
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (i / gridLines) * cH
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
      const v = hi - (i / gridLines) * range
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '10px monospace'
      ctx.textAlign = 'right'
      ctx.fillText(v.toFixed(2), padL - 4, y + 4)
    }

    const vStep = Math.max(1, Math.floor(visible.length / 6))
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    for (let i = 0; i < visible.length; i += vStep) {
      ctx.beginPath(); ctx.moveTo(xOf(i), padT); ctx.lineTo(xOf(i), padT + cH); ctx.stroke()
    }

    const grad = ctx.createLinearGradient(0, padT, 0, padT + cH)
    grad.addColorStop(0, 'rgba(252,163,17,0.2)')
    grad.addColorStop(1, 'rgba(252,163,17,0)')
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(visible[0]))
    for (let i = 1; i < visible.length; i++) ctx.lineTo(xOf(i), yOf(visible[i]))
    ctx.lineTo(xOf(visible.length - 1), padT + cH)
    ctx.lineTo(xOf(0), padT + cH)
    ctx.closePath()
    ctx.fillStyle = grad; ctx.fill()

    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(visible[0]))
    for (let i = 1; i < visible.length; i++) ctx.lineTo(xOf(i), yOf(visible[i]))
    ctx.strokeStyle = '#FCA311'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke()

    if (livePrice != null) {
      const ly = yOf(livePrice)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(239,68,68,0.5)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#ef4444'
      ctx.fillRect(W - padR + 2, ly - 7, 52, 14)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'left'
      ctx.fillText(livePrice.toFixed(2), W - padR + 5, ly + 3.5)
    }

    const lx = xOf(visible.length - 1)
    const ly2 = yOf(visible[visible.length - 1])
    ctx.beginPath(); ctx.arc(lx, ly2, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#FCA311'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()

  }, [visible, livePrice])

  return (
    <div style={{ background: '#060f1c', borderRadius: '10px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 12px 5px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {label}
        </span>
        <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.22)' }}>
          last {Math.min(prices.length, 300)} ticks
        </span>
      </div>
      {prices.length < 2 ? (
        <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.78rem' }}>
          Waiting for tick data…
        </div>
      ) : (
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '180px' }} />
      )}
    </div>
  )
}

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function ManualTraderPage() {

  /* ── Config state ── */
  const [symbol,      setSymbol]     = useState('R_100')
  const [category,    setCategory]   = useState<TradeCategory>('riseFall')
  const [digitType,   setDigitType]  = useState('DIGITEVEN')
  const [touchType,   setTouchType]  = useState('ONETOUCH')
  const [digitBa,     setDigitBa]    = useState(5)   // barrier digit 0-9
  const [touchBa,     setTouchBa]    = useState('+0.10')  // relative barrier for touch
  const [duration,    setDuration]   = useState(5)
  const [durUnit,     setDurUnit]    = useState<'t' | 'm' | 'h'>('t')
  const [stake,       setStake]      = useState('1.00')
  const [currency,    setCurrency]   = useState('USD')
  const [accountLabel,setAccountLabel] = useState('')

  /* ── WS / bot state ── */
  const [wsReady,     setWsReady]    = useState(false)
  const [wsError,     setWsError]    = useState<string | null>(null)
  const [buying,      setBuying]     = useState<string | null>(null)  // contract_type being bought

  /* ── Proposals ── */
  const [callProp,    setCallProp]   = useState<ProposalSnap | null>(null) // CALL / primary
  const [putProp,     setPutProp]    = useState<ProposalSnap | null>(null) // PUT  / secondary

  /* ── Tick data ── */
  const [prices,      setPrices]     = useState<number[]>([])
  const [livePrice,   setLivePrice]  = useState<number | null>(null)
  const [recentDigits,setRecentDigits] = useState<number[]>([])

  /* ── Portfolio ── */
  const [openPositions, setOpenPositions] = useState<Map<number, OpenPos>>(new Map())
  const [history,       setHistory]       = useState<HistRow[]>([])
  const [histLoading,   setHistLoading]   = useState(false)

  /* ── Refs ── */
  const botWsRef         = useRef<WebSocket | null>(null)
  const pipSizeRef       = useRef(2)
  const reqIdRef         = useRef(200)
  const reconnectCount   = useRef(0)
  const reconnectTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalClose = useRef(false)
  const pocSubIdRef      = useRef<string | null>(null)

  // Prop refs to avoid stale closures
  const callPropRef   = useRef<ProposalSnap | null>(null)
  const putPropRef    = useRef<ProposalSnap | null>(null)
  const symbolRef     = useRef('R_100')
  const categoryRef   = useRef<TradeCategory>('riseFall')
  const digitTypeRef  = useRef('DIGITEVEN')
  const touchTypeRef  = useRef('ONETOUCH')
  const digitBaRef    = useRef(5)
  const touchBaRef    = useRef('+0.10')
  const durationRef   = useRef(5)
  const durUnitRef    = useRef<'t'|'m'|'h'>('t')
  const stakeRef      = useRef('1.00')
  const currencyRef   = useRef('USD')
  const wsReadyRef    = useRef(false)

  // keep refs in sync
  useEffect(() => { callPropRef.current  = callProp  }, [callProp])
  useEffect(() => { putPropRef.current   = putProp   }, [putProp])
  useEffect(() => { symbolRef.current    = symbol    }, [symbol])
  useEffect(() => { categoryRef.current  = category  }, [category])
  useEffect(() => { digitTypeRef.current = digitType }, [digitType])
  useEffect(() => { touchTypeRef.current = touchType }, [touchType])
  useEffect(() => { digitBaRef.current   = digitBa   }, [digitBa])
  useEffect(() => { touchBaRef.current   = touchBa   }, [touchBa])
  useEffect(() => { durationRef.current  = duration  }, [duration])
  useEffect(() => { durUnitRef.current   = durUnit   }, [durUnit])
  useEffect(() => { stakeRef.current     = stake     }, [stake])
  useEffect(() => { currencyRef.current  = currency  }, [currency])
  useEffect(() => { wsReadyRef.current   = wsReady   }, [wsReady])

  /* ── Public WS — ticks ── */
  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol, end: 'latest', count: 150, style: 'ticks', subscribe: 1, req_id: 1,
      }))
    }
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.msg_type === 'history') {
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps != null) pipSizeRef.current = ps
        const hist = (msg as { history: { prices: number[] } }).history.prices
        const digits = hist.map(p => lastDigit(Number(p), pipSizeRef.current))
        setRecentDigits(digits.slice(-30))
        setPrices(hist.map(Number))
        setLivePrice(hist[hist.length - 1] ? Number(hist[hist.length - 1]) : null)
      }

      if (msg.msg_type === 'tick') {
        const td = (msg as { tick: { quote: number; pip_size: number } }).tick
        if (td.pip_size != null) pipSizeRef.current = td.pip_size
        const q = td.quote
        setLivePrice(q)
        setRecentDigits(prev => [...prev.slice(-29), lastDigit(q, pipSizeRef.current)])
        setPrices(prev => [...prev.slice(-499), q])
      }
    }
    ws.onerror = () => {}
    ws.onclose = () => {}
    return () => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 9999 })) } catch { /**/ }
      ws.close()
      setPrices([])
      setLivePrice(null)
    }
  }, [symbol])

  /* ── Proposal resubscription ── */
  const resubscribeProposals = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    // Forget all current proposal subscriptions before re-subscribing
    ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 9994 }))
    setCallProp(null)
    setPutProp(null)
    callPropRef.current = null
    putPropRef.current  = null

    const base = {
      proposal:           1,
      subscribe:          1,
      amount:             parseFloat(stakeRef.current) || 1,
      basis:              'stake',
      currency:           currencyRef.current,
      underlying_symbol:  symbolRef.current,
    }
    const cat = categoryRef.current

    if (cat === 'riseFall') {
      // CALL (req_id 10) + PUT (req_id 11)
      const dur = durationRef.current
      const du  = durUnitRef.current
      ws.send(JSON.stringify({ ...base, contract_type: 'CALL', duration: dur, duration_unit: du, req_id: 10 }))
      ws.send(JSON.stringify({ ...base, contract_type: 'PUT',  duration: dur, duration_unit: du, req_id: 11 }))
    } else if (cat === 'digits') {
      const dt  = digitTypeRef.current
      const dur = durationRef.current
      const payload: Record<string, unknown> = {
        ...base, contract_type: dt, duration: dur, duration_unit: 't', req_id: 10,
      }
      // barrier is required for OVER/UNDER/MATCH/DIFF — send as string per schema
      if (DIGIT_BARRIER_TYPES.has(dt)) payload.barrier = String(digitBaRef.current)
      ws.send(JSON.stringify(payload))
    } else if (cat === 'touch') {
      const tt  = touchTypeRef.current
      const dur = durationRef.current
      const du  = durUnitRef.current === 't' ? 'm' : durUnitRef.current
      ws.send(JSON.stringify({
        ...base, contract_type: tt, duration: dur, duration_unit: du,
        barrier: touchBaRef.current, req_id: 10,
      }))
    }
  }, [])

  /* ── Fetch profit_table ── */
  const fetchHistory = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    setHistLoading(true)
    ws.send(JSON.stringify({ profit_table: 1, description: 1, limit: 25, sort: 'DESC', req_id: 500 }))
  }, [])

  /* ── Auth WS lifecycle ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    intentionalClose.current = false

    function backoff(n: number) { return Math.min(2000 * 2 ** n, 30_000) }

    async function connect() {
      setWsError(null)
      setWsReady(false)
      wsReadyRef.current = false

      // Get account info
      try {
        const r = await fetch('/api/user/balance', { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json() as {
            activeAccountId: string
            accounts: { accountId: string; currency: string; isDemo: boolean }[]
          }
          const acc = d.accounts.find(a => a.accountId === d.activeAccountId)
          if (acc) {
            setCurrency(acc.currency); currencyRef.current = acc.currency
            setAccountLabel(acc.isDemo ? 'Demo' : 'Real')
          }
        }
      } catch { /* non-fatal */ }

      // Get WS URL
      let wsUrl = ''
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) {
          if (r.status === 401) { intentionalClose.current = true; window.location.href = '/'; return }
          setWsError('Connection failed — retrying…'); scheduleReconnect(); return
        }
        ;({ wsUrl } = await r.json() as { wsUrl: string })
      } catch {
        setWsError('Network error — retrying…'); scheduleReconnect(); return
      }

      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0
        setWsError(null)
        setWsReady(true)
        wsReadyRef.current = true
        // Core subscriptions
        ws!.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))
        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
        // Subscribe to all open positions
        ws!.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1, req_id: 300 }))
        // Load trade history
        fetchHistory(ws!)
        // Live quotes
        resubscribeProposals(ws!)
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30_000)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        /* Error handling */
        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          const fatal = ['AuthorizationRequired', 'InvalidToken', 'InvalidAppID']
          if (err.code && fatal.includes(err.code)) {
            intentionalClose.current = true
            setWsError('Session expired — please log in again.')
            return
          }
          // Proposal errors — surface to the relevant proposal slot
          if (msg.req_id === 10) setCallProp({ id: '', ask_price: 0, payout: 0, error: err.message })
          if (msg.req_id === 11) setPutProp({ id: '', ask_price: 0, payout: 0, error: err.message })
          setBuying(null)
          return
        }

        /* Balance */
        if (msg.msg_type === 'balance') {
          const b = (msg as { balance: { balance: number; currency: string } }).balance
          window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: b.balance, currency: b.currency } }))
        }

        /* Proposals */
        if (msg.msg_type === 'proposal') {
          const p = (msg as { proposal: { id: string; ask_price: number; payout: number } }).proposal
          const snap: ProposalSnap = { id: p.id, ask_price: p.ask_price, payout: p.payout }
          if (msg.req_id === 10) { setCallProp(snap); callPropRef.current = snap }
          if (msg.req_id === 11) { setPutProp(snap);  putPropRef.current  = snap }
        }

        /* Buy response */
        if (msg.msg_type === 'buy') {
          setBuying(null)
          // The open-contract stream (POC subscribe without contract_id) will auto-pick
          // up the new position — no separate per-contract subscription needed.
        }

        /* Open-contract stream (no contract_id — all open positions) */
        if (msg.msg_type === 'proposal_open_contract') {
          const poc = (msg as { proposal_open_contract: {
            contract_id:      number
            contract_type:    string
            underlying_symbol:string
            buy_price:        string
            payout:           string
            profit:           string
            status:           string
            is_sold:          number
            is_valid_to_sell: number
            currency:         string
            purchase_time:    number
            longcode:         string
            id?:              string
          }}).proposal_open_contract
          const subId = poc.id ?? (msg.subscription as { id: string } | undefined)?.id ?? ''
          if (subId) pocSubIdRef.current = subId

          if (!poc.contract_id) return

          if (poc.is_sold === 1) {
            // Mark as settling briefly so we can show win/loss color before removing
            setOpenPositions(prev => {
              const next = new Map(prev)
              const existing = next.get(poc.contract_id)
              next.set(poc.contract_id, {
                ...(existing ?? {
                  contract_id: poc.contract_id, contract_type: poc.contract_type,
                  underlying: poc.underlying_symbol ?? symbolRef.current,
                  buy_price: parseFloat(poc.buy_price) || 0, payout: parseFloat(poc.payout) || 0,
                  currency: poc.currency ?? currencyRef.current, purchase_time: poc.purchase_time ?? 0,
                  longcode: poc.longcode ?? '', subId,
                }),
                profit: parseFloat(poc.profit) || 0,
                status: poc.status,
                is_sold: 1, is_valid_to_sell: 0,
                settling: true,
              })
              return next
            })
            // Remove after 2.5s, refresh history
            setTimeout(() => {
              setOpenPositions(prev => { const n = new Map(prev); n.delete(poc.contract_id); return n })
              if (ws?.readyState === WebSocket.OPEN) fetchHistory(ws)
            }, 2500)
          } else {
            setOpenPositions(prev => {
              const next = new Map(prev)
              next.set(poc.contract_id, {
                contract_id:      poc.contract_id,
                contract_type:    poc.contract_type,
                underlying:       poc.underlying_symbol ?? symbolRef.current,
                buy_price:        parseFloat(poc.buy_price) || 0,
                payout:           parseFloat(poc.payout) || 0,
                profit:           parseFloat(poc.profit) || 0,
                status:           poc.status,
                is_sold:          poc.is_sold,
                is_valid_to_sell: poc.is_valid_to_sell,
                currency:         poc.currency ?? currencyRef.current,
                purchase_time:    poc.purchase_time ?? 0,
                longcode:         poc.longcode ?? '',
                subId,
              })
              return next
            })
          }
        }

        /* Transaction — detect sells to know when to refresh history */
        if (msg.msg_type === 'transaction') {
          const tx = (msg as { transaction: { action: string } }).transaction
          // History is refreshed from the POC handler above; this is a fallback for contracts
          // that weren't in our open-positions map (e.g. opened in another session).
          if (tx.action === 'sell' && ws?.readyState === WebSocket.OPEN) {
            // Wait a moment for the DB to settle before fetching
            setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) fetchHistory(ws) }, 1500)
          }
        }

        /* Profit table response */
        if (msg.msg_type === 'profit_table') {
          setHistLoading(false)
          type PtRow = {
            contract_id:       number
            contract_type?:    string
            underlying_symbol?:string
            buy_price?:        number
            sell_price?:       number
            purchase_time?:    number
            sell_time?:        number | null
          }
          const pt = (msg as { profit_table: { transactions?: PtRow[] } }).profit_table
          if (pt.transactions) {
            setHistory(pt.transactions.map(t => ({
              contract_id:   t.contract_id,
              contract_type: t.contract_type   ?? '',
              underlying:    t.underlying_symbol ?? '',
              buy_price:     t.buy_price        ?? 0,
              sell_price:    t.sell_price       ?? 0,
              purchase_time: t.purchase_time    ?? 0,
              sell_time:     t.sell_time        ?? null,
            })))
          }
        }

        /* Sell response */
        if (msg.msg_type === 'sell') {
          // Position removal handled by POC stream; history refresh also triggered there
        }
      }

      ws.onerror = () => {}
      ws.onclose = () => {
        setWsReady(false); wsReadyRef.current = false
        botWsRef.current = null
        setBuying(null)
        if (ping) { clearInterval(ping); ping = null }
        if (!intentionalClose.current) {
          if (reconnectCount.current >= MAX_RECONNECT) {
            reconnectCount.current = 0
            setWsError('Connection lost after 5 attempts — please refresh.')
            return
          }
          const delay = backoff(reconnectCount.current++)
          setWsError(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`)
          scheduleReconnect(delay)
        }
      }
    }

    function scheduleReconnect(delay = 2000) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => {
        if (!intentionalClose.current) connect()
      }, delay)
    }

    connect()

    return () => {
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (ping) clearInterval(ping)
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ forget_all: 'proposal',              req_id: 9993 }))
          ws.send(JSON.stringify({ forget_all: 'proposal_open_contract',req_id: 9992 }))
          ws.send(JSON.stringify({ forget_all: 'transaction',           req_id: 9991 }))
        } catch { /**/ }
      }
      ws?.close()
      botWsRef.current = null
    }
  }, [fetchHistory, resubscribeProposals])

  /* ── Debounce proposal resubscription when config changes ── */
  useEffect(() => {
    const ws = botWsRef.current
    if (!ws || !wsReady) return
    const t = setTimeout(() => {
      if (botWsRef.current?.readyState === WebSocket.OPEN) resubscribeProposals(botWsRef.current)
    }, 450)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, category, digitType, touchType, digitBa, touchBa, duration, durUnit, stake, currency, wsReady])

  /* ── Duration unit: digits are ticks-only; touch can't be ticks ── */
  useEffect(() => {
    if (category === 'digits') setDurUnit('t')
    else if (category === 'touch' && durUnit === 't') setDurUnit('m')
  }, [category, durUnit])

  /* ── Buy handler ── */
  const handleBuy = useCallback((contractType: 'CALL' | 'PUT' | 'primary') => {
    const ws = botWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || buying) return

    let snap: ProposalSnap | null = null
    let ct = ''

    if (contractType === 'CALL') {
      snap = callPropRef.current; ct = 'CALL'
    } else if (contractType === 'PUT') {
      snap = putPropRef.current; ct = 'PUT'
    } else {
      // primary = digits or touch
      snap = callPropRef.current
      if (categoryRef.current === 'digits') ct = digitTypeRef.current
      else ct = touchTypeRef.current
    }

    if (!snap?.id || snap.error) return
    setBuying(ct)
    const reqId = ++reqIdRef.current
    ws.send(JSON.stringify({ buy: snap.id, price: parseFloat((snap.ask_price * 1.02).toFixed(2)), req_id: reqId }))
  }, [buying])

  /* ── Sell handler ── */
  const handleSell = useCallback((contractId: number) => {
    const ws = botWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const reqId = ++reqIdRef.current
    // price:0 = sell at market (any price); per sell_request.schema.json
    ws.send(JSON.stringify({ sell: contractId, price: 0, req_id: reqId }))
  }, [])

  /* ── Derived ── */
  const marketLabel = MARKETS.find(m => m.symbol === symbol)?.label ?? symbol
  const openList    = Array.from(openPositions.values())

  /* ── Styles ── */
  const inputSt: React.CSSProperties = {
    background: '#0a0f1a', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px', color: '#fff', fontSize: '0.82rem',
    padding: '0.45rem 0.65rem', width: '100%', outline: 'none',
    boxSizing: 'border-box',
  }
  const labelSt: React.CSSProperties = {
    fontSize: '0.62rem', fontWeight: 700, color: 'rgba(229,229,229,0.38)',
    textTransform: 'uppercase', letterSpacing: '0.07em',
    display: 'block', marginBottom: '0.3rem',
  }
  const sectionSt: React.CSSProperties = {
    background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: '12px', padding: '1rem',
  }

  /* ── Render ── */
  return (
    <div style={{ background: '#000', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.9rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#050505', flexShrink: 0,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
            Manual Trader
          </h1>
          <p style={{ margin: 0, fontSize: '0.7rem', color: 'rgba(229,229,229,0.35)', marginTop: '1px' }}>
            Place trades manually across markets and contract types
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          {livePrice != null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</div>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#FCA311', fontVariantNumeric: 'tabular-nums' }}>
                {livePrice.toFixed(pipSizeRef.current)}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
              background: wsError ? '#ef4444' : wsReady ? '#22c55e' : '#FCA311',
              boxShadow: wsReady && !wsError ? '0 0 6px #22c55e88' : 'none',
              animation: wsReady && !wsError ? 'pulse 2s ease infinite' : 'none',
            }} />
            <span style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.5)' }}>
              {wsError ? 'Error' : wsReady ? `${accountLabel || 'Connected'} · ${currency}` : 'Connecting…'}
            </span>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {wsError && (
        <div style={{ padding: '0.6rem 1.5rem', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: '0.78rem', flexShrink: 0 }}>
          ⚠ {wsError}
        </div>
      )}

      {/* Body — 3-column grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '320px 1fr 280px',
        flex: 1, minHeight: 0, overflow: 'hidden',
      }}>

        {/* ═══ LEFT: Config Panel ═══ */}
        <div style={{
          borderRight: '1px solid rgba(255,255,255,0.07)',
          overflowY: 'auto', padding: '1.25rem 1rem',
          display: 'flex', flexDirection: 'column', gap: '1rem',
          background: '#030d1a',
        }}>

          {/* Market */}
          <div style={sectionSt}>
            <span style={labelSt}>Market</span>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} style={{ ...inputSt, cursor: 'pointer' }}>
              {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
            </select>
          </div>

          {/* Category tabs */}
          <div style={sectionSt}>
            <span style={labelSt}>Contract Type</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', marginBottom: '1rem' }}>
              {([
                { key: 'riseFall', label: '↑↓ Rise/Fall' },
                { key: 'digits',   label: '# Digits'      },
                { key: 'touch',    label: '⊙ Touch'        },
              ] as { key: TradeCategory; label: string }[]).map(c => (
                <button key={c.key} onClick={() => setCategory(c.key)} style={{
                  padding: '0.5rem 0.3rem', borderRadius: '8px', border: `1px solid ${category === c.key ? 'rgba(252,163,17,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  background: category === c.key ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.03)',
                  color: category === c.key ? '#FCA311' : 'rgba(229,229,229,0.45)',
                  fontWeight: 700, fontSize: '0.68rem', cursor: 'pointer', transition: 'all 0.15s', textAlign: 'center',
                }}>{c.label}</button>
              ))}
            </div>

            {/* Digit type pills */}
            {category === 'digits' && (
              <>
                <span style={labelSt}>Digit Trade</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.75rem' }}>
                  {['DIGITEVEN','DIGITODD','DIGITOVER','DIGITUNDER','DIGITMATCH','DIGITDIFF'].map(t => (
                    <button key={t} onClick={() => setDigitType(t)} style={{
                      padding: '0.3rem 0.6rem', borderRadius: '20px', fontSize: '0.68rem', fontWeight: 700,
                      border: `1px solid ${digitType === t ? 'rgba(252,163,17,0.4)' : 'rgba(255,255,255,0.1)'}`,
                      background: digitType === t ? 'rgba(252,163,17,0.15)' : 'transparent',
                      color: digitType === t ? '#FCA311' : 'rgba(229,229,229,0.5)', cursor: 'pointer',
                    }}>{CONTRACT_LABELS[t]}</button>
                  ))}
                </div>
                {/* Digit barrier picker */}
                {DIGIT_BARRIER_TYPES.has(digitType) && (
                  <>
                    <span style={labelSt}>Barrier Digit</span>
                    <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem' }}>
                      {[0,1,2,3,4,5,6,7,8,9].map(d => (
                        <button key={d} onClick={() => setDigitBa(d)} style={{
                          width: '26px', height: '26px', borderRadius: '50%', fontSize: '0.7rem', fontWeight: 700,
                          border: `1.5px solid ${digitBa === d ? '#FCA311' : 'rgba(255,255,255,0.14)'}`,
                          background: digitBa === d ? 'rgba(252,163,17,0.18)' : 'transparent',
                          color: digitBa === d ? '#FCA311' : 'rgba(229,229,229,0.55)', cursor: 'pointer',
                        }}>{d}</button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {/* Touch type */}
            {category === 'touch' && (
              <>
                <span style={labelSt}>Touch Type</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '0.75rem' }}>
                  {['ONETOUCH','NOTOUCH'].map(t => (
                    <button key={t} onClick={() => setTouchType(t)} style={{
                      padding: '0.45rem', borderRadius: '8px', fontSize: '0.72rem', fontWeight: 700,
                      border: `1px solid ${touchType === t ? 'rgba(252,163,17,0.4)' : 'rgba(255,255,255,0.08)'}`,
                      background: touchType === t ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.03)',
                      color: touchType === t ? '#FCA311' : 'rgba(229,229,229,0.45)', cursor: 'pointer',
                    }}>{CONTRACT_LABELS[t]}</button>
                  ))}
                </div>
                <span style={labelSt}>Barrier offset (e.g. +0.10 or -0.10)</span>
                <input
                  type="text" value={touchBa}
                  onChange={e => setTouchBa(e.target.value)}
                  placeholder="+0.10"
                  style={{ ...inputSt, marginBottom: '0.5rem' }}
                />
              </>
            )}
          </div>

          {/* Duration */}
          <div style={sectionSt}>
            <span style={labelSt}>Duration</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.5rem' }}>
              <input
                type="number" min="1" max={durUnit === 't' ? 10 : durUnit === 'm' ? 60 : 24}
                value={duration}
                onChange={e => setDuration(Math.max(1, parseInt(e.target.value) || 1))}
                style={inputSt}
              />
              <select
                value={durUnit}
                onChange={e => setDurUnit(e.target.value as 't' | 'm' | 'h')}
                disabled={category === 'digits'}
                style={{ ...inputSt, width: '70px', cursor: category === 'digits' ? 'not-allowed' : 'pointer' }}
              >
                <option value="t">Ticks</option>
                {category !== 'digits' && <option value="m">Mins</option>}
                {category !== 'digits' && <option value="h">Hours</option>}
              </select>
            </div>
          </div>

          {/* Stake */}
          <div style={sectionSt}>
            <span style={labelSt}>Stake ({currency})</span>
            <input
              type="number" min="0.35" step="0.01" value={stake}
              onChange={e => setStake(e.target.value)}
              style={inputSt}
            />
          </div>

          {/* Proposal card + buy buttons */}
          {category === 'riseFall' ? (
            /* Two-button layout for Rise/Fall */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {/* Rise */}
              <button
                onClick={() => handleBuy('CALL')}
                disabled={!callProp?.id || !!callProp?.error || !!buying || !wsReady}
                style={{
                  padding: '1rem', borderRadius: '12px', border: 'none', cursor: !callProp?.id || !!buying || !wsReady ? 'not-allowed' : 'pointer',
                  background: !callProp?.id || !!buying || !wsReady ? 'rgba(34,197,94,0.12)' : 'linear-gradient(135deg, #22c55e, #16a34a)',
                  color: !callProp?.id || !!buying || !wsReady ? '#22c55e66' : '#fff',
                  fontWeight: 800, fontSize: '1rem', transition: 'all 0.15s',
                }}
              >
                <div>▲ Rise</div>
                {callProp?.ask_price ? (
                  <div style={{ fontSize: '0.72rem', fontWeight: 400, opacity: 0.85, marginTop: '3px' }}>
                    {buying === 'CALL' ? '…buying' : `${fmt2(callProp.ask_price)} ${currency} · payout ${fmt2(callProp.payout)}`}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.4, marginTop: '3px' }}>
                    {callProp?.error ?? 'Getting quote…'}
                  </div>
                )}
              </button>
              {/* Fall */}
              <button
                onClick={() => handleBuy('PUT')}
                disabled={!putProp?.id || !!putProp?.error || !!buying || !wsReady}
                style={{
                  padding: '1rem', borderRadius: '12px', border: 'none', cursor: !putProp?.id || !!buying || !wsReady ? 'not-allowed' : 'pointer',
                  background: !putProp?.id || !!buying || !wsReady ? 'rgba(239,68,68,0.12)' : 'linear-gradient(135deg, #ef4444, #dc2626)',
                  color: !putProp?.id || !!buying || !wsReady ? '#ef444466' : '#fff',
                  fontWeight: 800, fontSize: '1rem', transition: 'all 0.15s',
                }}
              >
                <div>▼ Fall</div>
                {putProp?.ask_price ? (
                  <div style={{ fontSize: '0.72rem', fontWeight: 400, opacity: 0.85, marginTop: '3px' }}>
                    {buying === 'PUT' ? '…buying' : `${fmt2(putProp.ask_price)} ${currency} · payout ${fmt2(putProp.payout)}`}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.4, marginTop: '3px' }}>
                    {putProp?.error ?? 'Getting quote…'}
                  </div>
                )}
              </button>
            </div>
          ) : (
            /* Single-buy layout for Digits / Touch */
            <div>
              {callProp && !callProp.error && (
                <div style={{ ...sectionSt, marginBottom: '0.75rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {[
                    { label: 'Ask Price', val: fmt2(callProp.ask_price) + ' ' + currency },
                    { label: 'Payout',    val: fmt2(callProp.payout)    + ' ' + currency },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#FCA311', fontVariantNumeric: 'tabular-nums' }}>{s.val}</div>
                    </div>
                  ))}
                </div>
              )}
              {callProp?.error && (
                <div style={{ marginBottom: '0.65rem', padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: '8px', color: '#fca5a5', fontSize: '0.72rem' }}>
                  {callProp.error}
                </div>
              )}
              <button
                onClick={() => handleBuy('primary')}
                disabled={!callProp?.id || !!callProp?.error || !!buying || !wsReady}
                style={{
                  width: '100%', padding: '0.85rem', borderRadius: '12px', border: 'none',
                  background: !callProp?.id || !!callProp?.error || !!buying || !wsReady
                    ? 'rgba(252,163,17,0.12)'
                    : 'linear-gradient(135deg, #FCA311, #e08500)',
                  color: !callProp?.id || !!buying || !wsReady ? '#FCA31166' : '#000',
                  fontWeight: 800, fontSize: '0.95rem',
                  cursor: !callProp?.id || !!callProp?.error || !!buying || !wsReady ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {buying
                  ? '…placing trade'
                  : `BUY ${category === 'digits' ? CONTRACT_LABELS[digitType] ?? digitType : CONTRACT_LABELS[touchType] ?? touchType}`
                }
              </button>
            </div>
          )}

          {/* Disclaimer */}
          <p style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.2)', lineHeight: 1.5, margin: 0 }}>
            Trading derivatives involves significant risk. You may lose your entire stake. Only trade with money you can afford to lose.
          </p>
        </div>

        {/* ═══ MIDDLE: Chart + Open Positions ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#000' }}>
          {/* Chart */}
          <div style={{ padding: '1rem 1.25rem 0.75rem', flexShrink: 0 }}>
            <PriceChart prices={prices} livePrice={livePrice} label={marketLabel} />
          </div>

          {/* Recent digit bar (for digit trades) */}
          {category === 'digits' && recentDigits.length > 0 && (
            <div style={{ padding: '0 1.25rem 0.5rem', flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {recentDigits.slice(-20).map((d, i) => {
                  const isLast = i === Math.min(recentDigits.length, 20) - 1
                  const relevant = DIGIT_BARRIER_TYPES.has(digitType)
                    ? (digitType === 'DIGITOVER' ? d > digitBa : digitType === 'DIGITUNDER' ? d <= digitBa : d === digitBa)
                    : (digitType === 'DIGITEVEN' ? d % 2 === 0 : d % 2 !== 0)
                  return (
                    <div key={i} style={{
                      width: '24px', height: '24px', borderRadius: '5px',
                      fontSize: '0.65rem', fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isLast ? 'rgba(252,163,17,0.2)' : relevant ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.08)',
                      border: `1.5px solid ${isLast ? '#FCA311' : relevant ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.2)'}`,
                      color: isLast ? '#FCA311' : relevant ? '#22c55e' : '#ef4444',
                    }}>{d}</div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Open positions */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 1.25rem 1rem' }}>
            <div style={{ ...sectionSt, padding: '0' }}>
              <div style={{ padding: '0.75rem 1rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#fff' }}>Open Positions</span>
                <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.3)' }}>{openList.length} open</span>
              </div>
              {openList.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.75rem' }}>
                  No open positions. Place a trade to see it here.
                </div>
              ) : (
                <div>
                  {/* Column headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: '80px 70px 70px 1fr 70px 60px', gap: '0', padding: '0.3rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    {['Time','Market','Type','Desc','P/L','Action'].map(h => (
                      <span key={h} style={{ fontSize: '0.57rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</span>
                    ))}
                  </div>
                  {openList.map(pos => {
                    const pl = pos.profit
                    const settled = pos.is_sold === 1
                    const won = pos.status === 'won'
                    const dotColor = settled
                      ? (won ? '#22c55e' : '#ef4444')
                      : pl > 0 ? 'rgba(34,197,94,0.8)' : pl < 0 ? 'rgba(239,68,68,0.8)' : 'rgba(251,191,36,0.8)'
                    return (
                      <div key={pos.contract_id} style={{
                        display: 'grid', gridTemplateColumns: '80px 70px 70px 1fr 70px 60px',
                        alignItems: 'center', padding: '0.5rem 1rem',
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        background: settled
                          ? (won ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)')
                          : 'transparent',
                        transition: 'background 0.3s',
                      }}>
                        <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.4)', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtTime(pos.purchase_time)}
                        </span>
                        <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.4)' }}>
                          {pos.underlying.replace('_', ' ')}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                          <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.6)', fontWeight: 600 }}>
                            {CONTRACT_LABELS[pos.contract_type] ?? pos.contract_type}
                          </span>
                        </div>
                        <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.28)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {pos.longcode}
                        </span>
                        <span style={{
                          fontSize: '0.68rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                          color: settled ? (won ? '#22c55e' : '#ef4444') : pl >= 0 ? '#22c55e' : '#ef4444',
                        }}>
                          {settled
                            ? (won ? `+${fmt2(pos.profit)}` : fmt2(pos.profit))
                            : `${pl >= 0 ? '+' : ''}${fmt2(pl)}`
                          }
                        </span>
                        <div>
                          {!settled && pos.is_valid_to_sell === 1 ? (
                            <button
                              onClick={() => handleSell(pos.contract_id)}
                              style={{
                                padding: '0.2rem 0.5rem', borderRadius: '5px', border: '1px solid rgba(239,68,68,0.3)',
                                background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                                fontSize: '0.62rem', fontWeight: 700, cursor: 'pointer',
                              }}
                            >Sell</button>
                          ) : (
                            <span style={{ fontSize: '0.6rem', color: settled ? (won ? '#22c55e' : '#ef4444') : 'rgba(229,229,229,0.2)', fontWeight: 600 }}>
                              {settled ? (won ? '✓ Won' : '✗ Lost') : 'Open'}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ═══ RIGHT: Trade History ═══ */}
        <div style={{
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          background: '#020a14', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '1rem 1rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff' }}>Trade History</span>
            {histLoading && (
              <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.3)' }}>loading…</span>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 0.75rem' }}>
            {history.length === 0 && !histLoading ? (
              <div style={{ textAlign: 'center', padding: '3rem 0', color: 'rgba(229,229,229,0.2)', fontSize: '0.75rem' }}>
                No trade history yet.
              </div>
            ) : (
              <>
                {/* Headers */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px 55px 55px', padding: '0.5rem 0.25rem 0.25rem', position: 'sticky', top: 0, background: '#020a14', zIndex: 1 }}>
                  {['Time','Type','Stake','P/L'].map(h => (
                    <span key={h} style={{ fontSize: '0.57rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</span>
                  ))}
                </div>
                {history.map(row => {
                  const pl = row.sell_price - row.buy_price
                  const won = pl > 0
                  return (
                    <div key={row.contract_id} style={{ display: 'grid', gridTemplateColumns: '1fr 50px 55px 55px', alignItems: 'center', padding: '0.45rem 0.25rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.35)', fontVariantNumeric: 'tabular-nums' }}>
                        {row.purchase_time ? fmtTime(row.purchase_time) : '—'}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: won ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.5)' }}>
                          {CONTRACT_LABELS[row.contract_type] ?? row.contract_type}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.5)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt2(row.buy_price)}
                      </span>
                      <span style={{ fontSize: '0.62rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: won ? '#22c55e' : '#ef4444' }}>
                        {won ? '+' : ''}{fmt2(pl)}
                      </span>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
      `}</style>
    </div>
  )
}
