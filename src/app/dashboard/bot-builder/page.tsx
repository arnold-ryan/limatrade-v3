'use client'

/**
 * Lima Trade — Bot Builder Page v112
 *
 * Reads lima_trade_pending_bot from localStorage.
 * Runs the bot via the real Deriv trading API (proposal → buy → POC loop).
 * auto_start / auto_stop are DBot-only endpoints not available on the new WS —
 * we implement the trading loop using proposal + buy + proposal_open_contract.
 *
 * Staking: reads multiplier from bot.params (default 2 = martingale).
 * Loss → currentStake *= multiplier (capped at max_stake).
 * Win  → currentStake resets to initial stake.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const LS_KEY      = 'lima_trade_pending_bot'
const NEEDS_BARRIER = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF']

interface BotConfig {
  strategy_id:   string
  display_name:  string
  description:   string
  contract_type: string
  parameters:    { name: string; display_name: string; default: string }[]
  market:        string
  stake:         string
  params:        Record<string, string>
}

interface AutoUpdate {
  status:        string
  run_count:     number
  win_count:     number
  loss_count:    number
  total_profit:  number
  current_stake: number
}

const CT_LABEL: Record<string, string> = {
  DIGITOVER: 'Over', DIGITUNDER: 'Under',
  DIGITMATCH: 'Match', DIGITDIFF: 'Differ',
  DIGITEVEN: 'Even', DIGITODD: 'Odd',
  CALL: 'Rise', PUT: 'Fall',
}

const bg0   = '#0d1117'
const bg1   = '#161b22'
const bg2   = '#21262d'
const bdr   = '#30363d'
const txt0  = '#f0f6fc'
const txt1  = '#8b949e'
const txt2  = '#484f58'
const amber = '#e6b429'
const green = '#3fb950'
const red   = '#f85149'
const blue  = '#58a6ff'

export default function BotBuilderPage() {
  const router = useRouter()
  const [bot,        setBot]        = useState<BotConfig | null>(null)
  const [running,    setRunning]    = useState(false)
  const [paused,     setPaused]     = useState(false)
  const [balance,    setBalance]    = useState<number | null>(null)
  const [currency,   setCurrency]   = useState('USD')
  const [authReady,  setAuthReady]  = useState(false)
  const [authErr,    setAuthErr]    = useState<string | null>(null)
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdate | null>(null)
  const [lastResult, setLastResult] = useState<'won' | 'lost' | null>(null)

  const authRef          = useRef<WebSocket | null>(null)
  const botRef           = useRef<BotConfig | null>(null)
  const currencyRef      = useRef('USD')
  const runningRef       = useRef(false)
  const pausedRef        = useRef(false)
  const currentStakeRef  = useRef(1)
  const initialStakeRef  = useRef(1)
  const multiplierRef    = useRef(2)
  const maxStakeRef      = useRef(1000)
  const activeProposalId = useRef<string | null>(null)

  // Read bot config from localStorage on mount
  useEffect(() => {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as BotConfig
        setBot(parsed)
        botRef.current = parsed
        const initial    = parseFloat(parsed.stake) || 1
        const multiplier = parseFloat(parsed.params?.multiplier ?? '2') || 2
        const maxStake   = parseFloat(parsed.params?.max_stake   ?? '1000') || 1000
        initialStakeRef.current  = initial
        currentStakeRef.current  = initial
        multiplierRef.current    = multiplier
        maxStakeRef.current      = maxStake
        setAutoUpdate({ status: 'idle', run_count: 0, win_count: 0, loss_count: 0, total_profit: 0, current_stake: initial })
      } catch { /**/ }
    }
  }, [])

  // ── Subscribe to a proposal for one trade ────────────────────────────────
  const subscribeProposal = useCallback(() => {
    const ws  = authRef.current
    const bot = botRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !bot) return

    ws.send(JSON.stringify({ forget_all: 'proposal' }))
    activeProposalId.current = null

    const ct          = bot.contract_type
    const sym         = bot.market
    const stk         = currentStakeRef.current
    const barrier     = bot.params?.barrier ?? bot.params?.digit ?? '5'
    const needBarrier = NEEDS_BARRIER.includes(ct)

    const req: Record<string, unknown> = {
      proposal: 1, subscribe: 1,
      amount: stk, basis: 'stake',
      currency: currencyRef.current || 'USD',
      underlying_symbol: sym,
      contract_type: ct,
      duration: 1, duration_unit: 't',
    }
    if (needBarrier) req.barrier = String(barrier)
    ws.send(JSON.stringify(req))
  }, [])

  // ── Auth WS — balance + trading loop ────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket
    let alive = true

    const connect = async () => {
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) { setAuthErr('Not logged in'); return }
        const { wsUrl } = await r.json()
        ws = new WebSocket(wsUrl)
        authRef.current = ws

        ws.onopen = () => {
          if (!alive) return
          ws.send(JSON.stringify({ balance: 1, subscribe: 1 }))
          setAuthReady(true); setAuthErr(null)
        }

        ws.onmessage = (e) => {
          if (!alive) return
          try {
            const msg = JSON.parse(e.data)

            // Balance — Number() coerce; new API sends balance as string
            if (msg.balance) {
              setBalance(Number(msg.balance.balance) || 0)
              setCurrency(msg.balance.currency ?? 'USD')
              currencyRef.current = msg.balance.currency ?? 'USD'
            }

            // Proposal arrived → auto-buy
            if (msg.proposal && runningRef.current && !pausedRef.current) {
              const p = msg.proposal
              if (!activeProposalId.current && p.id) {
                activeProposalId.current = p.id
                ws.send(JSON.stringify({
                  buy:   p.id,
                  price: +(Number(p.ask_price) * 1.02).toFixed(2),
                }))
              }
            }

            // Buy confirmed → subscribe open contract
            if (msg.buy) {
              ws.send(JSON.stringify({ forget_all: 'proposal' }))
              activeProposalId.current = null
              if (msg.buy.contract_id) {
                ws.send(JSON.stringify({
                  proposal_open_contract: 1,
                  contract_id: msg.buy.contract_id,
                  subscribe: 1,
                }))
              }
            }

            // Contract settled → update stats + schedule next trade
            if (msg.proposal_open_contract) {
              const poc = msg.proposal_open_contract
              if ((poc.is_sold === 1 || poc.status === 'sold') && poc.contract_id) {
                const profit = Number(poc.profit) || 0
                const won    = profit >= 0

                setLastResult(won ? 'won' : 'lost')
                setTimeout(() => setLastResult(null), 1200)

                // Apply staking rule (martingale / any multiplier-based strategy)
                if (!won) {
                  currentStakeRef.current = Math.min(
                    parseFloat((currentStakeRef.current * multiplierRef.current).toFixed(2)),
                    maxStakeRef.current,
                  )
                } else {
                  currentStakeRef.current = initialStakeRef.current
                }

                setAutoUpdate(prev => {
                  const rc = (prev?.run_count  ?? 0) + 1
                  const wc = (prev?.win_count  ?? 0) + (won ? 1 : 0)
                  const lc = (prev?.loss_count ?? 0) + (won ? 0 : 1)
                  const tp = parseFloat(((prev?.total_profit ?? 0) + profit).toFixed(2))
                  return { status: 'running', run_count: rc, win_count: wc, loss_count: lc, total_profit: tp, current_stake: currentStakeRef.current }
                })

                // Next trade
                if (runningRef.current && !pausedRef.current) {
                  setTimeout(subscribeProposal, 400)
                }
              }
            }

            // Proposal error — retry after delay
            if (msg.error && msg.proposal !== undefined) {
              console.error('[BotBuilder] Proposal error:', msg.error.message)
              if (runningRef.current && !pausedRef.current) {
                setTimeout(subscribeProposal, 1000)
              }
            }

          } catch (err) { console.error('[BotBuilder WS]', err) }
        }

        ws.onclose = () => {
          if (alive) { setAuthReady(false); setTimeout(connect, 3000) }
        }
      } catch { setAuthErr('Auth WS error') }
    }

    connect()
    return () => { alive = false; ws?.close() }
  }, [subscribeProposal])

  // ── Controls ─────────────────────────────────────────────────────────────
  const runBot = useCallback(() => {
    runningRef.current = true
    pausedRef.current  = false
    setRunning(true); setPaused(false)
    setAutoUpdate(prev => prev ? { ...prev, status: 'running' } : null)
    subscribeProposal()
  }, [subscribeProposal])

  const pauseBot = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
    authRef.current?.send(JSON.stringify({ forget_all: 'proposal' }))
    activeProposalId.current = null
    setAutoUpdate(prev => prev ? { ...prev, status: 'paused' } : null)
  }, [])

  const resumeBot = useCallback(() => {
    pausedRef.current = false
    setPaused(false)
    setAutoUpdate(prev => prev ? { ...prev, status: 'running' } : null)
    subscribeProposal()
  }, [subscribeProposal])

  const stopBot = useCallback(() => {
    runningRef.current = false
    pausedRef.current  = false
    setRunning(false); setPaused(false)
    authRef.current?.send(JSON.stringify({ forget_all: 'proposal' }))
    activeProposalId.current = null
    setAutoUpdate(prev => prev ? { ...prev, status: 'stopped' } : null)
  }, [])

  const changeBot = useCallback(() => {
    stopBot()
    localStorage.removeItem(LS_KEY)
    router.push('/dashboard/free-bots')
  }, [router, stopBot])

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!bot) {
    return (
      <div style={{
        minHeight: '100vh', background: bg0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Inter, system-ui, sans-serif', gap: 16,
      }}>
        <div style={{ fontSize: 40 }}>🤖</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: txt0 }}>No bot loaded</div>
        <div style={{ fontSize: 13, color: txt1, textAlign: 'center', maxWidth: 300 }}>
          Go to Free Bots, choose a strategy, and it will appear here ready to run.
        </div>
        <button onClick={() => router.push('/dashboard/free-bots')} style={{
          marginTop: 8, padding: '10px 24px', fontSize: 13, fontWeight: 700,
          background: amber, border: 'none', borderRadius: 8, color: '#000', cursor: 'pointer',
        }}>Browse Free Bots</button>
      </div>
    )
  }

  const winRate = autoUpdate && autoUpdate.run_count > 0
    ? Math.round((autoUpdate.win_count / autoUpdate.run_count) * 100)
    : null

  return (
    <div style={{ minHeight: '100vh', background: bg0, fontFamily: 'Inter, system-ui, sans-serif', padding: '20px' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={changeBot} style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: 'transparent', border: `1px solid ${bdr}`,
          borderRadius: 6, color: txt1, cursor: 'pointer',
        }}>← Change Bot</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: txt0 }}>{bot.display_name}</div>
          <div style={{ fontSize: 11, color: txt1 }}>
            {CT_LABEL[bot.contract_type] ?? bot.contract_type} · {bot.market}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastResult && (
            <div style={{
              padding: '3px 10px', borderRadius: 6, fontWeight: 700, fontSize: 11,
              background: lastResult === 'won' ? `${green}22` : `${red}22`,
              color: lastResult === 'won' ? green : red,
              border: `1px solid ${lastResult === 'won' ? green : red}`,
            }}>
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
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: authReady ? green : amber }} />
            <span style={{ fontSize: 10, color: txt1 }}>{authReady ? 'Live' : authErr ?? 'Connecting…'}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>

        {/* ── Left: visual blocks ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Trade Definition */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ background: '#1c3a1c', padding: '10px 14px', borderBottom: `1px solid ${bdr}` }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: green, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                ⊞ Trade Definition
              </span>
            </div>
            <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { label: 'Market',        value: bot.market },
                { label: 'Contract Type', value: CT_LABEL[bot.contract_type] ?? bot.contract_type },
                { label: 'Initial Stake', value: `${bot.stake} ${currency}` },
                { label: 'Duration',      value: '1 tick' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: 10, color: txt2, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: txt0 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Strategy Parameters */}
          {bot.parameters.length > 0 && (
            <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ background: '#1a1c3a', padding: '10px 14px', borderBottom: `1px solid ${bdr}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: blue, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  ⚙ Strategy Parameters
                </span>
              </div>
              <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {bot.parameters.map(p => (
                  <div key={p.name}>
                    <div style={{ fontSize: 10, color: txt2, marginBottom: 4 }}>{p.display_name}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: txt0 }}>
                      {bot.params[p.name] ?? p.default ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Staking Rule */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ background: '#3a1c1c', padding: '10px 14px', borderBottom: `1px solid ${bdr}` }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: red, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                ↻ After Purchase
              </span>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 12, color: txt1 }}>
                {bot.params?.multiplier
                  ? `Loss: multiply stake × ${bot.params.multiplier}  |  Win: reset to ${bot.stake} ${currency}`
                  : 'Follows built-in strategy restart logic.'}
              </div>
              {autoUpdate && running && (
                <div style={{ marginTop: 8, fontSize: 12, color: txt0, fontWeight: 600 }}>
                  Current stake: <span style={{ color: amber }}>{autoUpdate.current_stake.toFixed(2)} {currency}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Right: controls + stats ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Controls */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Controls</div>
            {!running ? (
              <button onClick={runBot} disabled={!authReady} style={{
                width: '100%', padding: '10px', fontSize: 13, fontWeight: 700,
                background: authReady ? green : bg2, border: 'none', borderRadius: 8,
                color: authReady ? '#000' : txt2, cursor: authReady ? 'pointer' : 'not-allowed',
              }}>▶ Run Bot</button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {!paused ? (
                  <button onClick={pauseBot} style={{
                    width: '100%', padding: '10px', fontSize: 13, fontWeight: 700,
                    background: amber, border: 'none', borderRadius: 8, color: '#000', cursor: 'pointer',
                  }}>⏸ Pause</button>
                ) : (
                  <button onClick={resumeBot} style={{
                    width: '100%', padding: '10px', fontSize: 13, fontWeight: 700,
                    background: green, border: 'none', borderRadius: 8, color: '#000', cursor: 'pointer',
                  }}>▶ Resume</button>
                )}
                <button onClick={stopBot} style={{
                  width: '100%', padding: '10px', fontSize: 13, fontWeight: 700,
                  background: red, border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer',
                }}>■ Stop</button>
              </div>
            )}
            {autoUpdate && (
              <div style={{ marginTop: 10, fontSize: 11, color: txt2, textAlign: 'center' }}>
                Status:{' '}
                <span style={{ color: autoUpdate.status === 'running' ? green : autoUpdate.status === 'paused' ? amber : txt1 }}>
                  {autoUpdate.status}
                </span>
              </div>
            )}
          </div>

          {/* Live Stats */}
          {autoUpdate && autoUpdate.run_count > 0 && (
            <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '16px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Live Stats</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Trades',  value: autoUpdate.run_count,  color: txt0  },
                  { label: 'Win %',   value: winRate !== null ? `${winRate}%` : '—', color: txt0 },
                  { label: 'Wins',    value: autoUpdate.win_count,  color: green },
                  { label: 'Losses',  value: autoUpdate.loss_count, color: red   },
                  {
                    label: 'P&L',
                    value: `${autoUpdate.total_profit >= 0 ? '+' : ''}${autoUpdate.total_profit.toFixed(2)}`,
                    color: autoUpdate.total_profit >= 0 ? green : red,
                  },
                  { label: 'Stake', value: `${autoUpdate.current_stake.toFixed(2)}`, color: amber },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, color: txt2, marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* About */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>About</div>
            <p style={{ fontSize: 12, color: txt1, lineHeight: 1.6, margin: 0 }}>{bot.description}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
