'use client'

/**
 * Lima Trade — Bot Builder v145
 *
 * DBot-inspired visual block-based bot builder.
 * Four expandable blocks form the bot's strategy:
 *   1. Market & Trade  — symbol, contract type, barrier, duration
 *   2. Purchase        — initial stake
 *   3. Staking         — Fixed / Martingale / D'Alembert / Fibonacci
 *   4. Stop Conditions — take profit, stop loss, max trades
 *
 * Auth WS trading loop: same proposal → buy → POC pattern as charts page.
 * Backward-compatible: reads lima_trade_pending_bot from localStorage on mount.
 *
 * ONLY this file is changed — no other pages/routes are touched.
 */

import { useEffect, useRef, useState, useCallback, type ReactNode, type CSSProperties } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────
const NEEDS_BARRIER = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF']
const FIB_SEQ = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55]

const MARKETS = [
  { value: 'R_10',    label: 'Volatility 10 Index'  },
  { value: 'R_25',    label: 'Volatility 25 Index'  },
  { value: 'R_50',    label: 'Volatility 50 Index'  },
  { value: 'R_75',    label: 'Volatility 75 Index'  },
  { value: 'R_100',   label: 'Volatility 100 Index' },
  { value: '1HZ10V',  label: 'Volatility 10 (1s)'   },
  { value: '1HZ25V',  label: 'Volatility 25 (1s)'   },
  { value: '1HZ50V',  label: 'Volatility 50 (1s)'   },
  { value: '1HZ75V',  label: 'Volatility 75 (1s)'   },
  { value: '1HZ100V', label: 'Volatility 100 (1s)'  },
]

const CONTRACT_TYPES = [
  { value: 'DIGITOVER',  label: 'Over',   needsBarrier: true  },
  { value: 'DIGITUNDER', label: 'Under',  needsBarrier: true  },
  { value: 'DIGITEVEN',  label: 'Even',   needsBarrier: false },
  { value: 'DIGITODD',   label: 'Odd',    needsBarrier: false },
  { value: 'DIGITMATCH', label: 'Match',  needsBarrier: true  },
  { value: 'DIGITDIFF',  label: 'Differ', needsBarrier: true  },
  { value: 'CALL',       label: 'Rise',   needsBarrier: false },
  { value: 'PUT',        label: 'Fall',   needsBarrier: false },
]

type StakingStrategy = 'fixed' | 'martingale' | 'dalembert' | 'fibonacci'

const STAKING_LABELS: Record<StakingStrategy, string> = {
  fixed:      'Fixed',
  martingale: 'Martingale',
  dalembert:  "D'Alembert",
  fibonacci:  'Fibonacci',
}
const STAKING_DESC: Record<StakingStrategy, string> = {
  fixed:      'Stake stays the same every trade.',
  martingale: 'Loss → multiply stake. Win → reset to initial. High variance.',
  dalembert:  'Loss → add one unit. Win → subtract one unit. More controlled.',
  fibonacci:  'Advances the Fibonacci sequence on loss, steps back two on win.',
}

// ── Theme (CSS variables — toggled by html.light class) ──────────────────────
import { bg0, bg1, bg2, bdr, txt0, txt1, txt2, green, red, amber, blue } from '@/lib/colors'

