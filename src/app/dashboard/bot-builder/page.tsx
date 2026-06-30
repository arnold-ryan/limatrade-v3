'use client'
/**
 * Bot Builder — visual block-based bot config + run via Deriv Automation API
 * Bot config stored in localStorage: lima_trade_pending_bot
 * NEW Deriv API only — wss://api.derivws.com/trading/v1/options/ws/public
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const LS_KEY = 'lima_trade_pending_bot'
const BARRIER_TYPES = new Set(['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'])

const MARKETS = [
  { symbol: 'R_10',    name: 'Volatility 10 Index'       },
  { symbol: 'R_25',    name: 'Volatility 25 Index'       },
  { symbol: 'R_50',    name: 'Volatility 50 Index'       },
  { symbol: 'R_75',    name: 'Volatility 75 Index'       },
  { symbol: 'R_100',   name: 'Volatility 100 Index'      },
  { symbol: '1HZ10V',  name: 'Volatility 10 (1s) Index'  },
  { symbol: '1HZ25V',  name: 'Volatility 25 (1s) Index'  },
  { symbol: '1HZ50V',  name: 'Volatility 50 (1s) Index'  },
  { symbol: '1HZ75V',  name: 'Volatility 75 (1s) Index'  },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s) Index' },
]

const CT_META: Record<string, { label: string; color: string; icon: string; desc: string }> = {
  DIGITEVEN:  { label: 'Even',   color: '#22c55e', icon: '⊙', desc: 'Last digit is even (0,2,4,6,8)' },
  DIGITODD:   { label: 'Odd',    color: '#a855f7', icon: '⊗', desc: 'Last digit is odd (1,3,5,7,9)'  },
  DIGITOVER:  { label: 'Over',   color: '#3b82f6', icon: '▲', desc: 'Last digit is over barrier'     },
  DIGITUNDER: { label: 'Under',  color: '#f97316', icon: '▼', desc: 'Last digit is under barrier'    },
  DIGITMATCH: { label: 'Match',  color: '#FCA311', icon: '◎', desc: 'Last digit matches barrier'     },
  DIGITDIFF:  { label: 'Differ', color: '#14b8a6', icon: '◈', desc: 'Last digit differs from barrier'},
}

interface BotConfig {
  strategy_id: string
  display_name: string
  description?: string
  contract_type: string
  parameters: Record<string, any>
  market: string
  barrier: string
  stake: string
  params: Record<string, string>
}

interface RunContract {
  contract_id: number
  buy_price: number
  sell_price?: number
  contract_status: 'open' | 'won' | 'lost'
}

interface ActiveRun {
  run_id: string
  status: 'running' | 'paused' | 'stopped'
  contracts: RunContract[]
  total_stake: number
  total_payout: number
  stop_reason?: string
}

function parseParams(values: Record<string, string>, schema: Record<string, any>): Record<string, any> {
  const props = schema?.properties ?? {}
  const out: Record<string, any> = {}
  for (const [k, raw] of Object.entries(values)) {
    if (raw === '' || raw === undefined) continue
    const s = props[k]
    if (!s) { out[k] = raw; continue }
    if (s.type === 'boolean') { out[k] = raw === 'true' }
    else if (s.type === 'integer') { const v = parseInt(raw); if (!isNaN(v)) out[k] = v }
    else if (s.type === 'number')  { const v = parseFloat(raw); if (!isNaN(v)) out[k] = v }
    else { out[k] = raw }
  }
  return out
}

function Block({ color, label, icon, children }: {
  color: string; label: string; icon: string; children: React.ReactNode
}) {
  return (
    <div style={{ borderRadius: '12px', overflow: 'hidden', border: `1px solid ${color}33` }}>
      <div style={{ background: `${color}20`, borderBottom: `1px solid ${color}33`, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: 28, height: 28, borderRadius: '8px', background: `${color}30`, border: `1px solid ${color}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color, flexShrink: 0 }}>
          {icon}
        </div>
        <span style={{ fontWeight: 700, fontSize: '0.8rem', color, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ padding: '14px 16px', background: '#090909' }}>{children}</div>
    </div>
  )
}

function BlockRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
      <span style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.4)', minWidth: 110, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

const selectStyle = { width: '100%', background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '6px 10px', fontSize: '0.78rem', color: '#e5e5e5' }
const inputStyle  = { width: '100%', boxSizing: 'border-box' as const, background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '6px 10px', fontSize: '0.78rem', color: '#e5e5e5' }

export default function BotBuilderPage() {
  const router = useRouter()
  const [bot, setBot]         = useState<BotConfig | null>(null)
  const [loaded, setLoaded]   = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [currency, setCurrency] = useState('USD')
  const [authReady, setAuthReady] = useState(false)
  const [wsErr, setWsErr]     = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const [startErr, setStartErr]   = useState<string | null>(null)
  const [subId, setSubId]     = useState<string | null>(null)

  const authWsRef    = useRef<WebSocket | null>(null)
  const activeRunRef = useRef<ActiveRun | null>(null)
  const subIdRef     = useRef<string | null>(null)
  const reqIdRef     = useRef(0)
  useEffect(() => { activeRunRef.current = activeRun }, [activeRun])
  useEffect(() => { subIdRef.current = subId },         [subId])

  // Load from localStorage
  useEffect(() => {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) setBot(JSON.parse(raw)) } catch { /**/ }
    setLoaded(true)
  }, [])

  // Persist edits
  useEffect(() => { if (bot) localStorage.setItem(LS_KEY, JSON.stringify(bot)) }, [bot])

  // Auth WebSocket
  useEffect(() => {
    let ws: WebSocket | null = null, dead = false
    let ping: ReturnType<typeof setInterval>

    async function connect() {
      try {
        const r = await fetch('/api/user/ws-url', { cache: 'no-store' })
        if (!r.ok) { setWsErr('Not logged in — please log in to run bots.'); return }
        const { wsUrl } = await r.json()
        if (!wsUrl)     { setWsErr('Could not get connection URL.'); return }
        ws = new WebSocket(wsUrl)
        authWsRef.current = ws

        ws.onopen = () => {
          if (dead) return
          setAuthReady(true); setWsErr(null)
          ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
          ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })) }, 25_000)
        }

        ws.onmessage = ev => {
          if (dead) return
          let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
          if (msg.error?.code === 'AuthorizationRequired' || msg.error?.code === 'InvalidToken') { setWsErr('Session expired.'); ws?.close(); return }
          if (msg.msg_type === 'balance') { const b = msg.balance; setBalance(b.balance); setCurrency(b.currency) }
          if (msg.msg_type === 'auto_start') {
            if (msg.error) { setStartErr(msg.error.message ?? 'Failed to start bot'); setActiveRun(null); return }
            const run = msg.auto_start
            if (msg.subscription?.id) setSubId(msg.subscription.id)
            setActiveRun(prev => ({
              run_id:       run.run_id,
              status:       run.status,
              contracts:    run.contracts ?? prev?.contracts ?? [],
              total_stake:  run.total_stake  ?? prev?.total_stake  ?? 0,
              total_payout: run.total_payout ?? prev?.total_payout ?? 0,
              stop_reason:  run.stop_reason,
            }))
            if (run.status === 'stopped') setTimeout(() => setActiveRun(p => p?.status === 'stopped' ? null : p), 3000)
          }
          if (['auto_stop','auto_pause','auto_resume'].includes(msg.msg_type)) {
            if (msg.error) { setStartErr(msg.error.message ?? 'Action failed'); return }
            const d = msg[msg.msg_type]
            setActiveRun(p => p && p.run_id === d.run_id ? { ...p, status: d.status } : p)
          }
        }
        ws.onerror = () => {}
        ws.onclose = () => {
          setAuthReady(false); authWsRef.current = null
          if (activeRunRef.current) setActiveRun(null)
          if (!dead) setTimeout(connect, 3000)
        }
      } catch { if (!dead) setTimeout(connect, 5000) }
    }
    connect()
    return () => { dead = true; clearInterval(ping); try { ws?.close() } catch { /**/ } }
  }, [])

  const runBot = useCallback(() => {
    const ws = authWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) { setStartErr('Not connected. Wait a moment.'); return }
    if (!bot) return
    const stake = parseFloat(bot.stake)
    if (isNaN(stake) || stake < 0.35) { setStartErr('Minimum stake is $0.35'); return }
    setStartErr(null)
    setActiveRun({ run_id: '', status: 'running', contracts: [], total_stake: 0, total_payout: 0 })
    const contractTemplate: Record<string, any> = {
      contract_type: bot.contract_type, currency,
      underlying_symbol: bot.market,
      amount: parseFloat(stake.toFixed(2)), basis: 'stake', duration: 1, duration_unit: 't',
    }
    if (BARRIER_TYPES.has(bot.contract_type) && bot.barrier !== '') contractTemplate.barrier = bot.barrier
    ws.send(JSON.stringify({
      auto_start: 1, strategy_id: bot.strategy_id,
      contract_template: contractTemplate,
      strategy_parameters: parseParams(bot.params, bot.parameters),
      subscribe: 1, req_id: ++reqIdRef.current,
    }))
  }, [bot, currency])

  const stopBot = useCallback(() => {
    const ws = authWsRef.current; const run = activeRunRef.current
    if (!run?.run_id || !ws || ws.readyState !== WebSocket.OPEN) { setActiveRun(null); return }
    ws.send(JSON.stringify({ auto_stop: 1, run_id: run.run_id, req_id: ++reqIdRef.current }))
    if (subIdRef.current) { ws.send(JSON.stringify({ forget: subIdRef.current, req_id: ++reqIdRef.current })); setSubId(null) }
  }, [])

  const pauseBot  = useCallback(() => { const ws = authWsRef.current; const run = activeRunRef.current; if (!run?.run_id || !ws) return; ws.send(JSON.stringify({ auto_pause: 1, run_id: run.run_id, req_id: ++reqIdRef.current })) }, [])
  const resumeBot = useCallback(() => { const ws = authWsRef.current; const run = activeRunRef.current; if (!run?.run_id || !ws) return; ws.send(JSON.stringify({ auto_resume: 1, run_id: run.run_id, req_id: ++reqIdRef.current })) }, [])

  const meta       = bot ? (CT_META[bot.contract_type] ?? { label: bot.contract_type, color: '#FCA311', icon: '◉', desc: '' }) : null
  const accent     = meta?.color ?? '#FCA311'
  const paramProps = bot ? Object.entries(bot.parameters?.properties ?? {}) as [string, any][] : []
  const profit     = activeRun ? parseFloat((activeRun.total_payout - activeRun.total_stake).toFixed(2)) : 0
  const wins       = activeRun?.contracts.filter(c => c.contract_status === 'won').length  ?? 0
  const losses     = activeRun?.contracts.filter(c => c.contract_status === 'lost').length ?? 0

  return (
    <div style={{ minHeight: '100%', background: '#000', color: '#e5e5e5', padding: '1.5rem', fontFamily: 'var(--font-geist-sans, sans-serif)' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 800, margin: 0 }}>Bot Builder</h1>
          <p style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)', margin: '3px 0 0' }}>
            {bot ? `${bot.display_name} · ${bot.contract_type}` : 'No bot loaded — browse Free Bots to pick one'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {balance !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#FCA311' }}>{balance.toFixed(2)} {currency}</div>
              <div style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.4)' }}>Balance</div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', borderRadius: '999px', background: authReady ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${authReady ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`, fontSize: '0.7rem', fontWeight: 600, color: authReady ? '#22c55e' : '#ef4444' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: authReady ? '#22c55e' : '#ef4444' }} />
            {authReady ? 'Connected' : 'Connecting'}
          </div>
          <button onClick={() => router.push('/dashboard/free-bots')} style={{ padding: '7px 16px', borderRadius: '9px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', color: 'rgba(229,229,229,0.7)', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
            ← Browse Bots
          </button>
        </div>
      </div>

      {/* Error banners */}
      {wsErr && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '0.82rem', color: '#ef4444' }}>{wsErr}</div>
      )}
      {startErr && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', fontSize: '0.82rem', color: '#ef4444', display: 'flex', justifyContent: 'space-between' }}>
          {startErr}
          <button onClick={() => setStartErr(null)} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Empty state */}
      {loaded && !bot && (
        <div style={{ textAlign: 'center', padding: '5rem 2rem', borderRadius: '16px', border: '1px dashed rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.01)' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🤖</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>No bot loaded</div>
          <div style={{ fontSize: '0.82rem', color: 'rgba(229,229,229,0.4)', marginBottom: '1.5rem' }}>Go to Free Bots, click any bot card, and it will appear here ready to configure and run.</div>
          <button onClick={() => router.push('/dashboard/free-bots')} style={{ padding: '10px 28px', borderRadius: '10px', background: '#FCA311', color: '#000', fontWeight: 800, fontSize: '0.88rem', border: 'none', cursor: 'pointer' }}>
            Browse Free Bots →
          </button>
        </div>
      )}

      {/* Bot editor */}
      {bot && meta && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '1.5rem', alignItems: 'start' }}>

          {/* Left — blocks */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>

            {/* Block 1: Trade Definition */}
            <Block color={accent} label="Trade Definition" icon="◧">
              <BlockRow label="Market">
                <select value={bot.market} disabled={!!activeRun} onChange={e => setBot(p => p && ({ ...p, market: e.target.value }))} style={selectStyle}>
                  {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.name}</option>)}
                </select>
              </BlockRow>
              <BlockRow label="Contract Type">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '7px', background: `${accent}15`, border: `1px solid ${accent}33` }}>
                  <span style={{ color: accent }}>{meta.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: '0.78rem', color: accent }}>{bot.contract_type}</span>
                  <span style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.4)' }}>— {meta.desc}</span>
                </div>
              </BlockRow>
              <BlockRow label="Stake ($)">
                <input type="number" value={bot.stake} step="0.01" min="0.35" disabled={!!activeRun}
                  onChange={e => setBot(p => p && ({ ...p, stake: e.target.value }))} style={inputStyle} />
              </BlockRow>
              {BARRIER_TYPES.has(bot.contract_type) && (
                <BlockRow label="Barrier Digit">
                  <select value={bot.barrier} disabled={!!activeRun} onChange={e => setBot(p => p && ({ ...p, barrier: e.target.value }))} style={selectStyle}>
                    {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                  </select>
                </BlockRow>
              )}
              <BlockRow label="Duration">
                <div style={{ padding: '6px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)' }}>1 tick (fixed)</div>
              </BlockRow>
            </Block>

            {/* Connector */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div style={{ width: 2, height: 20, background: 'rgba(255,255,255,0.1)' }} />
            </div>

            {/* Block 2: Strategy Parameters */}
            {paramProps.length > 0 && (
              <>
                <Block color="#a855f7" label="Strategy Parameters" icon="⚙">
                  {paramProps.map(([pName, pSchema]) => {
                    const lbl = pName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                    const val = bot.params[pName] ?? ''
                    const updateParam = (v: string) => setBot(p => p && ({ ...p, params: { ...p.params, [pName]: v } }))

                    if (pSchema.type === 'boolean') return (
                      <BlockRow key={pName} label={lbl}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                          <input type="checkbox" checked={val === 'true'} disabled={!!activeRun}
                            onChange={e => updateParam(e.target.checked ? 'true' : 'false')}
                            style={{ accentColor: '#a855f7', width: 15, height: 15 }} />
                          <span style={{ fontSize: '0.75rem', color: 'rgba(229,229,229,0.6)' }}>{val === 'true' ? 'Enabled' : 'Disabled'}</span>
                        </label>
                      </BlockRow>
                    )
                    if (pSchema.enum) return (
                      <BlockRow key={pName} label={lbl}>
                        <select value={val} disabled={!!activeRun} onChange={e => updateParam(e.target.value)} style={selectStyle}>
                          {pSchema.enum.map((v: string) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </BlockRow>
                    )
                    const itype = (pSchema.type === 'integer' || pSchema.type === 'number') ? 'number' : 'text'
                    const step  = pSchema.type === 'number' ? '0.01' : '1'
                    const min   = String(pSchema.minimum ?? (pSchema.type === 'integer' ? 1 : 0.01))
                    return (
                      <BlockRow key={pName} label={lbl}>
                        <input type={itype} value={val} step={step} min={min} disabled={!!activeRun}
                          onChange={e => updateParam(e.target.value)} style={inputStyle} />
                      </BlockRow>
                    )
                  })}
                </Block>

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: 2, height: 20, background: 'rgba(255,255,255,0.1)' }} />
                </div>
              </>
            )}

            {/* Block 3: After Purchase */}
            <Block color="#3b82f6" label="After Purchase" icon="↺">
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                {[
                  { label: 'On Win',  value: 'Reset to initial stake', color: '#22c55e' },
                  { label: 'On Lose', value: 'Apply strategy logic',   color: '#ef4444' },
                ].map(row => (
                  <div key={row.label} style={{ flex: 1, borderRadius: '8px', padding: '8px 12px', background: `${row.color}0c`, border: `1px solid ${row.color}25` }}>
                    <div style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.4)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{row.label}</div>
                    <div style={{ fontSize: '0.72rem', color: row.color, fontWeight: 600 }}>{row.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.4)', lineHeight: 1.6, padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                Strategy: <span style={{ color: '#FCA311', fontWeight: 600 }}>{bot.display_name}</span>
                {bot.description && <span> — {bot.description}</span>}
              </div>
            </Block>
          </div>

          {/* Right — controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', position: 'sticky', top: '1rem' }}>

            {/* Run controls */}
            <div style={{ borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)', background: '#090909', overflow: 'hidden' }}>
              <div style={{ padding: '11px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontWeight: 700, fontSize: '0.75rem', color: 'rgba(229,229,229,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Controls</div>
              <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {!activeRun && (
                  <button disabled={!authReady} onClick={runBot} style={{ width: '100%', padding: '12px', borderRadius: '10px', border: 'none', background: authReady ? accent : 'rgba(255,255,255,0.06)', color: authReady ? '#000' : 'rgba(229,229,229,0.2)', fontWeight: 800, fontSize: '0.9rem', cursor: authReady ? 'pointer' : 'not-allowed', transition: 'all 0.2s' }}>
                    {authReady ? `▶  Run Bot` : '⟳ Connecting…'}
                  </button>
                )}
                {activeRun?.status === 'running' && (<>
                  <button onClick={pauseBot} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid rgba(252,163,17,0.3)', background: 'rgba(252,163,17,0.08)', color: '#FCA311', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>⏸ Pause</button>
                  <button onClick={stopBot}  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid rgba(239,68,68,0.3)',  background: 'rgba(239,68,68,0.08)',  color: '#ef4444', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>■ Stop</button>
                </>)}
                {activeRun?.status === 'paused' && (<>
                  <button onClick={resumeBot} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)', color: '#22c55e', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>▶ Resume</button>
                  <button onClick={stopBot}   style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>■ Stop</button>
                </>)}
              </div>
            </div>

            {/* Status */}
            {activeRun && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', borderRadius: '9px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', fontSize: '0.78rem' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: activeRun.status === 'running' ? '#22c55e' : activeRun.status === 'paused' ? '#FCA311' : '#ef4444', animation: activeRun.status === 'running' ? 'pulse 1.5s infinite' : 'none' }} />
                <span style={{ fontWeight: 700 }}>{activeRun.status === 'running' ? 'Bot Running' : activeRun.status === 'paused' ? 'Bot Paused' : 'Bot Stopped'}</span>
                {activeRun.run_id && <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.35)', fontFamily: 'monospace', marginLeft: 'auto' }}>#{activeRun.run_id.slice(0,8)}</span>}
              </div>
            )}

            {/* Live stats */}
            {activeRun && (
              <div style={{ borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)', background: '#090909', overflow: 'hidden' }}>
                <div style={{ padding: '11px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontWeight: 700, fontSize: '0.75rem', color: 'rgba(229,229,229,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Live Results</div>
                <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {[
                    { label: 'Trades', value: String(activeRun.contracts.length) },
                    { label: 'Wins',   value: String(wins),   color: '#22c55e' },
                    { label: 'Losses', value: String(losses), color: '#ef4444' },
                    { label: 'Staked', value: `$${activeRun.total_stake.toFixed(2)}` },
                    { label: 'Payout', value: `$${activeRun.total_payout.toFixed(2)}` },
                    { label: 'P / L',  value: `${profit>=0?'+':''}$${profit.toFixed(2)}`, color: profit>=0?'#22c55e':'#ef4444' },
                  ].map(s => (
                    <div key={s.label} style={{ borderRadius: '9px', padding: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', textAlign: 'center' }}>
                      <div style={{ fontSize: '1.05rem', fontWeight: 800, color: (s as any).color ?? '#e5e5e5' }}>{s.value}</div>
                      <div style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.35)', marginTop: '3px' }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                {activeRun.contracts.length > 0 && (
                  <div style={{ padding: '0 14px 14px', display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                    {[...activeRun.contracts].reverse().slice(0, 24).map(c => (
                      <div key={c.contract_id} style={{ width: 22, height: 22, borderRadius: '5px', background: c.contract_status==='open'?'rgba(252,163,17,0.2)':c.contract_status==='won'?'rgba(34,197,94,0.25)':'rgba(239,68,68,0.25)', border: `1px solid ${c.contract_status==='open'?'rgba(252,163,17,0.4)':c.contract_status==='won'?'rgba(34,197,94,0.4)':'rgba(239,68,68,0.4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.58rem', color: c.contract_status==='open'?'#FCA311':c.contract_status==='won'?'#22c55e':'#ef4444' }}>
                        {c.contract_status==='open'?'●':c.contract_status==='won'?'✓':'✗'}
                      </div>
                    ))}
                  </div>
                )}
                {activeRun.stop_reason && <div style={{ padding: '0 14px 14px', fontSize: '0.72rem', color: 'rgba(229,229,229,0.4)' }}>Stopped: {activeRun.stop_reason}</div>}
              </div>
            )}

            {/* Bot info */}
            <div style={{ borderRadius: '14px', border: '1px solid rgba(255,255,255,0.06)', background: '#090909', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.35)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Loaded Strategy</div>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '3px' }}>{bot.display_name}</div>
              {bot.description && <div style={{ fontSize: '0.73rem', color: 'rgba(229,229,229,0.45)', lineHeight: 1.5, marginBottom: '10px' }}>{bot.description}</div>}
              <button onClick={() => { if (activeRun) return; setBot(null); localStorage.removeItem(LS_KEY); router.push('/dashboard/free-bots') }} disabled={!!activeRun}
                style={{ width: '100%', padding: '7px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', color: activeRun ? 'rgba(229,229,229,0.2)' : 'rgba(229,229,229,0.5)', fontSize: '0.75rem', cursor: activeRun ? 'not-allowed' : 'pointer' }}>
                Change Bot
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>
    </div>
  )
}
