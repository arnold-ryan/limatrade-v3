'use client'
/**
 * Free Bots — pre-built digit trading bots
 *
 * Architecture:
 *  • One shared auth WebSocket (OTP URL from /api/user/ws-url)
 *  • Only one bot runs at a time
 *  • Buy: { buy:'1', price:1000, parameters:{ ... } }
 *  • Settle via transaction stream (action:'sell')
 *  • proposal_open_contract for live P/L
 *  • Balance via { balance:1, subscribe:1 }
 */

import { useCallback, useEffect, useRef, useState } from 'react'

// ── Bot catalogue ────────────────────────────────────────────────────────────
interface BotDef {
  id:          string
  name:        string
  icon:        string
  description: string
  contractType: string
  barrier?:    number
  risk:        'Low' | 'Medium' | 'High'
  winOdds:     string   // theoretical win probability
  color:       string
}

const BOTS: BotDef[] = [
  {
    id: 'even', name: 'Even Stevens', icon: '⊙',
    description: 'Bets the last digit of each tick is even (0, 2, 4, 6, 8).',
    contractType: 'DIGITEVEN', risk: 'Low', winOdds: '~50%', color: '#22c55e',
  },
  {
    id: 'odd', name: 'Odd Ranger', icon: '⊗',
    description: 'Bets the last digit of each tick is odd (1, 3, 5, 7, 9).',
    contractType: 'DIGITODD', risk: 'Low', winOdds: '~50%', color: '#a855f7',
  },
  {
    id: 'over4', name: 'High Roller', icon: '▲',
    description: 'Bets the last digit is over 4 — wins on 5, 6, 7, 8, or 9.',
    contractType: 'DIGITOVER', barrier: 4, risk: 'Medium', winOdds: '~50%', color: '#3b82f6',
  },
  {
    id: 'under5', name: 'Low Rider', icon: '▼',
    description: 'Bets the last digit is under 5 — wins on 0, 1, 2, 3, or 4.',
    contractType: 'DIGITUNDER', barrier: 5, risk: 'Medium', winOdds: '~50%', color: '#f97316',
  },
  {
    id: 'match5', name: 'Match King', icon: '◎',
    description: 'Bets the last digit exactly matches 5. High risk, high payout.',
    contractType: 'DIGITMATCH', barrier: 5, risk: 'High', winOdds: '~10%', color: '#FCA311',
  },
  {
    id: 'differ0', name: 'Differ Pro', icon: '◈',
    description: 'Bets the last digit is anything except 0. Wins 9 out of 10 ticks.',
    contractType: 'DIGITDIFF', barrier: 0, risk: 'Low', winOdds: '~90%', color: '#14b8a6',
  },
]

const MARKETS = [
  { symbol: 'R_10',    name: 'Volatility 10 Index'      },
  { symbol: 'R_25',    name: 'Volatility 25 Index'      },
  { symbol: 'R_50',    name: 'Volatility 50 Index'      },
  { symbol: 'R_75',    name: 'Volatility 75 Index'      },
  { symbol: 'R_100',   name: 'Volatility 100 Index'     },
  { symbol: '1HZ10V',  name: 'Volatility 10 (1s) Index' },
  { symbol: '1HZ25V',  name: 'Volatility 25 (1s) Index' },
  { symbol: '1HZ50V',  name: 'Volatility 50 (1s) Index' },
  { symbol: '1HZ75V',  name: 'Volatility 75 (1s) Index' },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s) Index'},
]

// ── Types ────────────────────────────────────────────────────────────────────
interface BotStats {
  trades: number; wins: number; losses: number
  totalStake: number; totalPayout: number; profit: number
}

interface TxEntry {
  id: number; botId: string; contractType: string
  stake: number; payout: number; won: boolean; settled: boolean
  currentPnl?: number; time: number
}

interface BotConfig {
  stake: string; takeProfit: string; stopLoss: string; market: string
}

const defaultConfig = (): BotConfig => ({ stake: '1.00', takeProfit: '10', stopLoss: '5', market: 'R_100' })
const defaultStats  = (): BotStats  => ({ trades: 0, wins: 0, losses: 0, totalStake: 0, totalPayout: 0, profit: 0 })

const RISK_COLOR: Record<string, string> = { Low: '#22c55e', Medium: '#f97316', High: '#ef4444' }

