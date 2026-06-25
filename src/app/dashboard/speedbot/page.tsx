'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

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
type ExecSpeed = 'fast' | 'normal'

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
export default function SpeedbotPage() {

  /* ── Config state ── */
  const [strategy,    setStrategy]   = useState<Strategy>('standard')
  const [symbol,      setSymbol]     = useState('1HZ100V')
  const [tradeType,   setTradeType]  = useState('DIGITEVEN')
  const [prediction,  setPrediction] = useState(5)       // barrier digit for OVER/UNDER/MATCH/DIFF
  const [ticksDur,    setTicksDur]   = useState(1)        // contract duration in ticks (1-9)
  const [stake,       setStake]      = useState('1.00')
  const [execSpeed,   setExecSpeed]  = useState<ExecSpeed>('normal')
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
  const [currency,    setCurrency]   = useState('USD')
  const [accountLabel,setAccountLabel] = useState('')
  const [stats,       setStats]      = useState<SpeedStats>({
    runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0,
  })
  const [txLog,       setTxLog]      = useState<TxRow[]>([])

  /* ── Tick state ── */
  const [livePrice,   setLivePrice]  = useState<number | null>(null)
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
  const execSpeedRef    = useRef<ExecSpeed>('normal')
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
  /** Tracks current effective trade type (may zigzag or alternate) */
  const effectiveTypeRef  = useRef('DIGITEVEN')
  /** Accumulated loss stake for martingale recovery calculation */
  const accumLossRef      = useRef(0)

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
      }

      if (msg.msg_type === 'tick') {
        // pip_size is REQUIRED on every tick per ticks_response.schema.json
        const tickData = (msg as { tick: { quote: number; pip_size: number } }).tick
        if (tickData.pip_size != null) pipSizeRef.current = tickData.pip_size
        const q = tickData.quote
        livePriceRef.current = q      // sync immediately — critical for entry spot accuracy
        setLivePrice(q)
        setRecentDigits(prev => [...prev.slice(-29), lastDigit(q, pipSizeRef.current)])
        setTicksTotal(t => t + 1)
      }
    }

    ws.onerror = () => {}
    ws.onclose = () => {}

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 9999 })) } catch { /**/ }
      }
      ws.close()
    }
  }, [symbol])

  /* ── Check risk stops after each contract settles ── */
  const checkStops = useCallback((updatedStats: SpeedStats): boolean => {
    const tp   = parseFloat(takeProfitRef.current)
    const sl   = parseFloat(stopLossRef.current)
    const maxC = parseInt(maxConsecRef.current, 10)
    const maxN = parseInt(maxContractsRef.current, 10)

    if (Number.isFinite(tp) && tp > 0 && updatedStats.profit >= tp)          return true
    if (Number.isFinite(sl) && sl > 0 && updatedStats.profit <= -sl)         return true
    if (Number.isFinite(maxC) && maxC > 0 && updatedStats.consecLosses >= maxC) return true
    if (Number.isFinite(maxN) && maxN > 0 && updatedStats.runs >= maxN)      return true
    return false
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

        /* ── Buy response ── */
        if (msg.msg_type === 'buy') {
          const buy = msg.buy as { contract_id: number; buy_price: number }
          const reqId = msg.req_id as number | undefined
          if (reqId != null) pendingSpotsByReq.current.delete(reqId)
          pendingBuysRef.current.set(buy.contract_id, { buyPrice: buy.buy_price })

          setStats(prev => ({
            ...prev,
            totalStake: parseFloat((prev.totalStake + buy.buy_price).toFixed(2)),
            runs: prev.runs + 1,
          }))
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

            const { buyPrice } = pending
            const payout   = Math.max(0, tx.amount)
            const won      = payout > 0
            const pl       = parseFloat((payout - buyPrice).toFixed(2))

            /* ── Update running stats and check risk stops ── */
            setStats(prev => {
              const newTotalPayout  = parseFloat((prev.totalPayout + payout).toFixed(2))
              const newTotalStake   = prev.totalStake  // already added on buy
              const newProfit       = parseFloat((newTotalPayout - newTotalStake).toFixed(2))
              const newConsec       = won ? 0 : prev.consecLosses + 1
              const updated: SpeedStats = {
                ...prev,
                totalPayout:  newTotalPayout,
                profit:       newProfit,
                won:          won ? prev.won + 1 : prev.won,
                lost:         won ? prev.lost : prev.lost + 1,
                consecLosses: newConsec,
              }
              /* Risk stops — checked inside setStats callback for accuracy */
              if (checkStops(updated)) {
                setRunning(false)
                runningRef.current = false
              }
              return updated
            })

            /* ── Append to tx log ── */
            setTxLog(prev => [{
              id:           tx.contract_id!,
              time:         Date.now(),
              contractType: effectiveTypeRef.current,
              stake:        buyPrice,
              payout,
              won,
            }, ...prev].slice(0, 60))

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

            /* ── Schedule next trade if still running ── */
            if (runningRef.current && ws?.readyState === WebSocket.OPEN) {
              const delay = execSpeedRef.current === 'fast' ? 400 : 1500
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
        try { ws.send(JSON.stringify({ forget_all: 'transaction', req_id: 9998 })) } catch { /**/ }
      }
      ws?.close()
      botWsRef.current = null
    }
  }, [executeTrade, checkStops])

  /* ── Sync running state → ref + fire first trade ── */
  useEffect(() => {
    runningRef.current = running
    if (running) {
      // Reset accumulator refs on new run
      currentStakeRef.current = parseFloat(stake) || 1.00
      accumLossRef.current    = 0
      effectiveTypeRef.current = tradeType
      inTradeRef.current      = false
      if (botWsRef.current?.readyState === WebSocket.OPEN) {
        executeTrade(botWsRef.current)
      }
    }
  }, [running, executeTrade, stake, tradeType])

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
      setRunning(false)
      return
    }
    // Validate before starting
    const s = parseFloat(stake)
    if (isNaN(s) || s < 0.35) { setBotError('Stake must be at least 0.35 USD'); return }
    setBotError(null)
    setStats({ runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0 })
    setTxLog([])
    setRunning(true)
  }

  function handleReset() {
    setRunning(false)
    runningRef.current = false
    inTradeRef.current = false
    pendingBuysRef.current.clear()
    currentStakeRef.current = parseFloat(stake) || 1.00
    accumLossRef.current    = 0
    effectiveTypeRef.current = tradeType
    setStats({ runs: 0, won: 0, lost: 0, profit: 0, totalStake: 0, totalPayout: 0, consecLosses: 0 })
    setTxLog([])
    setBotError(null)
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

  return (
    <div style={{
      background: '#000', minHeight: '100%',
      display: 'flex', flexDirection: 'column',
      paddingBottom: '0',
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
            High-speed digit trading · {execSpeed === 'fast' ? 'Fast mode' : 'Normal mode'}
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

      {/* ── Two-column body ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '340px 1fr',
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
              {(['fast', 'normal'] as ExecSpeed[]).map(sp => (
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
                    fontWeight: 600, fontSize: '0.78rem',
                    cursor: running ? 'not-allowed' : 'pointer',
                  }}
                >
                  {sp === 'fast' ? '⚡ Fast (0.4s)' : '◎ Normal (1.5s)'}
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

          {/* Run / Stop + Reset */}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleToggleRun}
              disabled={!botReady && !running}
              style={{
                flex: 1, padding: '0.85rem',
                borderRadius: '10px', border: 'none',
                background: !botReady && !running
                  ? '#1a1a1a'
                  : running
                    ? 'linear-gradient(135deg, #dc2626, #b91c1c)'
                    : 'linear-gradient(135deg, #16a34a, #15803d)',
                color: !botReady && !running ? '#555' : '#fff',
                fontWeight: 800, fontSize: '0.92rem',
                cursor: !botReady && !running ? 'not-allowed' : 'pointer',
                letterSpacing: '0.05em',
                transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
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
                padding: '0.85rem 1rem',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'transparent', color: 'rgba(229,229,229,0.5)',
                fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'rgba(255,255,255,0.07)'; b.style.color = '#fff' }}
              onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'transparent'; b.style.color = 'rgba(229,229,229,0.5)' }}
            >
              Reset
            </button>
          </div>

        </div>

        {/* ════ RIGHT: Live Panel ════ */}
        <div style={{
          overflowY: 'auto',
          padding: '1.25rem',
          display: 'flex', flexDirection: 'column', gap: '1.25rem',
          background: '#000',
        }}>

          {/* Digit visualization */}
          <div style={sectionSt}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: '0.85rem',
            }}>
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff' }}>
                Last Digit Stream
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.35)' }}>
                  {ticksTotal.toLocaleString()} ticks processed
                </span>
                {currentDigit !== null && (
                  <div style={{
                    width: '36px', height: '36px', borderRadius: '50%',
                    background: DIGIT_COLORS[currentDigit],
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 800, fontSize: '1rem', color: '#000',
                    boxShadow: `0 0 16px ${DIGIT_COLORS[currentDigit]}66`,
                    animation: 'digitPop 0.25s ease',
                  }}>
                    {currentDigit}
                  </div>
                )}
              </div>
            </div>

            {/* Digit sequence bubbles */}
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              {recentDigits.map((d, i) => {
                const isLast = i === recentDigits.length - 1
                return (
                  <div key={i} style={{
                    width: '28px', height: '28px', borderRadius: '7px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.72rem', fontWeight: 700,
                    background: isLast ? DIGIT_COLORS[d] : `${DIGIT_COLORS[d]}22`,
                    color:      isLast ? '#000'           : DIGIT_COLORS[d],
                    border:     `1.5px solid ${DIGIT_COLORS[d]}${isLast ? '' : '55'}`,
                    transition: 'all 0.15s',
                    opacity: 0.4 + 0.6 * (i / recentDigits.length),
                  }}>
                    {d}
                  </div>
                )
              })}
            </div>
          </div>

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

          {/* Transaction log */}
          <div style={sectionSt}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem' }}>
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff' }}>
                Transactions
              </span>
              <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)' }}>
                {txLog.length} records
              </span>
            </div>

            {txLog.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem 0', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>
                No trades yet. Press START to begin.
              </div>
            ) : (
              <div>
                {/* Header */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 80px 80px 70px',
                  padding: '0.35rem 0.5rem', marginBottom: '0.25rem',
                }}>
                  {['Time', 'Type', 'Stake', 'P/L'].map(h => (
                    <span key={h} style={{ fontSize: '0.58rem', fontWeight: 700, color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</span>
                  ))}
                </div>
                {txLog.map(tx => {
                  const pl = tx.payout - tx.stake
                  return (
                    <div key={tx.id} style={{
                      display: 'grid', gridTemplateColumns: '1fr 80px 80px 70px',
                      alignItems: 'center', padding: '0.45rem 0.5rem',
                      borderRadius: '6px', transition: 'background 0.1s',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}
                      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'}
                      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                    >
                      <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.38)', fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(tx.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{
                          width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                          background: tx.won ? '#22c55e' : '#ef4444',
                        }} />
                        <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.55)' }}>
                          {TRADE_TYPES.find(t => t.value === tx.contractType)?.label ?? tx.contractType}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.55)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt2(tx.stake)}
                      </span>
                      <span style={{
                        fontSize: '0.72rem', fontWeight: 700,
                        color: pl >= 0 ? '#22c55e' : '#ef4444',
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {pl >= 0 ? '+' : ''}{fmt2(pl)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes digitPop { 0%{transform:scale(1.3);opacity:0.6} 100%{transform:scale(1);opacity:1} }
      `}</style>
    </div>
  )
}
