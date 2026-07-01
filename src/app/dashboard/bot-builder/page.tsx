'use client'

/**
 * Lima Trade — Bot Builder Page v107
 *
 * Reads lima_trade_pending_bot from localStorage.
 * Shows visual block editor and run controls via Deriv automation API.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const LS_KEY = 'lima_trade_pending_bot'

interface BotConfig {
  strategy_id:   string
  display_name:  string
  description:   string
  contract_type: string
  parameters:    Record<string, unknown>[]
  market:        string
  stake:         string
  params:        Record<string, string>
}

interface AutoUpdate {
  status:       string
  run_count?:   number
  win_count?:   number
  loss_count?:  number
  total_profit?: number
  current_stake?: number
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
  const [bot,       setBot]       = useState<BotConfig|null>(null)
  const [running,   setRunning]   = useState(false)
  const [paused,    setPaused]    = useState(false)
  const [balance,   setBalance]   = useState<number|null>(null)
  const [currency,  setCurrency]  = useState('USD')
  const [authReady, setAuthReady] = useState(false)
  const [authErr,   setAuthErr]   = useState<string|null>(null)
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdate|null>(null)
  const [runId,     setRunId]     = useState<string|null>(null)
  const [authKey]                 = useState(0)

  const authRef = useRef<WebSocket|null>(null)
  const runIdRef = useRef<string|null>(null)

  // Read bot config from localStorage on mount
  useEffect(() => {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      try { setBot(JSON.parse(raw)) } catch {}
    }
  }, [])

  // Auth WS for balance + auto trading
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
            if (msg.balance) {
              setBalance(msg.balance.balance)
              setCurrency(msg.balance.currency ?? 'USD')
            }
            if (msg.auto_start || msg.auto_resume || msg.auto_pause) {
              const data = msg.auto_start ?? msg.auto_resume ?? msg.auto_pause
              if (data?.run_id) { setRunId(data.run_id); runIdRef.current = data.run_id }
            }
            if (msg.auto_stop) {
              setRunning(false); setPaused(false)
              setRunId(null); runIdRef.current = null
            }
            // Live updates when running with subscribe:1
            if (msg.msg_type === 'auto_start' && msg.auto_start) {
              const u = msg.auto_start
              setAutoUpdate({
                status:        u.status ?? 'running',
                run_count:     u.run_count,
                win_count:     u.win_count,
                loss_count:    u.loss_count,
                total_profit:  u.total_profit,
                current_stake: u.current_stake,
              })
            }
          } catch (err) { console.error('[BotBuilder WS]', err) }
        }

        ws.onclose = () => { if (alive) { setAuthReady(false); setTimeout(connect, 3000) } }
      } catch { setAuthErr('Auth WS error') }
    }

    connect()
    return () => { alive = false; ws?.close() }
  }, [authKey])

  const runBot = useCallback(() => {
    const ws = authRef.current
    if (!ws || !bot || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      auto_start: 1,
      subscribe: 1,
      strategy_id: bot.strategy_id,
      contract_type: bot.contract_type,
      underlying_symbol: bot.market,
      amount: parseFloat(bot.stake) || 1,
      currency: currency || 'USD',
      duration: 1,
      duration_unit: 't',
      ...bot.params,
    }))
    setRunning(true); setPaused(false)
  }, [bot, currency])

  const pauseBot = useCallback(() => {
    const ws = authRef.current
    const id = runIdRef.current
    if (!ws || !id) return
    ws.send(JSON.stringify({ auto_pause: 1, run_id: id }))
    setPaused(true)
  }, [])

  const resumeBot = useCallback(() => {
    const ws = authRef.current
    const id = runIdRef.current
    if (!ws || !id) return
    ws.send(JSON.stringify({ auto_resume: 1, run_id: id }))
    setPaused(false)
  }, [])

  const stopBot = useCallback(() => {
    const ws = authRef.current
    const id = runIdRef.current
    if (!ws || !id) return
    ws.send(JSON.stringify({ auto_stop: 1, run_id: id }))
  }, [])

  const changeBot = useCallback(() => {
    localStorage.removeItem(LS_KEY)
    router.push('/dashboard/free-bots')
  }, [router])

  // ── Empty state ──
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
          Go to Free Bots, click a strategy, and it will appear here ready to run.
        </div>
        <button onClick={() => router.push('/dashboard/free-bots')} style={{
          marginTop: 8, padding: '10px 24px', fontSize: 13, fontWeight: 700,
          background: amber, border: 'none', borderRadius: 8, color: '#000', cursor: 'pointer',
        }}>Browse Free Bots</button>
      </div>
    )
  }

  const winRate = autoUpdate && (autoUpdate.run_count ?? 0) > 0
    ? Math.round(((autoUpdate.win_count ?? 0) / (autoUpdate.run_count ?? 1)) * 100)
    : null

  return (
    <div style={{ minHeight: '100vh', background: bg0, fontFamily: 'Inter, system-ui, sans-serif', padding: '20px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={changeBot} style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: 'transparent', border: `1px solid ${bdr}`,
          borderRadius: 6, color: txt1, cursor: 'pointer',
        }}>← Change Bot</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: txt0 }}>{bot.display_name}</div>
          <div style={{ fontSize: 11, color: txt1 }}>{CT_LABEL[bot.contract_type] ?? bot.contract_type} · {bot.market}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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

        {/* Visual blocks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Trade Definition block */}
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
                { label: 'Stake',         value: `${bot.stake} ${currency}` },
                { label: 'Duration',      value: '1 tick' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: 10, color: txt2, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: txt0 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Strategy Parameters block */}
          {bot.parameters.length > 0 && (
            <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ background: '#1a1c3a', padding: '10px 14px', borderBottom: `1px solid ${bdr}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: blue, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  ⚙ Strategy Parameters
                </span>
              </div>
              <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {bot.parameters.map((p: any) => (
                  <div key={p.name}>
                    <div style={{ fontSize: 10, color: txt2, marginBottom: 4 }}>{p.display_name ?? p.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: txt0 }}>{bot.params[p.name] ?? p.default ?? '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* After Purchase block */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ background: '#3a1c1c', padding: '10px 14px', borderBottom: `1px solid ${bdr}` }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: red, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                ↻ After Purchase
              </span>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 12, color: txt1 }}>Follows the strategy's built-in restart logic.</div>
            </div>
          </div>
        </div>

        {/* Right panel: controls + stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Run controls */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Controls</div>
            {!running ? (
              <button onClick={runBot} disabled={!authReady} style={{
                width: '100%', padding: '10px', fontSize: 13, fontWeight: 700,
                background: authReady ? green : bg2,
                border: 'none', borderRadius: 8, color: '#000',
                cursor: authReady ? 'pointer' : 'not-allowed',
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
          </div>

          {/* Live stats */}
          {running && autoUpdate && (
            <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '16px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Live Stats</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Trades',  value: autoUpdate.run_count ?? 0 },
                  { label: 'Win %',   value: winRate !== null ? `${winRate}%` : '—' },
                  { label: 'Wins',    value: autoUpdate.win_count ?? 0, color: green },
                  { label: 'Losses',  value: autoUpdate.loss_count ?? 0, color: red },
                  { label: 'P&L',     value: autoUpdate.total_profit !== undefined
                      ? `${autoUpdate.total_profit >= 0 ? '+' : ''}${autoUpdate.total_profit.toFixed(2)}`
                      : '—',
                    color: (autoUpdate.total_profit ?? 0) >= 0 ? green : red },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, color: txt2, marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: color ?? txt0 }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          <div style={{ background: bg1, border: `1px solid ${bdr}`, borderRadius: 10, padding: '16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>About</div>
            <p style={{ fontSize: 12, color: txt1, lineHeight: 1.6, margin: 0 }}>{bot.description}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