// ── Component ────────────────────────────────────────────────────────────────
export default function FreeBotsPage() {
  const [activeBotId,  setActiveBotId]  = useState<string | null>(null)
  const [botStats,     setBotStats]     = useState<Record<string, BotStats>>({})
  const [configs,      setConfigs]      = useState<Record<string, BotConfig>>(
    () => Object.fromEntries(BOTS.map(b => [b.id, defaultConfig()]))
  )
  const [expanded,     setExpanded]     = useState<string | null>(null)
  const [txLog,        setTxLog]        = useState<TxEntry[]>([])
  const [balance,      setBalance]      = useState<number | null>(null)
  const [currency,     setCurrency]     = useState('USD')
  const [wsReady,      setWsReady]      = useState(false)
  const [wsErr,        setWsErr]        = useState<string | null>(null)
  const [stopReason,   setStopReason]   = useState<string | null>(null)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const wsRef             = useRef<WebSocket | null>(null)
  const activeBotRef      = useRef<string | null>(null)
  const configRef         = useRef<BotConfig>(defaultConfig())
  const statsRef          = useRef<BotStats>(defaultStats())
  const reqIdRef          = useRef(0)
  const inTradeRef        = useRef(false)
  const pendingBuys       = useRef<Map<number, number>>(new Map()) // contractId → buyPrice
  const pocSubs           = useRef<Map<number, string>>(new Map()) // contractId → subscriptionId
  const intentionalClose  = useRef(false)
  const reconnectCount    = useRef(0)

  // sync refs
  useEffect(() => { activeBotRef.current = activeBotId }, [activeBotId])
  const syncConfig = useCallback((botId: string) => {
    configRef.current = configs[botId] ?? defaultConfig()
  }, [configs])

  // ── Config helpers ────────────────────────────────────────────────────────
  const updateConfig = (botId: string, key: keyof BotConfig, val: string) =>
    setConfigs(prev => ({ ...prev, [botId]: { ...prev[botId], [key]: val } }))

  // ── Stop check ────────────────────────────────────────────────────────────
  const checkStops = useCallback((stats: BotStats, cfg: BotConfig): string | null => {
    const tp = parseFloat(cfg.takeProfit)
    const sl = parseFloat(cfg.stopLoss)
    if (!isNaN(tp) && tp > 0 && stats.profit >= tp)  return `✓ Take profit reached (+${tp} ${currency})`
    if (!isNaN(sl) && sl > 0 && stats.profit <= -sl) return `✗ Stop loss triggered (-${sl} ${currency})`
    return null
  }, [currency])

  // ── Execute a single trade ────────────────────────────────────────────────
  const executeTrade = useCallback(() => {
    const ws    = wsRef.current
    const botId = activeBotRef.current
    if (!botId || !ws || ws.readyState !== WebSocket.OPEN) return
    if (inTradeRef.current) return

    const bot = BOTS.find(b => b.id === botId)!
    const cfg = configRef.current
    const stake = parseFloat(cfg.stake) || 1
    if (stake < 0.35) { stopBot('Minimum stake is 0.35'); return }

    inTradeRef.current = true
    const reqId = ++reqIdRef.current

    ws.send(JSON.stringify({
      buy:    '1',
      price:  1000,
      req_id: reqId,
      parameters: {
        contract_type:     bot.contractType,
        underlying_symbol: cfg.market,
        duration:          1,
        duration_unit:     't',
        amount:            parseFloat(stake.toFixed(2)),
        basis:             'stake',
        currency:          currency,
        ...(bot.barrier !== undefined ? { barrier: String(bot.barrier) } : {}),
      },
    }))
  }, [currency])

  // ── Stop bot ──────────────────────────────────────────────────────────────
  const stopBot = useCallback((reason?: string) => {
    setActiveBotId(null)
    activeBotRef.current = null
    inTradeRef.current   = false
    if (reason) setStopReason(reason)
  }, [])

  // ── Start bot ─────────────────────────────────────────────────────────────
  const startBot = useCallback((botId: string) => {
    syncConfig(botId)
    statsRef.current = botStats[botId] ? { ...botStats[botId] } : defaultStats()
    setStopReason(null)
    setActiveBotId(botId)
    activeBotRef.current = botId
    inTradeRef.current   = false
    // kick off first trade
    setTimeout(() => executeTrade(), 300)
  }, [syncConfig, botStats, executeTrade])

  // ── Auth WebSocket ─────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    let dead = false

    const backoff = (n: number) => Math.min(1000 * 2 ** n, 30_000)

    async function connect() {
      try {
        const r = await fetch('/api/user/ws-url', { cache: 'no-store' })
        if (!r.ok) { setWsErr('Not logged in — please log in to use bots.'); return }
        const { wsUrl } = await r.json()
        if (!wsUrl)     { setWsErr('Could not get connection URL.'); return }

        ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          if (dead) return
          reconnectCount.current = 0
          setWsReady(true); setWsErr(null)
          ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
          ws!.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))
          ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })) }, 25_000)
        }

        ws.onmessage = ev => {
          if (dead) return
          let msg: any; try { msg = JSON.parse(ev.data) } catch { return }

          if (msg.error?.code === 'AuthorizationRequired' || msg.error?.code === 'InvalidToken') {
            setWsErr('Session expired — please log in again.'); ws?.close(); return
          }

          if (msg.msg_type === 'balance') {
            const b = msg.balance as { balance: number; currency: string }
            setBalance(b.balance); setCurrency(b.currency)
          }

          if (msg.msg_type === 'buy') {
            if (msg.error) {
              inTradeRef.current = false
              stopBot(`Buy error: ${msg.error.message}`)
              return
            }
            const buy = msg.buy as { contract_id: number; buy_price: number }
            pendingBuys.current.set(buy.contract_id, buy.buy_price)

            // Update stats
            const upd: BotStats = {
              ...statsRef.current,
              trades:     statsRef.current.trades + 1,
              totalStake: parseFloat((statsRef.current.totalStake + buy.buy_price).toFixed(2)),
            }
            statsRef.current = upd
            const bid = activeBotRef.current
            if (bid) setBotStats(prev => ({ ...prev, [bid]: upd }))

            // Add pending tx log entry
            setTxLog(prev => [{
              id: buy.contract_id, botId: activeBotRef.current ?? '',
              contractType: BOTS.find(b => b.id === activeBotRef.current)?.contractType ?? '',
              stake: buy.buy_price, payout: 0, won: false, settled: false, time: Date.now(),
            }, ...prev].slice(0, 80))

            // Subscribe to live P/L
            ws!.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1, contract_id: buy.contract_id, req_id: 400 }))
          }

          if (msg.msg_type === 'proposal_open_contract') {
            const poc = msg.proposal_open_contract as { contract_id: number; profit: number; subscription?: { id: string } }
            if (poc.subscription?.id) pocSubs.current.set(poc.contract_id, poc.subscription.id)
            setTxLog(prev => prev.map(tx =>
              tx.id === poc.contract_id && !tx.settled ? { ...tx, currentPnl: poc.profit } : tx
            ))
          }

          if (msg.msg_type === 'transaction') {
            const tx = msg.transaction as { action: string; amount: number; contract_id?: number }
            if (tx.action !== 'sell' || tx.contract_id == null) return
            const buyPrice = pendingBuys.current.get(tx.contract_id)
            if (buyPrice === undefined) return
            pendingBuys.current.delete(tx.contract_id)
            inTradeRef.current = false

            // Forget POC subscription
            const subId = pocSubs.current.get(tx.contract_id)
            if (subId && ws?.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ forget: subId, req_id: 9996 })) } catch { /**/ }
            }
            pocSubs.current.delete(tx.contract_id)

            const payout = Math.max(0, tx.amount)
            const won    = payout > 0
            const upd: BotStats = {
              ...statsRef.current,
              wins:         won ? statsRef.current.wins + 1  : statsRef.current.wins,
              losses:       won ? statsRef.current.losses    : statsRef.current.losses + 1,
              totalPayout:  parseFloat((statsRef.current.totalPayout + payout).toFixed(2)),
              profit:       parseFloat((statsRef.current.totalPayout + payout - statsRef.current.totalStake).toFixed(2)),
            }
            statsRef.current = upd
            const bid = activeBotRef.current
            if (bid) setBotStats(prev => ({ ...prev, [bid]: upd }))

            // Settle tx log
            setTxLog(prev => {
              const i = prev.findIndex(t => t.id === tx.contract_id)
              if (i === -1) return prev
              const next = [...prev]
              next[i] = { ...next[i], payout, won, settled: true, currentPnl: undefined }
              return next
            })

            // Check TP/SL
            const cfg = configRef.current
            const stopMsg = checkStops(upd, cfg)
            if (stopMsg) { stopBot(stopMsg); return }

            // Fire next trade
            if (activeBotRef.current && ws?.readyState === WebSocket.OPEN) {
              setTimeout(() => executeTrade(), 400)
            }
          }
        }

        ws.onerror = () => {}
        ws.onclose = () => {
          setWsReady(false)
          wsRef.current = null
          inTradeRef.current = false
          if (ping) { clearInterval(ping); ping = null }
          if (activeBotRef.current) { stopBot(); }
          if (!dead && !intentionalClose.current) {
            const delay = backoff(reconnectCount.current++)
            setTimeout(connect, delay)
          }
        }
      } catch (e) {
        setWsErr('Connection failed. Retrying...')
        if (!dead) setTimeout(connect, backoff(reconnectCount.current++))
      }
    }

    connect()
    return () => {
      dead = true
      intentionalClose.current = true
      if (ping) clearInterval(ping)
      if (ws) { try { ws.send(JSON.stringify({ forget_all: 'proposal' })) } catch {/***/} ws.close() }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100%', background: '#000', color: '#e5e5e5', padding: '1.5rem', fontFamily: 'var(--font-geist-sans, sans-serif)' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 800, margin: 0 }}>Free Bots</h1>
          <p style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)', margin: '4px 0 0' }}>
            Pre-built digit trading bots — one active at a time
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {balance !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#FCA311' }}>{balance.toFixed(2)} {currency}</div>
              <div style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.4)' }}>Balance</div>
            </div>
          )}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '6px 14px', borderRadius: '999px',
            background: wsReady ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${wsReady ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            fontSize: '0.72rem', fontWeight: 600,
            color: wsReady ? '#22c55e' : '#ef4444',
          }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: wsReady ? '#22c55e' : '#ef4444' }} />
            {wsReady ? 'Connected' : 'Connecting'}
          </div>
        </div>
      </div>

      {/* Error banner */}
      {wsErr && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '0.82rem', color: '#ef4444' }}>
          {wsErr}
        </div>
      )}

      {/* Stop reason banner */}
      {stopReason && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '10px', background: 'rgba(252,163,17,0.08)', border: '1px solid rgba(252,163,17,0.25)', fontSize: '0.82rem', color: '#FCA311', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Bot stopped — {stopReason}</span>
          <button onClick={() => setStopReason(null)} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
        </div>
      )}

      {/* Bot grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        {BOTS.map(bot => {
          const isActive  = activeBotId === bot.id
          const isBlocked = activeBotId !== null && activeBotId !== bot.id
          const stats     = botStats[bot.id]
          const cfg       = configs[bot.id]
          const isExpanded = expanded === bot.id
          const profit    = stats?.profit ?? 0

          return (
            <div key={bot.id} style={{
              background: isActive ? `rgba(${bot.color === '#22c55e' ? '34,197,94' : bot.color === '#a855f7' ? '168,85,247' : bot.color === '#3b82f6' ? '59,130,246' : bot.color === '#f97316' ? '249,115,22' : bot.color === '#FCA311' ? '252,163,17' : '20,184,166'},0.06)` : 'rgba(255,255,255,0.03)',
              border: `1px solid ${isActive ? bot.color + '55' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: '16px', padding: '1.25rem',
              transition: 'all 0.2s',
              opacity: isBlocked ? 0.45 : 1,
            }}>
              {/* Card header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: '10px', flexShrink: 0,
                    background: `${bot.color}22`, border: `1px solid ${bot.color}44`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.1rem', color: bot.color,
                  }}>{bot.icon}</div>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '0.95rem' }}>{bot.name}</div>
                    <div style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.4)', marginTop: '2px' }}>
                      {bot.contractType}{bot.barrier !== undefined ? ` · Barrier ${bot.barrier}` : ''}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', background: `${RISK_COLOR[bot.risk]}22`, color: RISK_COLOR[bot.risk], border: `1px solid ${RISK_COLOR[bot.risk]}44` }}>
                    {bot.risk} Risk
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.4)' }}>Win {bot.winOdds}</span>
                </div>
              </div>

              {/* Description */}
              <p style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.55)', margin: '0 0 1rem', lineHeight: 1.5 }}>
                {bot.description}
              </p>

              {/* Live stats (shown when bot ran at least once) */}
              {stats && stats.trades > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
                  {[
                    { label: 'Trades', value: stats.trades },
                    { label: 'Wins', value: stats.wins, color: '#22c55e' },
                    { label: 'Losses', value: stats.losses, color: '#ef4444' },
                    { label: 'P/L', value: `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`, color: profit >= 0 ? '#22c55e' : '#ef4444' },
                  ].map(s => (
                    <div key={s.label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '6px 8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: s.color ?? '#e5e5e5' }}>{s.value}</div>
                      <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.4)', marginTop: '1px' }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Settings toggle */}
              <button
                onClick={() => setExpanded(isExpanded ? null : bot.id)}
                disabled={isActive}
                style={{
                  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '8px', padding: '7px 12px', cursor: isActive ? 'default' : 'pointer',
                  fontSize: '0.75rem', color: 'rgba(229,229,229,0.55)', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', marginBottom: isExpanded ? '0.75rem' : '0.75rem',
                }}
              >
                <span>⚙ Settings</span>
                <span style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
              </button>

              {/* Settings panel */}
              {isExpanded && !isActive && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '0.75rem', padding: '0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)' }}>
                  {/* Market */}
                  <div>
                    <label style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.4)', display: 'block', marginBottom: '4px' }}>MARKET</label>
                    <select
                      value={cfg.market}
                      onChange={e => updateConfig(bot.id, 'market', e.target.value)}
                      style={{ width: '100%', background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '6px 10px', fontSize: '0.8rem', color: '#e5e5e5' }}
                    >
                      {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.name}</option>)}
                    </select>
                  </div>
                  {/* Stake / TP / SL */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                    {([['stake', 'Stake ($)', '0.35'], ['takeProfit', 'Take Profit ($)', '0'], ['stopLoss', 'Stop Loss ($)', '0']] as const).map(([key, label, ph]) => (
                      <div key={key}>
                        <label style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.4)', display: 'block', marginBottom: '3px' }}>{label}</label>
                        <input
                          type="number" min="0" step="0.01"
                          value={cfg[key]}
                          onChange={e => updateConfig(bot.id, key, e.target.value)}
                          placeholder={ph}
                          style={{ width: '100%', boxSizing: 'border-box', background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '5px 8px', fontSize: '0.8rem', color: '#e5e5e5' }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Run / Stop button */}
              <button
                disabled={(!wsReady && !isActive) || isBlocked}
                onClick={() => {
                  if (isActive) {
                    stopBot('Stopped by user')
                  } else {
                    syncConfig(bot.id)
                    configRef.current = configs[bot.id]
                    startBot(bot.id)
                  }
                }}
                style={{
                  width: '100%', padding: '0.7rem', borderRadius: '10px', border: 'none',
                  fontWeight: 800, fontSize: '0.9rem', cursor: isBlocked ? 'not-allowed' : 'pointer',
                  background: isActive
                    ? 'rgba(239,68,68,0.15)'
                    : isBlocked
                    ? 'rgba(255,255,255,0.05)'
                    : bot.color,
                  color: isActive ? '#ef4444' : isBlocked ? 'rgba(229,229,229,0.25)' : '#000',
                  border: isActive ? '1px solid rgba(239,68,68,0.35)' : 'none',
                  transition: 'all 0.2s',
                }}
              >
                {isActive ? '■ Stop Bot' : isBlocked ? 'Another bot is running' : '▶ Run Bot'}
              </button>
            </div>
          )
        })}
      </div>

      {/* Transaction log */}
      {txLog.length > 0 && (
        <div>
          <h2 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem', color: 'rgba(229,229,229,0.7)' }}>Recent Trades</h2>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {['Bot', 'Type', 'Stake', 'Payout', 'P/L', 'Result'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'rgba(229,229,229,0.4)', fontSize: '0.7rem' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txLog.slice(0, 20).map((tx, i) => {
                  const bot = BOTS.find(b => b.id === tx.botId)
                  const pl  = tx.settled ? (tx.payout - tx.stake) : (tx.currentPnl ?? null)
                  return (
                    <tr key={tx.id} style={{ borderBottom: i < 19 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                      <td style={{ padding: '8px 12px', color: bot?.color ?? '#e5e5e5', fontWeight: 600 }}>
                        {bot?.icon} {bot?.name ?? tx.botId}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'rgba(229,229,229,0.6)', fontSize: '0.72rem' }}>{tx.contractType}</td>
                      <td style={{ padding: '8px 12px' }}>${tx.stake.toFixed(2)}</td>
                      <td style={{ padding: '8px 12px' }}>{tx.settled ? `$${tx.payout.toFixed(2)}` : '—'}</td>
                      <td style={{ padding: '8px 12px', color: pl === null ? 'rgba(229,229,229,0.35)' : pl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                        {pl === null ? '…' : `${pl >= 0 ? '+' : ''}${pl.toFixed(2)}`}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        {!tx.settled ? (
                          <span style={{ color: '#FCA311', fontSize: '0.7rem' }}>● Live</span>
                        ) : tx.won ? (
                          <span style={{ color: '#22c55e', fontSize: '0.7rem', fontWeight: 700 }}>✓ Won</span>
                        ) : (
                          <span style={{ color: '#ef4444', fontSize: '0.7rem', fontWeight: 700 }}>✗ Lost</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