// ── Shared input styles ───────────────────────────────────────────────────────
const inputBase: CSSProperties = {
  background: bg0, border: `1px solid ${bdr}`, borderRadius: 6,
  padding: '7px 10px', color: txt0, fontSize: 12, outline: 'none',
  width: '100%', boxSizing: 'border-box',
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface TradeRecord { id: number; won: boolean; profit: number; stake: number }

// ── Component ─────────────────────────────────────────────────────────────────
export default function BotBuilderPage() {

  // ── Bot config ───────────────────────────────────────────────────────────────
  const [market,          setMarket]          = useState('R_100')
  const [contractType,    setContractType]    = useState('DIGITOVER')
  const [barrier,         setBarrier]         = useState('5')
  const [duration,        setDuration]        = useState(1)
  const [tickInterval,    setTickInterval]    = useState(1)   // ticks to wait between trades
  const [initialStake,    setInitialStake]    = useState('1.00')
  const [staking,         setStaking]         = useState<StakingStrategy>('martingale')
  const [multiplier,      setMultiplier]      = useState('2')
  const [unit,            setUnit]            = useState('0.50')
  const [maxStake,        setMaxStake]        = useState('50.00')
  // Stop conditions
  const [tpOn,   setTpOn]   = useState(false)
  const [tpAmt,  setTpAmt]  = useState('10.00')
  const [slOn,   setSlOn]   = useState(false)
  const [slAmt,  setSlAmt]  = useState('10.00')
  const [mtOn,   setMtOn]   = useState(false)
  const [mtAmt,  setMtAmt]  = useState('20')
  // UI
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(new Set(['trade', 'purchase', 'staking', 'stop']))

  // ── Running state ────────────────────────────────────────────────────────────
  const [running,    setRunning]    = useState(false)
  const [paused,     setPaused]     = useState(false)
  const [balance,    setBalance]    = useState<number | null>(null)
  const [currency,   setCurrency]   = useState('USD')
  const [authReady,  setAuthReady]  = useState(false)
  const [authErr,    setAuthErr]    = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<'won' | 'lost' | null>(null)
  const [stats,      setStats]      = useState({ trades: 0, wins: 0, losses: 0, profit: 0, currentStake: 1 })
  const [trades,     setTrades]     = useState<TradeRecord[]>([])
  // Live tick sequence (public WS)
  const [liveDigits, setLiveDigits] = useState<number[]>([])
  const [livePriceDisp, setLivePriceDisp] = useState<string | null>(null)
  const [pubConnected, setPubConnected] = useState(false)
  const [tickCountdown, setTickCountdown] = useState(0)   // ticks remaining before next trade
  const pubWsRef          = useRef<WebSocket | null>(null)
  const liveDigitsRef     = useRef<number[]>([])
  const pipSzRef          = useRef(2)
  const marketSymRef      = useRef(market)
  const tickIntervalRef    = useRef(1)
  const tickCountdownRef   = useRef(0)
  const waitingForTicksRef = useRef(false)
  const settlementDoneRef  = useRef(false)  // contract settled while countdown running
  const countdownDoneRef   = useRef(false)  // countdown finished while awaiting settlement

  // ── Stable refs ───────────────────────────────────────────────────────────────
  const marketRef       = useRef(market)
  const ctRef           = useRef(contractType)
  const barrierRef      = useRef(barrier)
  const durationRef     = useRef(duration)
  const initStakeRef    = useRef(parseFloat(initialStake) || 1)
  const curStakeRef     = useRef(parseFloat(initialStake) || 1)
  const stakingRef      = useRef(staking)
  const multiplierRef   = useRef(parseFloat(multiplier) || 2)
  const unitRef         = useRef(parseFloat(unit) || 0.5)
  const maxStakeRef     = useRef(parseFloat(maxStake) || 50)
  const tpOnRef         = useRef(tpOn)
  const tpAmtRef        = useRef(parseFloat(tpAmt) || 10)
  const slOnRef         = useRef(slOn)
  const slAmtRef        = useRef(parseFloat(slAmt) || 10)
  const mtOnRef         = useRef(mtOn)
  const mtAmtRef        = useRef(parseInt(mtAmt) || 20)
  const totalProfitRef  = useRef(0)
  const tradeCountRef   = useRef(0)
  const fibPosRef       = useRef(0)
  const currencyRef     = useRef('USD')
  const authRef         = useRef<WebSocket | null>(null)
  const runningRef      = useRef(false)
  const pausedRef       = useRef(false)
  const proposalIdRef   = useRef<string | null>(null)
  const nextTradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)  // cancellable next-trade delay
  const stopBotRef      = useRef<() => void>(() => {})

  // Sync refs on every state change
  useEffect(() => { marketRef.current     = market                        }, [market])
  useEffect(() => { ctRef.current         = contractType                  }, [contractType])
  useEffect(() => { barrierRef.current    = barrier                       }, [barrier])
  useEffect(() => { durationRef.current   = duration                      }, [duration])
  useEffect(() => { initStakeRef.current  = parseFloat(initialStake) || 1 }, [initialStake])
  useEffect(() => { stakingRef.current    = staking                       }, [staking])
  useEffect(() => { multiplierRef.current = parseFloat(multiplier) || 2   }, [multiplier])
  useEffect(() => { unitRef.current       = parseFloat(unit) || 0.5       }, [unit])
  useEffect(() => { maxStakeRef.current   = parseFloat(maxStake) || 50    }, [maxStake])
  useEffect(() => { tpOnRef.current       = tpOn                          }, [tpOn])
  useEffect(() => { tpAmtRef.current      = parseFloat(tpAmt) || 10       }, [tpAmt])
  useEffect(() => { slOnRef.current       = slOn                          }, [slOn])
  useEffect(() => { slAmtRef.current      = parseFloat(slAmt) || 10       }, [slAmt])
  useEffect(() => { mtOnRef.current       = mtOn                          }, [mtOn])
  useEffect(() => { mtAmtRef.current      = parseInt(mtAmt) || 20         }, [mtAmt])
  useEffect(() => { tickIntervalRef.current = tickInterval                 }, [tickInterval])

  // ── Load from localStorage (backward compat with Free Bots flow) ─────────────
  useEffect(() => {
    const raw = localStorage.getItem('lima_trade_pending_bot')
    if (!raw) return
    try {
      const b = JSON.parse(raw)
      if (b.market)        setMarket(b.market)
      if (b.contract_type) setContractType(b.contract_type)
      const barVal = b.params?.barrier ?? b.params?.digit
      if (barVal) setBarrier(String(barVal))
      if (b.stake) setInitialStake(b.stake)
      if (b.params?.multiplier) { setStaking('martingale'); setMultiplier(b.params.multiplier) }
      if (b.params?.unit)       { setStaking('dalembert');  setUnit(b.params.unit) }
      if (b.params?.max_stake)  setMaxStake(b.params.max_stake)
    } catch { /**/ }
  }, [])

  // ── Subscribe proposal ────────────────────────────────────────────────────────
  const subscribeProposal = useCallback(() => {
    if (!runningRef.current) return  // bail immediately if bot was stopped
    const ws = authRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'proposal' }))
    proposalIdRef.current = null
    const ct = ctRef.current
    const req: Record<string, unknown> = {
      proposal: 1, subscribe: 1,
      amount: curStakeRef.current, basis: 'stake',
      currency: currencyRef.current || 'USD',
      underlying_symbol: marketRef.current,
      contract_type: ct,
      duration: durationRef.current, duration_unit: 't',
    }
    if (NEEDS_BARRIER.includes(ct)) req.barrier = barrierRef.current
    ws.send(JSON.stringify(req))
  }, [])

  // ── Controls ──────────────────────────────────────────────────────────────────
  const stopBot = useCallback(() => {
    runningRef.current = false
    pausedRef.current  = false
    // Cancel any pending next-trade timer or tick countdown so no extra trade fires
    if (nextTradeTimerRef.current) { clearTimeout(nextTradeTimerRef.current); nextTradeTimerRef.current = null }
    waitingForTicksRef.current = false
    tickCountdownRef.current   = 0
    settlementDoneRef.current  = false
    countdownDoneRef.current   = false
    setTickCountdown(0)
    setRunning(false); setPaused(false)
    authRef.current?.send(JSON.stringify({ forget_all: 'proposal' }))
    proposalIdRef.current = null
  }, [])
  useEffect(() => { stopBotRef.current = stopBot }, [stopBot])

  const resetStats = useCallback(() => {
    totalProfitRef.current = 0
    tradeCountRef.current  = 0
    fibPosRef.current      = 0
    curStakeRef.current    = initStakeRef.current
    setStats({ trades: 0, wins: 0, losses: 0, profit: 0, currentStake: initStakeRef.current })
    setTrades([])
  }, [])

  const runBot = useCallback(() => {
    // Reset staking position for new run; cumulative stats persist until manual reset
    fibPosRef.current      = 0
    curStakeRef.current    = initStakeRef.current
    setStats(prev => ({ ...prev, currentStake: initStakeRef.current }))
    runningRef.current = true
    pausedRef.current  = false
    setRunning(true); setPaused(false)
    subscribeProposal()
  }, [subscribeProposal])

  const pauseBot = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
    waitingForTicksRef.current = false
    tickCountdownRef.current   = 0
    settlementDoneRef.current  = false
    countdownDoneRef.current   = false
    setTickCountdown(0)
    authRef.current?.send(JSON.stringify({ forget_all: 'proposal' }))
    proposalIdRef.current = null
  }, [])

  const resumeBot = useCallback(() => {
    pausedRef.current = false
    setPaused(false)
    subscribeProposal()
  }, [subscribeProposal])

  // ── Auth WS ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket
    let alive = true

    const connect = async () => {
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) {
          if (!alive) return
          setAuthErr('Reconnecting…')
          setTimeout(connect, 3000)
          return
        }
        const { wsUrl, token } = await r.json() as { wsUrl: string; token: string }
        ws = new WebSocket(wsUrl)
        authRef.current = ws

        ws.onopen = () => {
          if (!alive) return
          // Legacy Deriv WS: must authorize before any other calls
          ws.send(JSON.stringify({ authorize: token }))
        }

        ws.onmessage = (e) => {
          if (!alive) return
          try {
            const msg = JSON.parse(e.data)

            // Legacy WS: authorize response — now safe to subscribe
            if (msg.authorize) {
              ws.send(JSON.stringify({ balance: 1, subscribe: 1 }))
              setAuthReady(true); setAuthErr(null)
              if (runningRef.current && !pausedRef.current) {
                proposalIdRef.current = null
                if (nextTradeTimerRef.current) clearTimeout(nextTradeTimerRef.current)
                nextTradeTimerRef.current = setTimeout(subscribeProposal, 400)
              }
              return
            }

            if (msg.balance) {
              const b   = Number(msg.balance.balance) || 0
              const cur = msg.balance.currency ?? 'USD'
              setBalance(b)
              setCurrency(cur)
              currencyRef.current = cur
              window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: b, currency: cur } }))
            }

            // Proposal arrived → auto-buy
            if (msg.proposal && runningRef.current && !pausedRef.current) {
              const p = msg.proposal
              if (!proposalIdRef.current && p.id) {
                proposalIdRef.current = p.id
                ws.send(JSON.stringify({ buy: p.id, price: +(Number(p.ask_price) * 1.02).toFixed(2) }))
              }
            }

            // Buy confirmed → subscribe open contract + start tick countdown
            if (msg.buy) {
              ws.send(JSON.stringify({ forget_all: 'proposal' }))
              proposalIdRef.current = null
              if (msg.buy.contract_id) {
                ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: msg.buy.contract_id, subscribe: 1 }))
              }
              // Start countdown from buy entry so "trade every N ticks" is entry-to-entry
              if (runningRef.current && !pausedRef.current && tickIntervalRef.current > 1) {
                settlementDoneRef.current  = false
                countdownDoneRef.current   = false
                tickCountdownRef.current   = tickIntervalRef.current
                waitingForTicksRef.current = true
                setTickCountdown(tickIntervalRef.current)
              }
            }

            // Contract settled
            if (msg.proposal_open_contract) {
              const poc = msg.proposal_open_contract
              if ((poc.is_sold === 1 || poc.status === 'sold') && poc.contract_id) {
                const profit = Number(poc.profit) || 0
                const won    = profit >= 0
                const stake  = curStakeRef.current

                setLastResult(won ? 'won' : 'lost')
                setTimeout(() => setLastResult(null), 1200)

                // ── Staking logic ─────────────────────────────────────────
                const s = stakingRef.current
                if (won) {
                  if (s === 'fixed' || s === 'martingale') {
                    curStakeRef.current = initStakeRef.current
                  } else if (s === 'dalembert') {
                    curStakeRef.current = Math.max(
                      initStakeRef.current,
                      parseFloat((curStakeRef.current - unitRef.current).toFixed(2))
                    )
                  } else if (s === 'fibonacci') {
                    fibPosRef.current = Math.max(0, fibPosRef.current - 2)
                    curStakeRef.current = parseFloat(
                      (initStakeRef.current * FIB_SEQ[Math.min(fibPosRef.current, FIB_SEQ.length - 1)]).toFixed(2)
                    )
                  }
                } else {
                  if (s === 'martingale') {
                    curStakeRef.current = Math.min(
                      parseFloat((curStakeRef.current * multiplierRef.current).toFixed(2)),
                      maxStakeRef.current
                    )
                  } else if (s === 'dalembert') {
                    curStakeRef.current = Math.min(
                      parseFloat((curStakeRef.current + unitRef.current).toFixed(2)),
                      maxStakeRef.current
                    )
                  } else if (s === 'fibonacci') {
                    fibPosRef.current = Math.min(fibPosRef.current + 1, FIB_SEQ.length - 1)
                    curStakeRef.current = Math.min(
                      parseFloat((initStakeRef.current * FIB_SEQ[fibPosRef.current]).toFixed(2)),
                      maxStakeRef.current
                    )
                  }
                  // fixed: no change
                }

                // ── Update stats ──────────────────────────────────────────
                tradeCountRef.current  += 1
                totalProfitRef.current  = parseFloat((totalProfitRef.current + profit).toFixed(2))
                const rec: TradeRecord  = { id: tradeCountRef.current, won, profit, stake }
                setTrades(prev => [rec, ...prev].slice(0, 30))
                setStats(prev => ({
                  trades:       prev.trades + 1,
                  wins:         prev.wins   + (won ? 1 : 0),
                  losses:       prev.losses + (won ? 0 : 1),
                  profit:       totalProfitRef.current,
                  currentStake: curStakeRef.current,
                }))

                // ── Stop conditions ───────────────────────────────────────
                const shouldStop =
                  (tpOnRef.current && totalProfitRef.current >= tpAmtRef.current) ||
                  (slOnRef.current && totalProfitRef.current <= -slAmtRef.current) ||
                  (mtOnRef.current && tradeCountRef.current >= mtAmtRef.current)
                if (shouldStop) { stopBotRef.current(); return }

                // ── Next trade ────────────────────────────────────────────
                if (runningRef.current && !pausedRef.current) {
                  if (tickIntervalRef.current <= 1) {
                    // Interval = 1: fire immediately after settlement (small debounce)
                    if (nextTradeTimerRef.current) clearTimeout(nextTradeTimerRef.current)
                    nextTradeTimerRef.current = setTimeout(subscribeProposal, 400)
                  } else {
                    // Interval > 1: countdown started at buy entry.
                    // Mark settlement done; if countdown already finished, subscribe now.
                    settlementDoneRef.current = true
                    if (countdownDoneRef.current) {
                      subscribeProposal()
                    }
                    // Else: public WS countdown will call subscribeProposal when it finishes
                  }
                }
              }
            }

            // Proposal error → retry
            if (msg.error && msg.echo_req?.proposal === 1) {
              if (runningRef.current && !pausedRef.current) {
                if (nextTradeTimerRef.current) clearTimeout(nextTradeTimerRef.current)
                nextTradeTimerRef.current = setTimeout(subscribeProposal, 1000)
              }
            }

          } catch (err) { console.error('[BotBuilder WS]', err) }
        }

        ws.onclose = () => {
          if (alive) {
            setAuthReady(false)
            setTimeout(connect, 3000)
          }
        }
      } catch {
        if (!alive) return
        setAuthErr('Reconnecting…')
        setTimeout(connect, 3000)
      }
    }

    connect()
    return () => { alive = false; ws?.close() }
  }, [subscribeProposal])

  // ── Public WS — live tick sequence ───────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket
    let alive = true
    const PUB = 'wss://ws.binaryws.com/websockets/v3?app_id=1089'
    const connect = () => {
      ws = new WebSocket(PUB)
      pubWsRef.current = ws
      ws.onopen = () => {
        if (!alive) return
        ws.send(JSON.stringify({ ticks: marketSymRef.current, subscribe: 1 }))
        setPubConnected(true)
      }
      ws.onmessage = (e) => {
        if (!alive) return
        try {
          const msg = JSON.parse(e.data)
          if (msg.tick && msg.tick.symbol === marketSymRef.current) {
            const price = msg.tick.quote as number
            // Detect decimal places from price
            const str = String(price)
            const dec = str.includes('.') ? str.split('.')[1].length : 0
            const ps  = Math.max(dec, 2)
            if (ps !== pipSzRef.current) pipSzRef.current = ps
            const fixed = price.toFixed(ps)
            setLivePriceDisp(fixed)
            const digit = parseInt(fixed[fixed.length - 1], 10)
            liveDigitsRef.current = [...liveDigitsRef.current, digit].slice(-40)
            setLiveDigits([...liveDigitsRef.current])
            // Tick interval countdown (entry-to-entry, started at buy)
            if (waitingForTicksRef.current && runningRef.current && !pausedRef.current) {
              tickCountdownRef.current -= 1
              setTickCountdown(tickCountdownRef.current)
              if (tickCountdownRef.current <= 0) {
                waitingForTicksRef.current = false
                countdownDoneRef.current   = true
                setTickCountdown(0)
                if (settlementDoneRef.current) {
                  // Contract already settled, subscribe for next trade now
                  subscribeProposal()
                }
                // Else: settlement will call subscribeProposal when it arrives
              }
            }
          }
        } catch { /**/ }
      }
      ws.onclose = () => {
        setPubConnected(false)
        if (alive) setTimeout(connect, 2000)
      }
    }
    connect()
    return () => { alive = false; ws?.close() }
  }, [])

  // Re-subscribe ticks when market changes
  useEffect(() => {
    marketSymRef.current = market
    liveDigitsRef.current = []
    setLiveDigits([])
    setLivePriceDisp(null)
    const ws = pubWsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ forget_all: 'ticks' }))
      ws.send(JSON.stringify({ ticks: market, subscribe: 1 }))
    }
  }, [market])

  // ── Derived ───────────────────────────────────────────────────────────────────
  const winRate      = stats.trades > 0 ? Math.round((stats.wins / stats.trades) * 100) : null
  const needsBarrier = NEEDS_BARRIER.includes(contractType)
  const ctInfo       = CONTRACT_TYPES.find(c => c.value === contractType)
  const mktInfo      = MARKETS.find(m => m.value === market)

  // Digit coloring based on contract type + barrier
  const getDigitColor = (digit: number): string => {
    const b = parseInt(barrier)
    if (contractType === 'DIGITMATCH')  return digit === b ? green : txt2
    if (contractType === 'DIGITDIFF')   return digit === b ? red : green
    if (contractType === 'DIGITOVER')   return digit > b ? green : txt2
    if (contractType === 'DIGITUNDER')  return digit < b ? green : txt2
    if (contractType === 'DIGITEVEN')   return digit % 2 === 0 ? green : txt2
    if (contractType === 'DIGITODD')    return digit % 2 === 1 ? green : txt2
    return amber
  }
  const isWinDigit = (digit: number): boolean => {
    const b = parseInt(barrier)
    if (contractType === 'DIGITMATCH')  return digit === b
    if (contractType === 'DIGITDIFF')   return digit !== b
    if (contractType === 'DIGITOVER')   return digit > b
    if (contractType === 'DIGITUNDER')  return digit < b
    if (contractType === 'DIGITEVEN')   return digit % 2 === 0
    if (contractType === 'DIGITODD')    return digit % 2 === 1
    return true
  }
  const liveWinCount = liveDigits.filter(isWinDigit).length
  const liveWinPct   = liveDigits.length > 0 ? Math.round((liveWinCount / liveDigits.length) * 100) : 0

  // Label shown inside each tick box
  const getDigitLabel = (digit: number): string => {
    const b = parseInt(barrier)
    if (contractType === 'DIGITEVEN')  return digit % 2 === 0 ? 'E' : 'O'
    if (contractType === 'DIGITODD')   return digit % 2 === 1 ? 'O' : 'E'
    if (contractType === 'DIGITMATCH') return digit === b ? 'M' : String(digit)
    if (contractType === 'DIGITDIFF')  return digit === b ? 'M' : 'D'
    if (contractType === 'CALL') return 'R'
    if (contractType === 'PUT')  return 'F'
    return String(digit)
  }
  const toggleBlock  = (id: string) => setOpenBlocks(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: bg0, fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ══ TOP BAR ══════════════════════════════════════════════════════════ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 44, background: bg1, borderBottom: `1px solid ${bdr}`, flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: txt0 }}>⚙ Bot Builder</span>
        <div style={{ flex: 1 }} />
        {lastResult && (
          <div style={{ padding: '2px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: lastResult === 'won' ? `${green}22` : `${red}22`, color: lastResult === 'won' ? green : red, border: `1px solid ${lastResult === 'won' ? green : red}` }}>
            {lastResult === 'won' ? '✓ Won' : '✗ Lost'}
          </div>
        )}
        {balance !== null && (
          <div style={{ fontSize: 12, color: txt1 }}>
            <span style={{ color: txt2 }}>{currency} </span>
            <span style={{ color: txt0, fontWeight: 700 }}>{balance.toFixed(2)}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: authReady ? green : amber, boxShadow: authReady ? `0 0 6px ${green}` : 'none' }} />
          <span style={{ fontSize: 10, color: txt1 }}>{authReady ? 'Live' : authErr ?? 'Connecting…'}</span>
        </div>
      </div>

      {/* ══ MAIN ═════════════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

        {/* ── LEFT: Block workspace ─────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', borderRight: `1px solid ${bdr}` }}>
          <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>Bot Workspace</div>

          {/* ── LIVE TICK SEQUENCE ─────────────────────────────────────────── */}
          <div style={{ marginBottom: 14, background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '10px 14px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 9, color: txt2, textTransform: 'uppercase' as const, letterSpacing: '0.1em', fontWeight: 700 }}>
                Live Ticks · {mktInfo?.label ?? market}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {tickCountdown > 0 && (
                  <span style={{ fontSize: 9, color: amber, fontWeight: 700, background: amber + '22', border: `1px solid ${amber}44`, borderRadius: 4, padding: '1px 6px' }}>
                    next in {tickCountdown}
                  </span>
                )}
                {livePriceDisp !== null && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: amber, fontVariantNumeric: 'tabular-nums' }}>{livePriceDisp}</span>
                )}
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: pubConnected ? green : txt2,
                  boxShadow: pubConnected ? `0 0 5px ${green}` : 'none',
                }} />
              </div>
            </div>

            {liveDigits.length === 0 ? (
              <div style={{ fontSize: 10, color: txt2, textAlign: 'center', padding: '14px 0' }}>
                Connecting to market…
              </div>
            ) : (
              <>
                {/* Digit boxes */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  {liveDigits.map((d, i) => {
                    const color    = getDigitColor(d)
                    const isLatest = i === liveDigits.length - 1
                    return (
                      <div key={i} style={{
                        width: 24, height: 24, borderRadius: 5, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700,
                        background: isLatest ? color + '40' : color + '1a',
                        border: `1px solid ${isLatest ? color + 'cc' : color + '44'}`,
                        color: isLatest ? '#fff' : color,
                        boxShadow: isLatest ? `0 0 7px ${color}88` : 'none',
                        transform: isLatest ? 'scale(1.18)' : 'scale(1)',
                        transition: 'transform 0.12s, box-shadow 0.12s',
                        position: 'relative', zIndex: isLatest ? 1 : 0,
                      }}>
                        {getDigitLabel(d)}
                      </div>
                    )
                  })}
                </div>

                {/* Win-rate bar */}
                {liveDigits.length >= 5 && (
                  <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                    <span style={{ color: txt2 }}>Live rate:</span>
                    <span style={{ fontWeight: 700, color: liveWinPct >= 50 ? green : red }}>{liveWinPct}%</span>
                    <span style={{ color: txt2 }}>({liveDigits.length} ticks)</span>
                    <div style={{ flex: 1, height: 3, borderRadius: 2, background: bdr, overflow: 'hidden' }}>
                      <div style={{ width: `${liveWinPct}%`, height: '100%', background: liveWinPct >= 50 ? green : red, borderRadius: 2, transition: 'width 0.3s' }} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Block 1 — Market & Trade */}
          <BotBlock
            id="trade" label="Market & Trade" icon="⊞"
            accent={green} accentBg="#0a1f0e"
            open={openBlocks.has('trade')} onToggle={() => toggleBlock('trade')}
            summary={`${mktInfo?.label ?? market} · ${ctInfo?.label ?? contractType}${needsBarrier ? ` ${barrier}` : ''} · ${duration}t`}
          >
            <FieldRow>
              <BotField label="Market">
                <select value={market} onChange={e => setMarket(e.target.value)} style={inputBase as object} disabled={running}>
                  {MARKETS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </BotField>
            </FieldRow>
            <FieldRow>
              <BotField label="Contract Type">
                <select value={contractType} onChange={e => setContractType(e.target.value)} style={inputBase as object} disabled={running}>
                  {CONTRACT_TYPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </BotField>
              {needsBarrier ? (
                <BotField label="Barrier (0–9)">
                  <select value={barrier} onChange={e => setBarrier(e.target.value)} style={inputBase as object} disabled={running}>
                    {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                  </select>
                </BotField>
              ) : <BotField label=" " />}
            </FieldRow>
            <FieldRow>
              <BotField label="Duration (ticks)">
                <input type="number" min={1} max={10} value={duration}
                  onChange={e => setDuration(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  style={inputBase as object} disabled={running} />
              </BotField>
              <BotField label="Trade Every (ticks)">
                <select value={tickInterval} onChange={e => setTickInterval(parseInt(e.target.value))} style={inputBase as object} disabled={running}>
                  {[1,2,3,4,5,6,7,8,9,10].map(n => (
                    <option key={n} value={n}>{n} tick{n > 1 ? 's' : ''}</option>
                  ))}
                </select>
              </BotField>
            </FieldRow>
          </BotBlock>

          <BlockArrow />

          {/* Block 2 — Purchase */}
          <BotBlock
            id="purchase" label="Purchase" icon="💰"
            accent={blue} accentBg="#0a1020"
            open={openBlocks.has('purchase')} onToggle={() => toggleBlock('purchase')}
            summary={`Initial stake: ${initialStake} ${currency}`}
          >
            <FieldRow>
              <BotField label={`Initial Stake (${currency})`}>
                <input type="number" min={0.35} step={0.01} value={initialStake}
                  onChange={e => setInitialStake(e.target.value)}
                  style={inputBase as object} disabled={running} />
              </BotField>
              <BotField label=" ">
                <div style={{ fontSize: 11, color: txt2, paddingTop: 10 }}>Min: 0.35 {currency}</div>
              </BotField>
            </FieldRow>
          </BotBlock>

          <BlockArrow />

          {/* Block 3 — Staking Strategy */}
          <BotBlock
            id="staking" label="Staking Strategy" icon="↻"
            accent={amber} accentBg="#1a1200"
            open={openBlocks.has('staking')} onToggle={() => toggleBlock('staking')}
            summary={STAKING_LABELS[staking]}
          >
            {/* Strategy picker */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 14 }}>
              {(Object.keys(STAKING_LABELS) as StakingStrategy[]).map(key => (
                <button key={key}
                  onClick={() => !running && setStaking(key)}
                  style={{
                    padding: '7px 10px', fontSize: 11, fontWeight: 600, textAlign: 'left',
                    background: staking === key ? `${amber}18` : bg2,
                    border: `1px solid ${staking === key ? amber : bdr}`,
                    borderRadius: 6, color: staking === key ? amber : txt1,
                    cursor: running ? 'not-allowed' : 'pointer',
                  }}
                >
                  <span style={{ fontSize: 8, marginRight: 5 }}>{staking === key ? '●' : '○'}</span>
                  {STAKING_LABELS[key]}
                </button>
              ))}
            </div>

            {/* Strategy params */}
            {staking === 'martingale' && (
              <FieldRow>
                <BotField label="Loss Multiplier">
                  <input type="number" min={1.01} step={0.1} value={multiplier}
                    onChange={e => setMultiplier(e.target.value)} style={inputBase as object} disabled={running} />
                </BotField>
                <BotField label="Max Stake">
                  <input type="number" min={1} step={1} value={maxStake}
                    onChange={e => setMaxStake(e.target.value)} style={inputBase as object} disabled={running} />
                </BotField>
              </FieldRow>
            )}
            {staking === 'dalembert' && (
              <FieldRow>
                <BotField label="Unit Size">
                  <input type="number" min={0.01} step={0.01} value={unit}
                    onChange={e => setUnit(e.target.value)} style={inputBase as object} disabled={running} />
                </BotField>
                <BotField label="Max Stake">
                  <input type="number" min={1} step={1} value={maxStake}
                    onChange={e => setMaxStake(e.target.value)} style={inputBase as object} disabled={running} />
                </BotField>
              </FieldRow>
            )}
            {staking === 'fibonacci' && (
              <FieldRow>
                <BotField label="Max Stake">
                  <input type="number" min={1} step={1} value={maxStake}
                    onChange={e => setMaxStake(e.target.value)} style={inputBase as object} disabled={running} />
                </BotField>
                <BotField label=" ">
                  <div style={{ fontSize: 10, color: txt2, paddingTop: 10 }}>Sequence: 1→1→2→3→5→8…</div>
                </BotField>
              </FieldRow>
            )}

            <div style={{ padding: '8px 10px', borderRadius: 6, background: bg2, fontSize: 11, color: txt2, marginTop: 4 }}>
              {STAKING_DESC[staking]}
            </div>
          </BotBlock>

          <BlockArrow />

          {/* Block 4 — Stop Conditions */}
          <BotBlock
            id="stop" label="Stop Conditions" icon="⬛"
            accent={red} accentBg="#1a0808"
            open={openBlocks.has('stop')} onToggle={() => toggleBlock('stop')}
            summary={[tpOn && `TP +${tpAmt}`, slOn && `SL -${slAmt}`, mtOn && `Max ${mtAmt}`].filter(Boolean).join(' · ') || 'None active'}
          >
            <StopRow
              enabled={tpOn} onToggle={() => !running && setTpOn(v => !v)}
              label="Take Profit" accent={green} prefix="+"
              value={tpAmt} onChange={setTpAmt} disabled={running}
            />
            <StopRow
              enabled={slOn} onToggle={() => !running && setSlOn(v => !v)}
              label="Stop Loss" accent={red} prefix="−"
              value={slAmt} onChange={setSlAmt} disabled={running}
            />
            {/* Max trades row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Checkbox checked={mtOn} onChange={() => !running && setMtOn(v => !v)} accent={amber} />
              <span style={{ fontSize: 12, color: mtOn ? txt0 : txt2, width: 100 }}>Max Trades</span>
              <input type="number" min={1} step={1} value={mtAmt}
                onChange={e => setMtAmt(e.target.value)}
                disabled={!mtOn || running}
                style={{ ...inputBase, width: 80, opacity: mtOn ? 1 : 0.4 } as object} />
              <span style={{ fontSize: 11, color: txt2 }}>trades</span>
            </div>

            {!tpOn && !slOn && !mtOn && (
              <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 6, background: bg2, fontSize: 11, color: txt2 }}>
                ⚠ No stop conditions — bot runs until manually stopped.
              </div>
            )}
          </BotBlock>
        </div>

        {/* ── RIGHT: Controls + Stats + Log ────────────────────────────────── */}
        <aside style={{ width: 256, minWidth: 256, background: bg1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

          {/* Controls */}
          <div style={{ padding: '14px', borderBottom: `1px solid ${bdr}` }}>
            <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Controls</div>
            {!running ? (
              <button onClick={runBot} disabled={!authReady} style={{
                width: '100%', padding: '11px 0', fontSize: 13, fontWeight: 700, borderRadius: 8,
                background: authReady ? green : bg2, border: 'none',
                color: authReady ? '#000' : txt2, cursor: authReady ? 'pointer' : 'not-allowed',
              }}>▶ Run Bot</button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {!paused
                  ? <button onClick={pauseBot} style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 700, background: amber, border: 'none', borderRadius: 8, color: '#000', cursor: 'pointer' }}>⏸ Pause</button>
                  : <button onClick={resumeBot} style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 700, background: green, border: 'none', borderRadius: 8, color: '#000', cursor: 'pointer' }}>▶ Resume</button>
                }
                <button onClick={stopBot} style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 700, background: red, border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer' }}>■ Stop</button>
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 11, textAlign: 'center', color: running ? (paused ? amber : green) : txt2 }}>
              {running ? (paused ? '⏸ Paused' : '● Running') : 'Idle'}
            </div>
          </div>

          {/* Live Stats */}
          <div style={{ padding: '14px', borderBottom: `1px solid ${bdr}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 9, color: txt2, textTransform: 'uppercase' as const, letterSpacing: '0.08em' }}>Live Stats</span>
              <button onClick={resetStats} disabled={running} style={{
                fontSize: 9, padding: '2px 8px', borderRadius: 4, border: `1px solid ${bdr}`,
                background: 'transparent', color: running ? txt2 : txt1,
                cursor: running ? 'not-allowed' : 'pointer', letterSpacing: '0.04em',
              }}>↺ Reset</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <StatCell label="Trades"  value={String(stats.trades)} color={txt0} />
              <StatCell label="Win %"   value={winRate !== null ? `${winRate}%` : '—'} color={txt0} />
              <StatCell label="Wins"    value={String(stats.wins)}   color={green} />
              <StatCell label="Losses"  value={String(stats.losses)} color={red} />
              <StatCell label="P&L"     value={`${stats.profit >= 0 ? '+' : ''}${stats.profit.toFixed(2)}`} color={stats.profit >= 0 ? green : red} />
              <StatCell label="Stake"   value={(stats.currentStake > 0 ? stats.currentStake : parseFloat(initialStake) || 1).toFixed(2)} color={amber} />
            </div>
          </div>

          {/* Trade log */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
            <div style={{ fontSize: 9, color: txt2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Trade Log</div>
            {trades.length === 0
              ? <div style={{ fontSize: 11, color: txt2, textAlign: 'center', paddingTop: 20 }}>No trades yet</div>
              : trades.map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${bdr}` }}>
                  <span style={{ fontSize: 10, color: t.won ? green : red, fontWeight: 700, width: 14 }}>{t.won ? '✓' : '✗'}</span>
                  <span style={{ fontSize: 10, color: txt2 }}>#{t.id} · {t.stake.toFixed(2)}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: t.profit >= 0 ? green : red }}>{t.profit >= 0 ? '+' : ''}{t.profit.toFixed(2)}</span>
                </div>
              ))
            }
          </div>
        </aside>
      </div>
    </div>
  )
}

// ══ Sub-components ════════════════════════════════════════════════════════════

function BotBlock({ id, label, icon, accent, accentBg, open, onToggle, summary, children }: {
  id: string; label: string; icon: string; accent: string; accentBg: string
  open: boolean; onToggle: () => void; summary?: string; children?: ReactNode
}) {
  return (
    <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, overflow: 'hidden' }}>
      <div onClick={onToggle} style={{
        background: accentBg, borderBottom: open ? `1px solid ${bdr}` : 'none',
        padding: '10px 14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8, userSelect: 'none' as const,
      }}>
        <div style={{ width: 3, height: 22, background: accent, borderRadius: 2, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: accent, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
          {icon} {label}
        </span>
        <div style={{ flex: 1 }} />
        {!open && summary && <span style={{ fontSize: 10, color: txt2 }}>{summary}</span>}
        <span style={{ fontSize: 10, color: txt2, display: 'inline-block', transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </div>
      {open && (
        <div style={{ padding: '14px 16px', background: bg0 }}>
          {children}
        </div>
      )}
    </div>
  )
}

function BlockArrow() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: 1, height: 8, background: bdr }} />
        <div style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `6px solid ${bdr}` }} />
      </div>
    </div>
  )
}

function FieldRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>{children}</div>
}

function BotField({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: txt2, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

function Checkbox({ checked, onChange, accent }: { checked: boolean; onChange: () => void; accent: string }) {
  return (
    <button onClick={onChange} style={{
      width: 18, height: 18, borderRadius: 3, flexShrink: 0,
      border: `1px solid ${checked ? accent : bdr}`,
      background: checked ? accent : 'transparent',
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {checked && <span style={{ fontSize: 10, color: '#000', fontWeight: 700 }}>✓</span>}
    </button>
  )
}

function StopRow({ enabled, onToggle, label, accent, prefix, value, onChange, disabled }: {
  enabled: boolean; onToggle: () => void; label: string; accent: string; prefix: string
  value: string; onChange: (v: string) => void; disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <Checkbox checked={enabled} onChange={onToggle} accent={accent} />
      <span style={{ fontSize: 12, color: enabled ? txt0 : txt2, width: 100 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
        <span style={{ fontSize: 11, color: accent, fontWeight: 700, width: 10 }}>{prefix}</span>
        <input type="number" min={0.01} step={0.01} value={value}
          onChange={e => onChange(e.target.value)}
          disabled={!enabled || disabled}
          style={{ ...inputBase, opacity: enabled ? 1 : 0.4 } as object} />
      </div>
    </div>
  )
}

function StatCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: txt2, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}
