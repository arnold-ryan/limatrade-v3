'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

/**
 * Speedbot — High-speed digit trading with dual strategy
 *
 * Deriv API (verified against docs):
 *  • Public ticks WS : wss://api.derivws.com/trading/v1/options/ws/public
 *  • Authenticated WS: /api/user/ws-url → OTP URL from Deriv REST
 *  • Buy            : { buy:'1', price:1000, parameters:{ underlying_symbol, contract_type, ... } }
 *  • Transaction    : { transaction:1, subscribe:1 } — auth_required, scope:trade
 *  • forget_all     : sent on WS cleanup to prevent server-side subscription leaks
 *
 * Strategies:
 *  Standard  — fixed stake, optional zigzag / alternate-on-loss
 *  Martingale — multiply stake after each loss, reset on win
 *
 * Risk stops (checked after every settled contract):
 *  • Take profit threshold  (cumulative profit ≥ target)
 *  • Stop loss threshold    (cumulative loss   ≥ limit)
 *  • Max consecutive losses
 *  • Max contracts per run
 */

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'

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
  { symbol: 'JD10',     label: 'Jump 10 Index'              },
  { symbol: 'JD25',     label: 'Jump 25 Index'              },
  { symbol: 'JD50',     label: 'Jump 50 Index'              },
  { symbol: 'JD75',     label: 'Jump 75 Index'              },
  { symbol: 'JD100',    label: 'Jump 100 Index'             },
  { symbol: 'stpRNG',   label: 'Step Index 100'             },
  { symbol: 'stpRNG2',  label: 'Step Index 200'             },
]

const TRADE_TYPES = [
  { value: 'DIGITEVEN',  label: 'Even',    pair: 'DIGITODD'   },
  { value: 'DIGITODD',   label: 'Odd',     pair: 'DIGITEVEN'  },
  { value: 'DIGITOVER',  label: 'Over',    pair: 'DIGITUNDER' },
  { value: 'DIGITUNDER', label: 'Under',   pair: 'DIGITOVER'  },
  { value: 'DIGITMATCH', label: 'Match',   pair: 'DIGITDIFF'  },
  { value: 'DIGITDIFF',  label: 'Differ',  pair: 'DIGITMATCH' },
]
const BARRIER_TYPES = new Set(['DIGITOVER','DIGITUNDER','DIGITMATCH','DIGITDIFF'])
const PAIR_MAP: Record<string, string> = Object.fromEntries(
  TRADE_TYPES.map(t => [t.value, t.pair])
)

type Strategy  = 'standard' | 'martingale'
type ExecSpeed = 'turbo' | 'fast' | 'normal'

interface SpeedStats {
  runs:         number
  won:          number
  lost:         number
  profit:       number
  totalStake:   number
  totalPayout:  number
  consecLosses: number  // current streak of consecutive losses
}

interface TxRow {
  id:           number
  time:         number
  contractType: string
  stake:        number
  payout:       number
  won:          boolean
  settled:      boolean        // false while contract is still open
  currentPnl?:  number        // live P/L from proposal_open_contract (undefined = no data yet)
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
/**
 * Extract the last digit of a price using the market's pip_size.
 * pip_size is a required field in every tick and history response
 * (verified: ticks_response.schema.json, ticks_history_response.schema.json).
 * Defaults to 2 which covers all current synthetic indices.
 */
function lastDigit(price: number, pipSize = 2): number {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}

function fmt2(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const DIGIT_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#14b8a6',
  '#3b82f6','#8b5cf6','#ec4899','#06b6d4','#FCA311',
]

/* ─── Page ───────────────────────────────────────────────────────────────── */


/* ─── Analysis helpers (ported from Analysis Tool) ─────── */
function trailingStreak(arr: string[]): { count: number; val: string } {
  if (!arr.length) return { count: 0, val: '' }
  const val = arr[arr.length - 1]
  let count = 0
  for (let i = arr.length - 1; i >= 0 && arr[i] === val; i--) count++
  return { count, val }
}

interface SeqColor { bg: string; border: string; text: string }

function SbBar({ label, color, count, total }: {
  label: string; color: string; count: number; total: number
}) {
  const pct = total ? (count / total) * 100 : 0


  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
      <span style={{ width: '44px', fontSize: '0.72rem', fontWeight: 600, color, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '99px', transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ width: '42px', fontSize: '0.72rem', fontWeight: 600, color: 'rgba(229,229,229,0.7)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}

function SbSequence({ seq, colorMap, rawDigits, flashWon, flashExitDigit, ticksTotal }: {
  seq: string[]
  colorMap: Record<string, SeqColor>
  rawDigits?: number[]
  flashWon?: boolean | null   // null = no flash, true = won, false = lost
  flashExitDigit?: number     // actual last digit of the exit tick — flash this position, not just the last box
  ticksTotal?: number         // drives re-render on each tick so last box flashes
}) {
  const last = seq.length - 1

  // Find which box to flash:
  //  • If we know the exit digit, find the most-recent position in rawDigits that shows it.
  //    This corrects for the async sell notification arriving 1-3 ticks after contract exits.
  //  • Fall back to the last box if exit digit is unavailable.
  let flashIdx = last
  if (flashExitDigit !== undefined && rawDigits) {
    for (let i = rawDigits.length - 1; i >= 0; i--) {
      if (rawDigits[i] === flashExitDigit) {
        flashIdx = i
        break
      }
    }
  }

  return (
    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.75rem', justifyContent: 'center' }}>
      {seq.map((s, i) => {
        const c = colorMap[s] ?? { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', text: '#aaa' }
        const isFlashing = (i === flashIdx) && flashWon != null
        const display   = rawDigits != null ? String(rawDigits[i] ?? s) : s
        return (
          <div key={i} style={{
            width: '26px', height: '26px', borderRadius: '6px',
            fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isFlashing
              ? (flashWon ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)')
              : c.bg,
            border: isFlashing
              ? `2px solid ${flashWon ? '#22c55e' : '#ef4444'}`
              : `1.5px solid ${c.border}`,
            color: isFlashing ? '#fff' : c.text,
            transform: isFlashing ? 'scale(1.22)' : 'scale(1)',
            boxShadow: isFlashing
              ? (flashWon ? '0 0 12px 4px rgba(34,197,94,0.55)' : '0 0 12px 4px rgba(239,68,68,0.55)')
              : 'none',
            transition: 'background 0.15s, border-color 0.15s',
          }}>{display}</div>
        )
      })}
    </div>
  )
}

function SbDigitPicker({ selected, onSelect, disabled }: { selected: number; onSelect: (d: number) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.85rem', justifyContent: 'center' }}>
      {[0,1,2,3,4,5,6,7,8,9].map(d => (
        <button key={d} onClick={() => !disabled && onSelect(d)} style={{
          width: '27px', height: '27px', borderRadius: '50%',
          fontSize: '0.72rem', fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
          border: `1.5px solid ${selected === d ? '#FCA311' : 'rgba(255,255,255,0.14)'}`,
          background: selected === d ? 'rgba(252,163,17,0.18)' : 'transparent',
          color: selected === d ? '#FCA311' : 'rgba(229,229,229,0.55)',
          transition: 'all 0.15s',
        }}>{d}</button>
      ))}
    </div>
  )
}

/* ─── PriceChart ─────────────────────────────────────────── */
/**
 * Canvas-rendered line chart from tick prices.
 * Data source: ticks_history (style:'ticks', subscribe:1) on the public WS.
 * Docs: https://developers.deriv.com/docs/data/ticks-history/
 * - history.prices[] — initial batch
 * - tick.quote       — each live tick after subscribe
 */
function PriceChart({ prices, livePrice, label }: {
  prices: number[]
  livePrice: number | null
  label: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visible = prices.slice(-300)

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

    const padL = 58, padR = 10, padT = 10, padB = 20
    const chartW = W - padL - padR
    const chartH = H - padT - padB

    const xOf = (i: number) => padL + (i / (visible.length - 1)) * chartW
    const yOf = (p: number) => padT + (1 - (p - lo) / range) * chartH

    // bg
    ctx.fillStyle = '#060f1c'
    ctx.fillRect(0, 0, W, H)

    // horizontal grid lines + price labels
    const gridLines = 4
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (i / gridLines) * chartH
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
      const priceVal = hi - (i / gridLines) * range
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = `10px monospace`
      ctx.textAlign = 'right'
      ctx.fillText(priceVal.toFixed(2), padL - 4, y + 4)
    }

    // vertical grid lines
    const vStep = Math.max(1, Math.floor(visible.length / 6))
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    for (let i = 0; i < visible.length; i += vStep) {
      ctx.beginPath(); ctx.moveTo(xOf(i), padT); ctx.lineTo(xOf(i), padT + chartH); ctx.stroke()
    }

    // gradient fill
    const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH)
    grad.addColorStop(0, 'rgba(252,163,17,0.2)')
    grad.addColorStop(1, 'rgba(252,163,17,0)')
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(visible[0]))
    for (let i = 1; i < visible.length; i++) ctx.lineTo(xOf(i), yOf(visible[i]))
    ctx.lineTo(xOf(visible.length - 1), padT + chartH)
    ctx.lineTo(xOf(0), padT + chartH)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // price line
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(visible[0]))
    for (let i = 1; i < visible.length; i++) ctx.lineTo(xOf(i), yOf(visible[i]))
    ctx.strokeStyle = '#FCA311'
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()

    // live price dashed line
    if (livePrice != null) {
      const ly = yOf(livePrice)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(239,68,68,0.5)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke()
      ctx.setLineDash([])
      // price badge
      ctx.fillStyle = '#ef4444'
      ctx.fillRect(W - padR + 2, ly - 7, 48, 14)
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 9px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(livePrice.toFixed(2), W - padR + 5, ly + 3.5)
    }

    // last-tick dot
    const lx = xOf(visible.length - 1)
    const ly2 = yOf(visible[visible.length - 1])
    ctx.beginPath(); ctx.arc(lx, ly2, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#FCA311'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()

  }, [visible, livePrice])

  if (prices.length < 2) {
    return (
      <div style={{ height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(229,229,229,0.2)', fontSize: '0.78rem' }}>
        Waiting for tick data…
      </div>
    )
  }

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
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '160px' }} />
    </div>
  )
}

export default function SpeedbotPage() {

  /* ── Config state ── */
  const [strategy,    setStrategy]   = useState<Strategy>('standard')
  const [symbol,      setSymbol]     = useState('1HZ100V')
  const [tradeType,   setTradeType]  = useState('DIGITEVEN')
  const [prediction,  setPrediction] = useState(5)       // barrier digit for OVER/UNDER/MATCH/DIFF
  const [analysisDigit, setAnalysisDigit] = useState(5)  // analysis card digit — independent of trade barrier
  const [ticksDur,    setTicksDur]   = useState(1)        // contract duration in ticks (1-9)
  const [stake,       setStake]      = useState('1.00')
  const [execSpeed,   setExecSpeed]  = useState<ExecSpeed>('turbo')
  const [takeProfit,  setTakeProfit] = useState('10')
  const [stopLoss,    setStopLoss]   = useState('5')
  const [maxConsec,   setMaxConsec]  = useState('5')
  const [maxContracts,setMaxContracts] = useState('50')
  const [zigzag,      setZigzag]     = useState(false)
  const [altOnLoss,   setAltOnLoss]  = useState(false)
  const [martMult,    setMartMult]   = useState('2.0')

  /* ── Bot state ── */
  const [running,     setRunning]    = useState(false)
  const [botReady,    setBotReady]   = useState(false)
  const [botError,    setBotError]   = useState<string | null>(null)
  const [stopReason,  setStopReason] = useState<string | null>(null)
  /**
   * Flashes the correct digit bubble when a trade settles.
   * exitDigit = last digit of exit tick (from proposal_open_contract exit_tick_display_value).
   * Without this, the flash lands on whatever tick arrived last — which is 1-3 ticks
   * ahead of the actual contract exit tick due to async sell notification delay.
   */
  const [tradeFlash,  setTradeFlash] = useState<{ won: boolean; exitDigit?: number } | null>(null)
  const [currency,    setCurrency]   = useState('USD')
  const [accountLabel,setAccountLabel] = useState('')
  const [stats,       setStats]      = useState<SpeedStats>({
    runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0,
  })
  const [txLog,       setTxLog]      = useState<TxRow[]>([])

  /* ── Tick state ── */
  const [livePrice,   setLivePrice]  = useState<number | null>(null)
  const [prices,      setPrices]      = useState<number[]>([])
  const [recentDigits,setRecentDigits] = useState<number[]>([])
  const [ticksTotal,  setTicksTotal] = useState(0)

  /* ── Refs (avoid stale closures in WS handlers) ── */
  const runningRef      = useRef(false)
  const strategyRef     = useRef<Strategy>('standard')
  const symbolRef       = useRef('1HZ100V')
  const tradeTypeRef    = useRef('DIGITEVEN')
  const predictionRef   = useRef(5)
  const ticksDurRef     = useRef(1)
  const stakeRef        = useRef('1.00')
  const execSpeedRef    = useRef<ExecSpeed>('turbo')
  const takeProfitRef   = useRef('10')
  const stopLossRef     = useRef('5')
  const maxConsecRef    = useRef('5')
  const maxContractsRef = useRef('50')
  const zigzagRef       = useRef(false)
  const altOnLossRef    = useRef(false)
  const martMultRef     = useRef('2.0')
  const currencyRef     = useRef('USD')

  /* ── Bot WS infra refs ── */
  /** pip_size from Deriv — required field in every tick/history response */
  const pipSizeRef        = useRef<number>(2)
  const botWsRef          = useRef<WebSocket | null>(null)
  const livePriceRef      = useRef<number | null>(null)
  const currentStakeRef   = useRef(1.00)    // escalates with martingale, resets on win
  const pendingBuysRef    = useRef<Map<number, { buyPrice: number }>>(new Map())
  const pendingSpotsByReq = useRef<Map<number, null>>(new Map())
  const reqIdRef          = useRef(200)
  const reconnectCount    = useRef(0)
  const reconnectTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalClose  = useRef(false)
  const connectedAccountRef = useRef<string | null>(null)
  const inTradeRef        = useRef(false)   // prevent concurrent trades
  const pocSubsRef        = useRef<Map<number, string>>(new Map()) // contract_id → subscription_id
  const pocExitDigitsRef  = useRef<Map<number, number>>(new Map()) // contract_id → exit tick last digit
  /* ── Tick-gate: fire next trade on tick count, not on Deriv's async sell notification ── */
  const ticksCountRef        = useRef(0)              // sync tick counter (ref copy of ticksTotal)
  const ticksAtBuyRef        = useRef<number | null>(null)   // ticksCount when buy response arrived
  const openContractIdRef    = useRef<number | null>(null)   // contract_id currently in flight
  const tickGateFiredIdRef   = useRef<number | null>(null)   // contract_id released by tick gate (not sell)
  /** Tracks current effective trade type (may zigzag or alternate) */
  const effectiveTypeRef  = useRef('DIGITEVEN')
  /** Accumulated loss stake for martingale recovery calculation */
  const accumLossRef      = useRef(0)
  /** Mirrors stats state synchronously — needed so checkStops runs outside setStats */
  const statsRef          = useRef<SpeedStats>({
    runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0,
  })

  /* ── Keep refs in sync with state ── */
  useEffect(() => { runningRef.current     = running     }, [running])
  useEffect(() => { strategyRef.current    = strategy    }, [strategy])
  useEffect(() => { symbolRef.current      = symbol      }, [symbol])
  useEffect(() => { tradeTypeRef.current   = tradeType   }, [tradeType])
  useEffect(() => { predictionRef.current  = prediction  }, [prediction])
  useEffect(() => { ticksDurRef.current    = ticksDur    }, [ticksDur])
  useEffect(() => { stakeRef.current       = stake       }, [stake])
  useEffect(() => { execSpeedRef.current   = execSpeed   }, [execSpeed])
  useEffect(() => { takeProfitRef.current  = takeProfit  }, [takeProfit])
  useEffect(() => { stopLossRef.current    = stopLoss    }, [stopLoss])
  useEffect(() => { maxConsecRef.current   = maxConsec   }, [maxConsec])
  useEffect(() => { maxContractsRef.current = maxContracts }, [maxContracts])
  useEffect(() => { zigzagRef.current      = zigzag      }, [zigzag])
  useEffect(() => { altOnLossRef.current   = altOnLoss   }, [altOnLoss])
  useEffect(() => { martMultRef.current    = martMult    }, [martMult])
  useEffect(() => { currencyRef.current    = currency    }, [currency])
  // keep effectiveTypeRef in sync when trade type changes manually (reset zigzag state)
  useEffect(() => { effectiveTypeRef.current = tradeType }, [tradeType])
  // Sync analysis card digit with the trade barrier so the card always reflects
  // what you're actually trading. The user can still override it in the card picker.
  useEffect(() => { if (!running) setAnalysisDigit(prediction) }, [prediction, running])

  /* ── Tick WebSocket (public — no auth) ── */
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
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.msg_type === 'history') {
        // Capture pip_size (top-level field per ticks_history_response.schema.json)
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps != null) pipSizeRef.current = ps
        // prices are numbers per schema (not strings)
        const hist = (msg as { history: { prices: number[] } }).history.prices
        const digits = hist.map(p => lastDigit(Number(p), pipSizeRef.current))
        setRecentDigits(digits.slice(-30))
        setTicksTotal(hist.length)
        setPrices(hist.map(Number))
      }

      if (msg.msg_type === 'tick') {
        // pip_size is REQUIRED on every tick per ticks_response.schema.json
        const tickData = (msg as { tick: { quote: number; pip_size: number } }).tick
        if (tickData.pip_size != null) pipSizeRef.current = tickData.pip_size
        const q = tickData.quote
        livePriceRef.current = q      // sync immediately — critical for entry spot accuracy
        ticksCountRef.current += 1    // sync counter — never stale, used by tick gate below
        setLivePrice(q)
        setRecentDigits(prev => [...prev.slice(-29), lastDigit(q, pipSizeRef.current)])
        setTicksTotal(t => t + 1)
        setPrices(prev => [...prev.slice(-499), q])

        /* ── Tick gate: fire next trade exactly ticksDur+1 ticks after buy confirms ──
         * Only active for Standard strategy — Martingale needs the sell result first
         * to calculate the next stake, so it keeps sell-based firing.
         * This removes dependence on Deriv's async sell notification timing.
         */
        if (
          strategyRef.current !== 'martingale' &&
          runningRef.current &&
          inTradeRef.current &&
          ticksAtBuyRef.current !== null &&
          tickGateFiredIdRef.current === null &&
          ticksCountRef.current - ticksAtBuyRef.current >= ticksDurRef.current + 1
        ) {
          tickGateFiredIdRef.current = openContractIdRef.current  // mark this contract as tick-released
          ticksAtBuyRef.current      = null
          openContractIdRef.current  = null
          inTradeRef.current         = false
          // setTimeout(0) yields to event loop — allows a queued STOP click to cancel before buy fires
          const _ws = botWsRef.current
          setTimeout(() => {
            if (runningRef.current && _ws?.readyState === WebSocket.OPEN) {
              executeTrade(_ws)
            }
          }, 0)
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
      // Clear stale price data so the chart doesn't flash old market prices
      setPrices([])
      setLivePrice(null)
    }
  }, [symbol])

  /* ── Check risk stops — pure: returns reason string or null, no setState ── */
  const checkStops = useCallback((updatedStats: SpeedStats): string | null => {
    const tp   = parseFloat(takeProfitRef.current)
    const sl   = parseFloat(stopLossRef.current)
    const maxC = parseInt(maxConsecRef.current, 10)
    const maxN = parseInt(maxContractsRef.current, 10)
    const cur  = currencyRef.current

    if (Number.isFinite(tp) && tp > 0 && updatedStats.profit >= tp)
      return `✅ Take Profit reached: +${fmt2(updatedStats.profit)} ${cur}`
    if (Number.isFinite(sl) && sl > 0 && updatedStats.profit <= -sl)
      return `🛑 Stop Loss triggered: ${fmt2(updatedStats.profit)} ${cur} (limit: -${fmt2(sl)} ${cur})`
    if (Number.isFinite(maxC) && maxC > 0 && updatedStats.consecLosses >= maxC)
      return `⚠️ Max consecutive losses (${maxC}) reached`
    if (Number.isFinite(maxN) && maxN > 0 && updatedStats.runs >= maxN)
      return `📊 Max contracts (${maxN}) reached`
    return null
  }, [])

  /* ── Execute one trade ── */
  const executeTrade = useCallback((ws: WebSocket) => {
    if (!runningRef.current || ws.readyState !== WebSocket.OPEN) return
    if (inTradeRef.current) return  // prevent overlap in normal mode

    const baseStake = parseFloat(stakeRef.current) || 1.00
    if (baseStake < 0.35) {
      setBotError('Stake must be at least 0.35 USD')
      setRunning(false)
      runningRef.current = false
      return
    }

    /* ── Determine effective contract type ── */
    let ct = effectiveTypeRef.current
    // If zigzag is on and we already completed a trade, alternate
    // (effectiveTypeRef is flipped after each trade in the sell handler)

    /* ── Determine stake amount ── */
    let amount = baseStake
    if (strategyRef.current === 'martingale') {
      amount = currentStakeRef.current
      if (amount < 0.35) amount = 0.35
    }
    amount = parseFloat(amount.toFixed(2))

    const reqId = ++reqIdRef.current
    pendingSpotsByReq.current.set(reqId, null)
    inTradeRef.current = true  // lock until sell arrives

    ws.send(JSON.stringify({
      buy: '1',
      price: 1000,   // max price cap — actual charge is ask_price
      req_id: reqId,
      parameters: {
        contract_type:     ct,
        underlying_symbol: symbolRef.current,
        duration:          ticksDurRef.current,
        duration_unit:     't',
        amount,
        basis:    'stake',
        currency: currencyRef.current,
        ...(BARRIER_TYPES.has(ct) ? { barrier: String(predictionRef.current) } : {}),
      },
    }))
  }, [])

  /* ── Bot WebSocket lifecycle ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    intentionalClose.current = false
    const MAX_RECONNECT = 5

    function backoff(n: number) { return Math.min(2000 * 2 ** n, 30_000) }

    async function connect() {
      setBotError(null)
      setBotReady(false)

      /* Always fetch active account first so we connect to the right account */
      let accountId = ''
      try {
        const r = await fetch('/api/user/balance', { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json() as {
            activeAccountId: string
            accounts: { accountId: string; currency: string; isDemo: boolean }[]
          }
          accountId = d.activeAccountId
          const acc = d.accounts.find(a => a.accountId === accountId)
          if (acc) {
            setCurrency(acc.currency)
            currencyRef.current = acc.currency
            setAccountLabel(acc.isDemo ? 'Demo' : 'Real')
          }
        }
      } catch { /* non-fatal */ }

      /* Get OTP WS URL */
      let wsUrl = ''
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) {
          if (r.status === 401) { intentionalClose.current = true; window.location.href = '/'; return }
          setBotError('Connection failed — retrying…')
          scheduleReconnect()
          return
        }
        ;({ wsUrl } = await r.json() as { wsUrl: string })
      } catch {
        setBotError('Network error — retrying…')
        scheduleReconnect()
        return
      }

      connectedAccountRef.current = accountId
      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0
        setBotError(null)
        setBotReady(true)
        // Subscribe to transaction stream (req_id 100 reserved)
        ws!.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))
        // Subscribe to balance updates — server pushes on every balance change
        // Source: balance_request.schema.json — subscribe: 1, auth_required
        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30_000)
        if (runningRef.current) executeTrade(ws!)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        /* ── Error handling ── */
        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          const fatal = ['AuthorizationRequired', 'InvalidToken', 'InvalidAppID']
          if (err.code && fatal.includes(err.code)) {
            intentionalClose.current = true
            setBotError('Session expired — please log in again.')
            setRunning(false); runningRef.current = false
            inTradeRef.current = false
            return
          }
          const tradeErr = [
            'InputValidationError', 'ContractCreationFailure',
            'MarketIsClosed', 'OfferingNotFound', 'ContractBuyValidationError',
          ]
          if (err.code && tradeErr.includes(err.code)) {
            setBotError(`Trade error: ${err.message}`)
            setRunning(false); runningRef.current = false
            inTradeRef.current = false
            return
          }
          if (err.code === 'RateLimit') { setBotError('Rate limited — pausing…'); return }
          setBotError(err.message ?? 'Unknown error')
          setRunning(false); runningRef.current = false
          inTradeRef.current = false
          return
        }

        /* ── Balance subscription push ── */
        if (msg.msg_type === 'balance') {
          const b = (msg as { balance: { balance: number; currency: string } }).balance
          window.dispatchEvent(new CustomEvent('deriv-balance', {
            detail: { balance: b.balance, currency: b.currency },
          }))
          // Auto-clear "insufficient balance" error when Deriv reports a new balance.
          setBotError(prev =>
            (prev && (prev.toLowerCase().includes('insufficient') || prev.toLowerCase().includes('balance')))
              ? null
              : prev
          )
        }

        /* ── Buy response ── */
        if (msg.msg_type === 'buy') {
          const buy = msg.buy as { contract_id: number; buy_price: number }
          const reqId = msg.req_id as number | undefined
          if (reqId != null) pendingSpotsByReq.current.delete(reqId)
          pendingBuysRef.current.set(buy.contract_id, { buyPrice: buy.buy_price })

          // Arm the tick gate for this contract
          ticksAtBuyRef.current      = ticksCountRef.current
          openContractIdRef.current  = buy.contract_id
          tickGateFiredIdRef.current = null   // clear any stale gate from previous contract

          // Update statsRef synchronously, then mirror to state for rendering
          statsRef.current = {
            ...statsRef.current,
            totalStake: parseFloat((statsRef.current.totalStake + buy.buy_price).toFixed(2)),
            runs: statsRef.current.runs + 1,
          }
          setStats(statsRef.current)

          // Add pending entry to tx log immediately (before settlement)
          setTxLog(prev => [{
            id:           buy.contract_id,
            time:         Date.now(),
            contractType: effectiveTypeRef.current,
            stake:        buy.buy_price,
            payout:       0,
            won:          false,
            settled:      false,
            currentPnl:   undefined,
          }, ...prev].slice(0, 60))

          // Subscribe to real-time P/L for this contract
          ws!.send(JSON.stringify({
            proposal_open_contract: 1,
            subscribe:              1,
            contract_id:            buy.contract_id,
            req_id:                 400,
          }))
        }

        /* ── Live contract P/L (proposal_open_contract subscription) ── */
        if (msg.msg_type === 'proposal_open_contract') {
          const poc = msg.proposal_open_contract as {
            contract_id:             number
            profit:                  number
            exit_tick_display_value?: string  // present when contract has settled
            subscription?:           { id: string }
          }
          if (poc.subscription?.id) {
            pocSubsRef.current.set(poc.contract_id, poc.subscription.id)
          }
          // Capture exit tick digit the moment Deriv reports it — this is the
          // ACTUAL digit the contract was decided on, not whatever the tick stream
          // happens to be showing at the time the sell event arrives.
          if (poc.exit_tick_display_value) {
            const exitPrice = parseFloat(poc.exit_tick_display_value)
            if (!isNaN(exitPrice)) {
              pocExitDigitsRef.current.set(
                poc.contract_id,
                lastDigit(exitPrice, pipSizeRef.current)
              )
            }
          }
          setTxLog(prev => prev.map(tx =>
            tx.id === poc.contract_id && !tx.settled
              ? { ...tx, currentPnl: poc.profit }
              : tx
          ))
        }

        /* ── Transaction stream ── */
        if (msg.msg_type === 'transaction') {
          const tx = msg.transaction as {
            action: string; amount: number; contract_id?: number; currency: string
          }

          if (tx.action === 'sell' && tx.contract_id != null) {
            const pending = pendingBuysRef.current.get(tx.contract_id)
            if (pending === undefined) return
            pendingBuysRef.current.delete(tx.contract_id)
            inTradeRef.current = false

            // Forget the proposal_open_contract subscription for this contract
            const pocSubId = pocSubsRef.current.get(tx.contract_id)
            if (pocSubId && ws?.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ forget: pocSubId, req_id: 9996 })) } catch { /**/ }
            }
            pocSubsRef.current.delete(tx.contract_id)

            const { buyPrice } = pending
            const payout = Math.max(0, tx.amount)
            const won    = payout > 0

            /* ── Flash the correct digit bubble with result color ──
             * Prefer exit digit from proposal_open_contract (captured above).
             * Falls back to undefined — SbSequence will flash the last box. */
            const exitDigit = pocExitDigitsRef.current.get(tx.contract_id)
            pocExitDigitsRef.current.delete(tx.contract_id)
            setTradeFlash({ won, exitDigit })
            setTimeout(() => setTradeFlash(null), 900)

            /* ── Compute updated stats from ref (synchronous, no React batching) ── */
            const prev        = statsRef.current
            const newTotalPayout = parseFloat((prev.totalPayout + payout).toFixed(2))
            const newProfit      = parseFloat((newTotalPayout - prev.totalStake).toFixed(2))
            const newConsec      = won ? 0 : prev.consecLosses + 1
            const updated: SpeedStats = {
              ...prev,
              totalPayout:  newTotalPayout,
              profit:       newProfit,
              won:          won ? prev.won + 1 : prev.won,
              lost:         won ? prev.lost : prev.lost + 1,
              consecLosses: newConsec,
            }
            statsRef.current = updated
            setStats(updated)

            /* ── Check stops OUTSIDE setState — avoids React batching issue ── */
            const stopMsg = checkStops(updated)
            if (stopMsg) {
              setRunning(false)
              runningRef.current = false
              setStopReason(stopMsg)
            }

            /* ── Settle the pending tx log entry ── */
            setTxLog(prev => {
              const idx = prev.findIndex(t => t.id === tx.contract_id)
              if (idx !== -1) {
                // Update existing pending entry
                const updated = [...prev]
                updated[idx] = { ...updated[idx], payout, won, settled: true, currentPnl: undefined }
                return updated
              }
              // Fallback — shouldn't happen but keep list safe
              return [{
                id:           tx.contract_id!,
                time:         Date.now(),
                contractType: effectiveTypeRef.current,
                stake:        buyPrice,
                payout,
                won,
                settled:      true,
              }, ...prev].slice(0, 60)
            })

            /* ── Strategy post-trade logic ── */
            if (strategyRef.current === 'martingale') {
              if (won) {
                // Win: reset stake to base
                currentStakeRef.current = parseFloat(stakeRef.current) || 1.00
                accumLossRef.current    = 0
              } else {
                // Loss: multiply
                const mult = parseFloat(martMultRef.current) || 2
                accumLossRef.current += buyPrice
                const nextStake = parseFloat((accumLossRef.current * mult).toFixed(2))
                currentStakeRef.current = Math.max(nextStake, 0.35)
              }
            } else {
              // Standard: reset stake (stays fixed)
              currentStakeRef.current = parseFloat(stakeRef.current) || 1.00
            }

            /* ── Zigzag: alternate type every trade ── */
            if (zigzagRef.current) {
              effectiveTypeRef.current = PAIR_MAP[effectiveTypeRef.current] ?? effectiveTypeRef.current
            }
            /* ── Alternate on Loss ── */
            else if (altOnLossRef.current && !won) {
              effectiveTypeRef.current = PAIR_MAP[effectiveTypeRef.current] ?? effectiveTypeRef.current
            }

            /* ── Schedule next trade if still running ──
             * Standard strategy: tick gate fires the next trade — skip here to avoid double-buy.
             * Martingale: must wait for sell result to set correct stake, fire here as usual.
             */
            const wasTickGated = tx.contract_id === tickGateFiredIdRef.current
            if (runningRef.current && ws?.readyState === WebSocket.OPEN && !wasTickGated) {
              const delay = execSpeedRef.current === 'turbo' ? 0
                          : execSpeedRef.current === 'fast'  ? 400
                          : 1500
              // Always use setTimeout (even 0ms) so a queued STOP click can process
              // before the next buy fires. Without this, turbo fires synchronously and
              // the stop button can't interrupt between the sell event and the next buy.
              setTimeout(() => {
                if (runningRef.current && ws?.readyState === WebSocket.OPEN) {
                  executeTrade(ws!)
                }
              }, delay)
            }
          }
        }
      }

      ws.onerror = () => {}
      ws.onclose = () => {
        setBotReady(false)
        botWsRef.current = null
        inTradeRef.current = false
        if (ping) { clearInterval(ping); ping = null }
        if (runningRef.current) { setRunning(false); runningRef.current = false }
        if (!intentionalClose.current) {
          if (reconnectCount.current >= MAX_RECONNECT) {
            reconnectCount.current = 0
            setBotError('Connection lost after 5 attempts — please refresh the page.')
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
          ws.send(JSON.stringify({ forget_all: 'transaction',            req_id: 9998 }))
          ws.send(JSON.stringify({ forget_all: 'proposal_open_contract', req_id: 9997 }))
        } catch { /**/ }
      }
      pocSubsRef.current.clear()
      pocExitDigitsRef.current.clear()
      ws?.close()
      botWsRef.current = null
    }
  }, [executeTrade, checkStops])

  /* ── Sync running ref ─────────────────────────────────────────────────────
   * executeTrade is NOT called from this effect.
   *
   * The two paths that fire the first trade are:
   *  1. handleToggleRun (synchronous, zero frame-delay)
   *  2. ws.onopen — fires executeTrade when WS reconnects while already running
   *
   * Calling executeTrade here would cause a double-buy: handleToggleRun sends
   * one buy immediately, then this effect fires before the buy response arrives
   * (inTradeRef is still false until response lands), sending a second buy.
   * ── */
  useEffect(() => {
    runningRef.current = running
  }, [running])

  /* ── Account-change watchdog (same as analysis page) ── */
  useEffect(() => {
    const poll = setInterval(async () => {
      if (intentionalClose.current) return
      try {
        const r = await fetch('/api/user/balance', { cache: 'no-store' })
        if (!r.ok) return
        const d = await r.json() as {
          activeAccountId: string
          accounts: { accountId: string; currency: string; isDemo: boolean }[]
        }
        if (d.activeAccountId && connectedAccountRef.current &&
            d.activeAccountId !== connectedAccountRef.current) {
          const acc = d.accounts.find(a => a.accountId === d.activeAccountId)
          if (acc) { setCurrency(acc.currency); currencyRef.current = acc.currency; setAccountLabel(acc.isDemo ? 'Demo' : 'Real') }
          setRunning(false); runningRef.current = false
          botWsRef.current?.close()
        }
      } catch { /**/ }
    }, 20_000)
    return () => clearInterval(poll)
  }, [])

  /* ── Toggle run ── */
  function handleToggleRun() {
    if (running) {
      runningRef.current = false   // sync immediately — prevents race where sell fires before useEffect runs
      ticksAtBuyRef.current = null  // disarm tick gate — prevents a queued tick from firing a new buy
      setRunning(false)
      return
    }
    // Validate before starting
    const s = parseFloat(stake)
    if (isNaN(s) || s < 0.35) { setBotError('Stake must be at least 0.35 USD'); return }
    setBotError(null)
    setStopReason(null)
    const emptyStats = { runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0 }
    statsRef.current = emptyStats
    setStats(emptyStats)
    setTxLog([])

    // Initialize accumulator refs SYNCHRONOUSLY so the first trade uses correct values
    // even before the useEffect runs (which happens after the React render cycle).
    runningRef.current        = true
    currentStakeRef.current   = s
    accumLossRef.current      = 0
    effectiveTypeRef.current  = tradeType
    inTradeRef.current        = false

    setRunning(true)

    // Fire the first buy immediately — skip the ~16ms browser-frame delay
    // that would occur if we waited for useEffect.
    // inTradeRef.current is false so executeTrade will proceed.
    if (botWsRef.current?.readyState === WebSocket.OPEN) {
      executeTrade(botWsRef.current)
    }
    // If WS not yet open, onopen will call executeTrade because runningRef.current = true
  }

  function handleReset() {
    setRunning(false)
    runningRef.current = false
    inTradeRef.current = false
    pendingBuysRef.current.clear()
    currentStakeRef.current = parseFloat(stake) || 1.00
    accumLossRef.current    = 0
    effectiveTypeRef.current = tradeType
    const emptyStats = { runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0 }
    statsRef.current = emptyStats
    setStats(emptyStats)
    setTxLog([])
    setBotError(null)
    setStopReason(null)
  }

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

  const currentDigit = recentDigits[recentDigits.length - 1] ?? null
  const profitColor  = stats.profit > 0 ? '#22c55e' : stats.profit < 0 ? '#ef4444' : '#fff'

  /* ── Analysis card data (recomputed from prices on every tick) ── */
  const sbDigits = useMemo(
    () => prices.map(p => {
      const s = p.toFixed(pipSizeRef.current)
      return parseInt(s[s.length - 1], 10)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices]
  )
  const sbTotal = sbDigits.length

  const sbCard = useMemo(() => {
    const slice = sbDigits.slice(-50)
    const type  = tradeType
    const pred  = analysisDigit

    if (type === 'DIGITEVEN' || type === 'DIGITODD') {
      const even = sbDigits.filter(d => d % 2 === 0).length
      const odd  = sbDigits.filter(d => d % 2 !== 0).length
      const seq  = slice.map(d => d % 2 === 0 ? 'E' : 'O')
      const raw  = slice
      const { count, val } = trailingStreak(seq)
      return { title: 'Even / Odd', seq, raw,
        bars: [
          { label: 'Even', color: '#FCA311', count: even },
          { label: 'Odd',  color: '#ef4444', count: odd  },
        ],
        colorMap: {
          E: { bg: 'rgba(252,163,17,0.15)', border: '#FCA311', text: '#FCA311' },
          O: { bg: 'rgba(239,68,68,0.15)',  border: '#ef4444', text: '#ef4444' },
        } as Record<string, SeqColor>,
        streak: count, streakLabel: val === 'E' ? 'Even' : 'Odd',
        picker: false,
      }
    }
    if (type === 'DIGITOVER' || type === 'DIGITUNDER') {
      const over  = sbDigits.filter(d => d > pred).length
      const under = sbDigits.filter(d => d <= pred).length
      const seq   = slice.map(d => d > pred ? 'O' : 'U')
      const raw   = slice
      const { count, val } = trailingStreak(seq)
      return { title: `Over / Under (barrier ${pred})`, seq, raw,
        bars: [
          { label: 'Over',  color: '#22c55e', count: over  },
          { label: 'Under', color: '#3b82f6', count: under },
        ],
        colorMap: {
          O: { bg: 'rgba(34,197,94,0.15)',  border: '#22c55e', text: '#22c55e' },
          U: { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#3b82f6' },
        } as Record<string, SeqColor>,
        streak: count, streakLabel: val === 'O' ? 'Over' : 'Under',
        picker: true,
      }
    }
    if (type === 'DIGITMATCH' || type === 'DIGITDIFF') {
      const match  = sbDigits.filter(d => d === pred).length
      const differ = sbDigits.filter(d => d !== pred).length
      const seq    = slice.map(d => d === pred ? 'M' : 'D')
      const raw    = slice
      const { count, val } = trailingStreak(seq)
      return { title: `Match / Differ (digit ${pred})`, seq, raw,
        bars: [
          { label: 'Match',  color: '#ef4444', count: match  },
          { label: 'Differ', color: '#a855f7', count: differ },
        ],
        colorMap: {
          M: { bg: 'rgba(239,68,68,0.15)',  border: '#ef4444', text: '#ef4444' },
          D: { bg: 'rgba(168,85,247,0.15)', border: '#a855f7', text: '#a855f7' },
        } as Record<string, SeqColor>,
        streak: count, streakLabel: val === 'M' ? 'Match' : 'Differ',
        picker: true,
      }
    }
    return null
  }, [sbDigits, tradeType, analysisDigit])

  const flashWonForCard: boolean | null  = tradeFlash ? tradeFlash.won : null
  const flashExitDigit: number | undefined = tradeFlash?.exitDigit


  return (
    <div style={{
      background: '#000',
      height: '100%',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>

      {/* ── Page header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.9rem 1.5rem',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#050505', flexShrink: 0,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
            Speed Bot
          </h1>
          <p style={{ margin: 0, fontSize: '0.7rem', color: 'rgba(229,229,229,0.35)', marginTop: '1px' }}>
            High-speed digit trading · {execSpeed === 'turbo' ? 'Turbo mode' : execSpeed === 'fast' ? 'Fast mode' : 'Normal mode'}
          </p>
        </div>

        {/* Status + live price */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          {livePrice && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Live
              </div>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#FCA311', fontVariantNumeric: 'tabular-nums' }}>
                {livePrice.toFixed(2)}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
              background: botError ? '#ef4444' : botReady ? '#22c55e' : '#FCA311',
              boxShadow: botReady && !botError ? '0 0 6px #22c55e88' : 'none',
              animation: botReady && !botError ? 'pulse 2s ease infinite' : 'none',
            }} />
            <span style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.5)' }}>
              {botError ? 'Error' : botReady ? `${accountLabel || 'Connected'} · ${currency}` : 'Connecting…'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Error banner ── */}
      {botError && (
        <div style={{
          padding: '0.6rem 1.5rem',
          background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)',
          color: '#fca5a5', fontSize: '0.78rem', flexShrink: 0,
        }}>
          ⚠ {botError}
        </div>
      )}

      {/* ── Stop reason banner ── */}
      {!running && stopReason && (
        <div style={{
          padding: '0.55rem 1.5rem',
          background: stopReason.startsWith('✅')
            ? 'rgba(34,197,94,0.08)'
            : 'rgba(252,163,17,0.08)',
          borderBottom: `1px solid ${stopReason.startsWith('✅') ? 'rgba(34,197,94,0.2)' : 'rgba(252,163,17,0.2)'}`,
          color: stopReason.startsWith('✅') ? '#86efac' : '#fcd34d',
          fontSize: '0.78rem', fontWeight: 600, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>Bot stopped — {stopReason}</span>
          <button
            onClick={() => setStopReason(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.9rem', opacity: 0.6, padding: '0 0.25rem' }}
          >×</button>
        </div>
      )}

      {/* ── Two-column body ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '340px 1fr 300px',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}>

        {/* ════ LEFT: Config Panel ════ */}
        <div style={{
          borderRight: '1px solid rgba(255,255,255,0.07)',
          overflowY: 'auto',
          padding: '1.25rem 1rem',
          display: 'flex', flexDirection: 'column', gap: '1rem',
          background: '#030d1a',
        }}>

          {/* Strategy selector */}
          <div style={sectionSt}>
            <span style={labelSt}>Strategy</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              {(['standard', 'martingale'] as Strategy[]).map(s => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  disabled={running}
                  style={{
                    padding: '0.6rem',
                    borderRadius: '8px',
                    border: `1px solid ${strategy === s
                      ? (s === 'martingale' ? 'rgba(239,68,68,0.35)' : 'rgba(252,163,17,0.35)')
                      : 'rgba(255,255,255,0.08)'}`,
                    background: strategy === s
                      ? (s === 'martingale' ? 'rgba(239,68,68,0.18)' : 'rgba(252,163,17,0.18)')
                      : 'rgba(255,255,255,0.04)',
                    color: strategy === s
                      ? (s === 'martingale' ? '#ef4444' : '#FCA311')
                      : 'rgba(229,229,229,0.45)',
                    fontWeight: 700, fontSize: '0.82rem',
                    cursor: running ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s', textTransform: 'capitalize',
                  }}
                >
                  {s === 'martingale' ? '📈 Martingale' : '⚡ Standard'}
                </button>
              ))}
            </div>
            <p style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)', margin: '0.5rem 0 0', lineHeight: 1.5 }}>
              {strategy === 'martingale'
                ? 'Stake multiplies after each loss, resets to base on win.'
                : 'Fixed stake each trade. Optional zigzag / alternate-on-loss.'}
            </p>
          </div>

          {/* Market + Trade type */}
          <div style={sectionSt}>
            <span style={labelSt}>Market</span>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} disabled={running} style={{ ...inputSt, cursor: running ? 'not-allowed' : 'pointer', marginBottom: '0.75rem' }}>
              {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
            </select>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.5rem', alignItems: 'end' }}>
              <div>
                <span style={labelSt}>Trade Type</span>
                <select value={tradeType} onChange={e => setTradeType(e.target.value)} disabled={running} style={{ ...inputSt, cursor: running ? 'not-allowed' : 'pointer' }}>
                  {TRADE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {BARRIER_TYPES.has(tradeType) && (
                <div style={{ width: '64px' }}>
                  <span style={labelSt}>Digit</span>
                  <select
                    value={prediction}
                    onChange={e => setPrediction(parseInt(e.target.value, 10))}
                    disabled={running}
                    style={{ ...inputSt, cursor: running ? 'not-allowed' : 'pointer' }}
                  >
                    {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Execution params */}
          <div style={sectionSt}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.65rem', marginBottom: '0.75rem' }}>
              <div>
                <span style={labelSt}>Stake ({currency})</span>
                <input type="number" min="0.35" step="0.01" value={stake}
                  onChange={e => setStake(e.target.value)}
                  disabled={running} style={{ ...inputSt, cursor: running ? 'not-allowed' : 'text' }} />
              </div>
              <div>
                <span style={labelSt}>Ticks (1–9)</span>
                <input type="number" min="1" max="9" step="1" value={ticksDur}
                  onChange={e => setTicksDur(Math.min(9, Math.max(1, parseInt(e.target.value) || 1)))}
                  disabled={running} style={{ ...inputSt, cursor: running ? 'not-allowed' : 'text' }} />
              </div>
            </div>

            {/* Execution speed toggle */}
            <span style={labelSt}>Execution Speed</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
              {(['turbo', 'fast', 'normal'] as ExecSpeed[]).map(sp => (
                <button
                  key={sp}
                  onClick={() => setExecSpeed(sp)}
                  disabled={running}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: `1px solid ${execSpeed === sp ? 'rgba(252,163,17,0.3)' : 'rgba(255,255,255,0.08)'}`,
                    background: execSpeed === sp ? 'rgba(252,163,17,0.15)' : 'rgba(255,255,255,0.04)',
                    color: execSpeed === sp ? '#FCA311' : 'rgba(229,229,229,0.45)',
                    fontWeight: 600, fontSize: '0.75rem',
                    cursor: running ? 'not-allowed' : 'pointer',
                  }}
                >
                  {sp === 'turbo' ? '🚀 Turbo (0ms)' : sp === 'fast' ? '⚡ Fast (0.4s)' : '◎ Normal (1.5s)'}
                </button>
              ))}
            </div>
          </div>

          {/* Risk management */}
          <div style={sectionSt}>
            <span style={labelSt}>Risk Management</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.65rem' }}>
              <div>
                <span style={labelSt}>Take Profit ({currency})</span>
                <input type="number" min="0" step="0.01" value={takeProfit}
                  onChange={e => setTakeProfit(e.target.value)} disabled={running}
                  style={inputSt} placeholder="e.g. 10" />
              </div>
              <div>
                <span style={labelSt}>Stop Loss ({currency})</span>
                <input type="number" min="0" step="0.01" value={stopLoss}
                  onChange={e => setStopLoss(e.target.value)} disabled={running}
                  style={inputSt} placeholder="e.g. 5" />
              </div>
              <div>
                <span style={labelSt}>Max Consecutive Losses</span>
                <input type="number" min="1" step="1" value={maxConsec}
                  onChange={e => setMaxConsec(e.target.value)} disabled={running}
                  style={inputSt} placeholder="e.g. 5" />
              </div>
              <div>
                <span style={labelSt}>Max Contracts / Run</span>
                <input type="number" min="1" step="1" value={maxContracts}
                  onChange={e => setMaxContracts(e.target.value)} disabled={running}
                  style={inputSt} placeholder="e.g. 50" />
              </div>
            </div>

            {/* Live SL vs Stake warning */}
            {(() => {
              const sl = parseFloat(stopLoss)
              const sk = parseFloat(stake)
              if (sl > 0 && sk > 0 && sl < sk) {
                return (
                  <div style={{
                    marginTop: '0.65rem',
                    padding: '0.5rem 0.65rem',
                    background: 'rgba(239,68,68,0.07)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    borderRadius: '8px',
                    fontSize: '0.67rem',
                    color: '#fca5a5',
                    lineHeight: 1.45,
                  }}>
                    ⚠ Stop Loss ({currency} {sl.toFixed(2)}) is less than your stake ({currency} {sk.toFixed(2)}).
                    {strategy === 'martingale'
                      ? ` In Martingale mode a single loss will stop the bot immediately. Set SL ≥ ${currency} ${sk.toFixed(2)} to allow recovery.`
                      : ' A single losing trade will stop the bot.'}
                  </div>
                )
              }
              return null
            })()}
          </div>

          {/* Toggles (Standard only) */}
          {strategy === 'standard' && (
            <div style={sectionSt}>
              <span style={labelSt}>Trade Modifiers</span>
              {[
                {
                  key: 'zigzag' as const,
                  val: zigzag,
                  label: 'Zigzag (alternate every trade)',
                  desc: `Switches between ${TRADE_TYPES.find(t => t.value === tradeType)?.label ?? ''} and ${TRADE_TYPES.find(t => t.value === PAIR_MAP[tradeType])?.label ?? ''} on every tick`,
                  set: (v: boolean) => { setZigzag(v); if (v) setAltOnLoss(false) },
                },
                {
                  key: 'altOnLoss' as const,
                  val: altOnLoss,
                  label: 'Alternate on Loss',
                  desc: 'Switches to the opposite trade type after each loss',
                  set: (v: boolean) => { setAltOnLoss(v); if (v) setZigzag(false) },
                },
              ].map(item => (
                <div key={item.key} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  padding: '0.65rem 0',
                  borderBottom: item.key === 'zigzag' ? '1px solid rgba(255,255,255,0.06)' : 'none',
                }}>
                  <div style={{ paddingRight: '0.75rem' }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: item.val ? '#fff' : 'rgba(229,229,229,0.6)' }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.28)', marginTop: '2px', lineHeight: 1.4 }}>
                      {item.desc}
                    </div>
                  </div>
                  <button
                    onClick={() => !running && item.set(!item.val)}
                    style={{
                      width: '40px', height: '22px', borderRadius: '11px',
                      background: item.val ? '#FCA311' : 'rgba(255,255,255,0.12)',
                      border: 'none', cursor: running ? 'not-allowed' : 'pointer',
                      position: 'relative', flexShrink: 0, transition: 'background 0.2s',
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: '3px',
                      left: item.val ? '21px' : '3px',
                      width: '16px', height: '16px', borderRadius: '50%',
                      background: '#fff', transition: 'left 0.2s',
                    }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Martingale settings */}
          {strategy === 'martingale' && (
            <div style={sectionSt}>
              <span style={labelSt}>Martingale Settings</span>
              <div style={{ marginBottom: '0.75rem' }}>
                <span style={labelSt}>Loss Multiplier</span>
                <input type="number" min="1.1" step="0.1" value={martMult}
                  onChange={e => setMartMult(e.target.value)} disabled={running}
                  style={inputSt} />
                <p style={{ fontSize: '0.63rem', color: 'rgba(229,229,229,0.28)', margin: '0.35rem 0 0', lineHeight: 1.4 }}>
                  After a loss, next stake = accumulated_losses × multiplier. Resets on win.
                </p>
              </div>
              {/* Current effective stake indicator */}
              {running && (
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '0.5rem 0.65rem',
                  background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.15)',
                  borderRadius: '8px', marginTop: '0.5rem',
                }}>
                  <span style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.45)' }}>Next stake</span>
                  <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt2(currentStakeRef.current)} {currency}
                  </span>
                </div>
              )}
            </div>
          )}



        </div>

        {/* ════ RIGHT: Live Panel ════ */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          background: '#000',
        }}>
          {/* Chart — full width, fixed height */}
          <div style={{ padding: '1rem 1.25rem 0', flexShrink: 0 }}>
            <PriceChart
              prices={prices}
              livePrice={livePrice}
              label={MARKETS.find(m => m.symbol === symbol)?.label ?? symbol}
            />
          </div>

          {/* Middle row: Analysis card + Run Statistics stacked */}
          <div style={{
            display: 'flex', flexDirection: 'column',
            gap: '0.75rem', padding: '0.75rem 1.25rem 0',
            overflowY: 'auto', flex: 1, minHeight: 0,
          }}>

          {/* ── Analysis card — updates with tradeType ── */}
          {sbCard && (
            <div style={sectionSt}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.9rem' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {sbCard.title}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                  {sbCard.streak > 0 && (
                    <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#FCA311', background: 'rgba(252,163,17,0.1)', padding: '0.15rem 0.55rem', borderRadius: '20px', border: '1px solid rgba(252,163,17,0.3)' }}>
                      {sbCard.streak}x {sbCard.streakLabel}
                    </span>
                  )}
                  <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)' }}>
                    {ticksTotal.toLocaleString()} ticks
                  </span>
                </div>
              </div>

              {/* Digit picker (Over/Under, Match/Differ) */}
              {sbCard.picker && (
                <SbDigitPicker selected={analysisDigit} onSelect={setAnalysisDigit} disabled={false} />
              )}

              {/* Bars */}
              {sbCard.bars.map(b => (
                <SbBar key={b.label} label={b.label} color={b.color} count={b.count} total={sbTotal} />
              ))}

              {/* Sequence */}
              <SbSequence
                seq={sbCard.seq.slice(-20)}
                rawDigits={sbCard.raw.slice(-20)}
                colorMap={sbCard.colorMap}
                flashWon={flashWonForCard}
                flashExitDigit={flashExitDigit}
                ticksTotal={ticksTotal}
              />
            </div>
          )}

          {/* Stats grid */}
          <div style={sectionSt}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: '0.85rem',
            }}>
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff' }}>
                Run Statistics
              </span>
              {running && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', animation: 'pulse 1.5s infinite' }} />
                  <span style={{ fontSize: '0.68rem', color: '#22c55e', fontWeight: 600 }}>RUNNING</span>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
              {[
                { label: 'Total Stake',  value: `${fmt2(stats.totalStake)} ${currency}`, color: '#fff' },
                { label: 'Total Payout', value: `${fmt2(stats.totalPayout)} ${currency}`, color: '#fff' },
                { label: 'No. of Runs',  value: String(stats.runs), color: '#fff' },
              ].map(s => (
                <div key={s.label} style={{ textAlign: 'center', padding: '0.6rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.35)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
              {[
                { label: 'Won',       value: String(stats.won),    color: stats.won  > 0 ? '#22c55e' : '#fff' },
                { label: 'Lost',      value: String(stats.lost),   color: stats.lost > 0 ? '#ef4444' : '#fff' },
                {
                  label: 'Profit/Loss',
                  value: `${stats.profit >= 0 ? '+' : ''}${fmt2(stats.profit)} ${currency}`,
                  color: profitColor,
                },
              ].map(s => (
                <div key={s.label} style={{ textAlign: 'center', padding: '0.6rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.35)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Risk bars */}
            {stats.runs > 0 && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {/* Win rate bar */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                    <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.4)' }}>Win Rate</span>
                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: stats.won > stats.lost ? '#22c55e' : '#ef4444' }}>
                      {stats.runs > 0 ? ((stats.won / stats.runs) * 100).toFixed(1) : '0.0'}%
                    </span>
                  </div>
                  <div style={{ height: '5px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: '99px',
                      width: `${stats.runs > 0 ? (stats.won / stats.runs) * 100 : 0}%`,
                      background: 'linear-gradient(90deg, #22c55e, #16a34a)',
                      transition: 'width 0.5s ease',
                    }} />
                  </div>
                </div>
                {/* Consecutive loss warning */}
                {stats.consecLosses > 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                    padding: '0.4rem 0.65rem',
                    background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
                    borderRadius: '7px',
                  }}>
                    <span style={{ fontSize: '0.68rem', color: '#fca5a5' }}>
                      {stats.consecLosses} consecutive loss{stats.consecLosses !== 1 ? 'es' : ''}
                      {strategy === 'martingale' && ` · next stake: ${fmt2(currentStakeRef.current)} ${currency}`}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          </div>{/* end middle row grid */}

        </div>{/* end middle panel */}

        {/* ════ RIGHT: Transactions Panel ════ */}
        <div style={{
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          background: '#020a14',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          paddingBottom: '64px',
        }}>
          {/* Header */}
          <div style={{
            padding: '1rem 1rem 0.75rem',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff' }}>Transactions</span>
            <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)' }}>{txLog.length} records</span>
          </div>

          {/* Scrollable list */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 0.75rem' }}>
            {txLog.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem 0', color: 'rgba(229,229,229,0.2)', fontSize: '0.75rem' }}>
                No trades yet.<br />Press START to begin.
              </div>
            ) : (
              <>
                {/* Column headers */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 60px 55px 65px',
                  padding: '0.5rem 0.25rem 0.25rem',
                  position: 'sticky', top: 0, background: '#020a14', zIndex: 1,
                }}>
                  {['Time','Type','Stake','P/L'].map(h => (
                    <span key={h} style={{ fontSize: '0.57rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</span>
                  ))}
                </div>
                {txLog.map(tx => {
                  // settled: use final payout; pending: use live currentPnl if available
                  const pl: number | null = tx.settled
                    ? tx.payout - tx.stake
                    : tx.currentPnl ?? null
                  const noData = !tx.settled && pl === null
                  const dotBg  = tx.settled
                    ? (tx.won ? '#22c55e' : '#ef4444')
                    : pl != null
                      ? (pl >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)')
                      : 'rgba(251,191,36,0.8)'   // amber = waiting for first POC tick
                  return (
                    <div key={tx.id} style={{
                      display: 'grid', gridTemplateColumns: '1fr 60px 55px 65px',
                      alignItems: 'center', padding: '0.45rem 0.25rem',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}>
                      <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.35)', fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(tx.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0, background: dotBg }} />
                        <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.5)' }}>
                          {TRADE_TYPES.find(t => t.value === tx.contractType)?.label ?? tx.contractType}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.5)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt2(tx.stake)}
                      </span>
                      <span style={{ fontSize: '0.62rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                        color: noData
                          ? 'rgba(229,229,229,0.25)'
                          : pl != null && pl >= 0 ? '#22c55e' : '#ef4444',
                        filter: noData ? 'blur(3px)' : 'none',
                      }}>
                        {noData
                          ? '···'
                          : `${pl != null && pl >= 0 ? '+' : ''}${fmt2(pl ?? 0)}`
                        }
                      </span>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Sticky START / STOP bar ── */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 150,
        background: 'rgba(5,5,5,0.96)', backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '0.75rem', padding: '10px 24px', height: '64px',
      }}>
        <button
          onClick={handleToggleRun}
          disabled={!botReady && !running}
          style={{
            width: '220px', height: '44px',
            borderRadius: '10px', border: 'none',
            background: !botReady && !running
              ? '#1a1a1a'
              : running
                ? 'linear-gradient(135deg, #dc2626, #b91c1c)'
                : 'linear-gradient(135deg, #16a34a, #15803d)',
            color: !botReady && !running ? '#555' : '#fff',
            fontWeight: 800, fontSize: '0.95rem',
            cursor: !botReady && !running ? 'not-allowed' : 'pointer',
            letterSpacing: '0.06em',
            transition: 'all 0.2s',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            boxShadow: running ? '0 0 18px rgba(220,38,38,0.4)' : (!botReady && !running ? 'none' : '0 0 18px rgba(22,163,74,0.35)'),
          }}
        >
          {running ? (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="1" y="1" width="10" height="10" rx="2"/>
              </svg>
              STOP
            </>
          ) : (
            <>
              <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor">
                <polygon points="0,0 11,6.5 0,13"/>
              </svg>
              {!botReady ? 'Connecting…' : 'START'}
            </>
          )}
        </button>
        <button
          onClick={handleReset}
          style={{
            height: '44px', padding: '0 1.25rem',
            borderRadius: '10px',
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent', color: 'rgba(229,229,229,0.5)',
            fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'rgba(255,255,255,0.07)'; b.style.color = '#fff' }}
          onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'transparent'; b.style.color = 'rgba(229,229,229,0.5)' }}
        >
          Reset
        </button>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes digitPop { 0%{transform:scale(1.3);opacity:0.6} 100%{transform:scale(1);opacity:1} }
      `}</style>
    </div>
  )
}
