'use client'
/**
 * Free Bots — powered by Deriv's native Automation API
 *
 * Architecture:
 *  PUBLIC WS  → auto_list_strategies (no auth), ticks for dominant-digit analysis
 *  AUTH WS    → balance, auto_start (subscribe:1), auto_stop, auto_pause, auto_resume
 *
 * API refs:
 *  auto_list_strategies : /schemas/auto_list_strategies_request.schema.json
 *  auto_start           : /schemas/auto_start_request.schema.json
 *  auto_stop            : /schemas/auto_stop_request.schema.json
 *  contract_template    : requires contract_type, currency, underlying_symbol
 *  strategy_parameters  : object; shape defined per-strategy in strategies[].parameters
 */

import { useCallback, useEffect, useRef, useState } from 'react'

// ── Constants ──────────────────────────────────────────────────────────────
const PUB_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'

const DIGIT_CONTRACT_TYPES = new Set([
  'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF',
])

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

// Contract type display info
const CT_META: Record<string, { label: string; icon: string; color: string; desc: string }> = {
  DIGITEVEN:  { label: 'Even/Odd',        icon: '⊙', color: '#22c55e', desc: 'Bet the last digit is even (0,2,4,6,8)'  },
  DIGITODD:   { label: 'Even/Odd',        icon: '⊗', color: '#a855f7', desc: 'Bet the last digit is odd (1,3,5,7,9)'   },
  DIGITOVER:  { label: 'Over/Under',      icon: '▲', color: '#3b82f6', desc: 'Bet the last digit is over your barrier' },
  DIGITUNDER: { label: 'Over/Under',      icon: '▼', color: '#f97316', desc: 'Bet the last digit is under your barrier'},
  DIGITMATCH: { label: 'Match/Differ',    icon: '◎', color: '#FCA311', desc: 'Bet the last digit matches your barrier' },
  DIGITDIFF:  { label: 'Match/Differ',    icon: '◈', color: '#14b8a6', desc: 'Bet the last digit differs from barrier' },
}

// ── Types ──────────────────────────────────────────────────────────────────
interface DerivStrategy {
  strategy_id: string
  display_name: string
  description?: string
  parameters: Record<string, any>   // JSON Schema object
  supported_contract_types: string[]
}

interface RunContract {
  contract_id: number
  buy_price: number
  sell_price?: number
  contract_status: 'open' | 'won' | 'lost'
  purchase_time: number
}

interface ActiveRun {
  run_id: string
  botKey: string   // `${strategy_id}::${contract_type}`
  status: 'running' | 'paused' | 'stopped'
  contracts: RunContract[]
  total_stake: number
  total_payout: number
  stop_reason?: string
}

// Per-bot user config
interface BotConfig {
  market: string
  contract_type: string
  barrier: string
  stake: string
  // dynamic strategy params — stored as string values, parsed on send
  params: Record<string, string>
}

// ── Helper: render one strategy-parameter field ────────────────────────────
function ParamField({
  name, schema, value, onChange,
}: {
  name: string; schema: any; value: string; onChange: (v: string) => void
}) {
  const label = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const desc  = schema.description ?? ''

  if (schema.type === 'boolean') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.78rem' }}>
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={e => onChange(e.target.checked ? 'true' : 'false')}
          style={{ accentColor: '#FCA311', width: 14, height: 14 }}
        />
        <span style={{ color: 'rgba(229,229,229,0.7)' }}>{label}</span>
        {desc && <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.35)' }}>— {desc}</span>}
      </label>
    )
  }

  if (schema.enum) {
    return (
      <div>
        <label style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.4)', display: 'block', marginBottom: 3 }}>{label}</label>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ width: '100%', background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '5px 8px', fontSize: '0.8rem', color: '#e5e5e5' }}
        >
          {schema.enum.map((v: string) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
    )
  }

  const type  = schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text'
  const step  = schema.type === 'number' ? '0.01' : '1'
  const min   = schema.minimum ?? (schema.type === 'integer' ? 1 : 0.01)

  return (
    <div>
      <label style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.4)', display: 'block', marginBottom: 3 }}>
        {label} {desc && <span style={{ fontSize: '0.6rem', opacity: 0.5 }}>— {desc}</span>}
      </label>
      <input
        type={type} step={step} min={min}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '5px 8px', fontSize: '0.8rem', color: '#e5e5e5' }}
      />
    </div>
  )
}

// ── Build default param values from strategy.parameters schema ─────────────
function defaultParams(schema: Record<string, any>): Record<string, string> {
  const props = schema?.properties ?? {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(props) as [string, any][]) {
    if      (v.default !== undefined)              out[k] = String(v.default)
    else if (v.type === 'boolean')                 out[k] = 'false'
    else if (v.type === 'integer' || v.type === 'number') out[k] = String(v.minimum ?? 1)
    else if (v.enum)                               out[k] = String(v.enum[0])
    else                                            out[k] = ''
  }
  return out
}

// ── Parse param values to their correct JS types ───────────────────────────
function parseParams(values: Record<string, string>, schema: Record<string, any>): Record<string, any> {
  const props = schema?.properties ?? {}
  const out: Record<string, any> = {}
  for (const [k, raw] of Object.entries(values)) {
    const s = props[k]
    if (!s) { out[k] = raw; continue }
    if (s.type === 'boolean') out[k] = raw === 'true'
    else if (s.type === 'integer') out[k] = parseInt(raw) || 0
    else if (s.type === 'number')  out[k] = parseFloat(raw) || 0
    else out[k] = raw
  }
  return out
}

// ── Dominant digit analysis from recent ticks ─────────────────────────────
function lastDigitOf(price: number, dp: number) {
  return Math.abs(Math.round(price * 10 ** dp)) % 10
}

// ── Component ──────────────────────────────────────────────────────────────
export default function FreeBotsPage() {
  // Strategies from Deriv
  const [strategies,   setStrategies]   = useState<DerivStrategy[]>([])
  const [strategiesOk, setStrategiesOk] = useState(false)

  // Active run state
  const [activeRun,  setActiveRun]  = useState<ActiveRun | null>(null)
  const activeRunRef = useRef<ActiveRun | null>(null)
  useEffect(() => { activeRunRef.current = activeRun }, [activeRun])

  // Auth/connection
  const [balance,    setBalance]    = useState<number | null>(null)
  const [currency,   setCurrency]   = useState('USD')
  const [authReady,  setAuthReady]  = useState(false)
  const [wsErr,      setWsErr]      = useState<string | null>(null)

  // Dominant digit (from public WS ticks)
  const [digitFreq,  setDigitFreq]  = useState<number[]>(Array(10).fill(0))
  const [tickSymbol, setTickSymbol] = useState('R_100')

  // Per-bot config: key = `${strategy_id}::${contract_type}`
  const [configs,  setConfigs]  = useState<Record<string, BotConfig>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  // UI feedback
  const [startErr,   setStartErr]   = useState<string | null>(null)
  const [subId,      setSubId]      = useState<string | null>(null)  // subscription to forget on stop

  // WS refs
  const pubWsRef  = useRef<WebSocket | null>(null)
  const authWsRef = useRef<WebSocket | null>(null)
  const reqIdRef  = useRef(0)
  const subIdRef  = useRef<string | null>(null)
  useEffect(() => { subIdRef.current = subId }, [subId])

  // ── Public WS: auto_list_strategies + ticks for dominant digit ─────────
  useEffect(() => {
    let ws: WebSocket, dead = false, ping: ReturnType<typeof setInterval>

    function connect() {
      ws = new WebSocket(PUB_WS)
      pubWsRef.current = ws

      ws.onopen = () => {
        if (dead) return
        ws.send(JSON.stringify({ auto_list_strategies: 1, req_id: 1 }))
        ws.send(JSON.stringify({ ticks_history: 'R_100', count: 100, end: 'latest', style: 'ticks', req_id: 2 }))
        ws.send(JSON.stringify({ ticks: 'R_100', subscribe: 1, req_id: 3 }))
        ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })) }, 25_000)
      }

      ws.onmessage = ev => {
        if (dead) return
        let msg: any; try { msg = JSON.parse(ev.data) } catch { return }

        if (msg.msg_type === 'auto_list_strategies') {
          const list: DerivStrategy[] = (msg.auto_list_strategies?.strategies ?? []).filter(
            (s: DerivStrategy) => s.supported_contract_types.some(ct => DIGIT_CONTRACT_TYPES.has(ct))
          )
          setStrategies(list)
          setStrategiesOk(true)
          // Init configs for each strategy × digit contract type
          setConfigs(prev => {
            const next = { ...prev }
            for (const s of list) {
              for (const ct of s.supported_contract_types) {
                if (!DIGIT_CONTRACT_TYPES.has(ct)) continue
                const key = `${s.strategy_id}::${ct}`
                if (!next[key]) {
                  next[key] = {
                    market:        'R_100',
                    contract_type: ct,
                    barrier:       ct === 'DIGITOVER' || ct === 'DIGITMATCH' ? '5'
                                 : ct === 'DIGITUNDER' ? '4'
                                 : ct === 'DIGITDIFF'  ? '0' : '',
                    stake:         '1.00',
                    params:        defaultParams(s.parameters),
                  }
                }
              }
            }
            return next
          })
        }

        if (msg.msg_type === 'history') {
          const h = msg.history as { prices: (number | string)[] }
          if (!h?.prices?.length) return
          const freq = Array(10).fill(0)
          for (const p of h.prices) freq[lastDigitOf(parseFloat(String(p)), 3)]++
          setDigitFreq(freq)
        }

        if (msg.msg_type === 'tick') {
          const p = parseFloat(String(msg.tick?.quote ?? 0))
          if (!isNaN(p)) {
            const d = lastDigitOf(p, 3)
            setDigitFreq(prev => { const n = [...prev]; n[d]++; return n })
          }
        }
      }

      ws.onclose = () => { if (!dead) setTimeout(connect, 3000) }
      ws.onerror = () => {}
    }

    connect()
    return () => {
      dead = true
      clearInterval(ping)
      try { ws?.close() } catch {/**/}
    }
  }, [])

  // Sync tick symbol when config changes
  useEffect(() => {
    if (!pubWsRef.current || pubWsRef.current.readyState !== WebSocket.OPEN) return
    const ws = pubWsRef.current
    ws.send(JSON.stringify({ forget_all: 'ticks' }))
    ws.send(JSON.stringify({ ticks_history: tickSymbol, count: 100, end: 'latest', style: 'ticks', req_id: 2 }))
    ws.send(JSON.stringify({ ticks: tickSymbol, subscribe: 1, req_id: 3 }))
    setDigitFreq(Array(10).fill(0))
  }, [tickSymbol])

  // ── Auth WS ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null, dead = false, ping: ReturnType<typeof setInterval>

    async function connect() {
      try {
        const r = await fetch('/api/user/ws-url', { cache: 'no-store' })
        if (!r.ok) { setWsErr('Not logged in — please log in to use bots.'); return }
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

          if (msg.error?.code === 'AuthorizationRequired' || msg.error?.code === 'InvalidToken') {
            setWsErr('Session expired — please log in again.'); ws?.close(); return
          }

          if (msg.msg_type === 'balance') {
            const b = msg.balance as { balance: number; currency: string }
            setBalance(b.balance); setCurrency(b.currency)
          }

          // auto_start subscription updates (streaming run state)
          if (msg.msg_type === 'auto_start') {
            if (msg.error) {
              setStartErr(msg.error.message ?? 'Failed to start bot')
              setActiveRun(null)
              return
            }
            const run = msg.auto_start as {
              run_id: string; status: string; contracts?: RunContract[]
              total_stake?: number; total_payout?: number; stop_reason?: string
            }
            if (msg.subscription?.id) setSubId(msg.subscription.id)

            setActiveRun(prev => {
              const botKey = prev?.botKey ?? activeRunRef.current?.botKey ?? ''
              return {
                run_id:       run.run_id,
                botKey,
                status:       run.status as ActiveRun['status'],
                contracts:    run.contracts ?? prev?.contracts ?? [],
                total_stake:  run.total_stake  ?? prev?.total_stake  ?? 0,
                total_payout: run.total_payout ?? prev?.total_payout ?? 0,
                stop_reason:  run.stop_reason,
              }
            })

            // Auto-clear if stopped
            if (run.status === 'stopped') {
              setTimeout(() => {
                setActiveRun(prev => prev?.status === 'stopped' ? null : prev)
              }, 3000)
            }
          }

          if (msg.msg_type === 'auto_stop' || msg.msg_type === 'auto_pause' || msg.msg_type === 'auto_resume') {
            if (msg.error) { setStartErr(msg.error.message ?? 'Action failed'); return }
            const d = msg[msg.msg_type] as { run_id: string; status: string }
            setActiveRun(prev => prev && prev.run_id === d.run_id ? { ...prev, status: d.status as ActiveRun['status'] } : prev)
          }
        }

        ws.onerror = () => {}
        ws.onclose = () => {
          setAuthReady(false)
          authWsRef.current = null
          if (activeRunRef.current) setActiveRun(null)
          if (!dead) setTimeout(connect, 3000)
        }
      } catch {
        if (!dead) setTimeout(connect, 5000)
      }
    }

    connect()
    return () => {
      dead = true
      clearInterval(ping)
      if (ws) { try { ws.close() } catch {/**/} }
    }
  }, [])

  // ── Start bot ─────────────────────────────────────────────────────────────
  const startBot = useCallback((strategy: DerivStrategy, botKey: string) => {
    const ws  = authWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) { setStartErr('Not connected. Wait a moment.'); return }
    const cfg = configs[botKey]
    if (!cfg) return
    const stake = parseFloat(cfg.stake)
    if (isNaN(stake) || stake < 0.35) { setStartErr('Minimum stake is $0.35'); return }

    setStartErr(null)
    setActiveRun({ run_id: '', botKey, status: 'running', contracts: [], total_stake: 0, total_payout: 0 })

    const contractTemplate: Record<string, any> = {
      contract_type:     cfg.contract_type,
      currency,
      underlying_symbol: cfg.market,
      amount:            parseFloat(stake.toFixed(2)),
      basis:             'stake',
      duration:          1,
      duration_unit:     't',
    }
    if (BARRIER_TYPES.has(cfg.contract_type) && cfg.barrier !== '') {
      contractTemplate.barrier = cfg.barrier
    }

    ws.send(JSON.stringify({
      auto_start:          1,
      strategy_id:         strategy.strategy_id,
      contract_template:   contractTemplate,
      strategy_parameters: parseParams(cfg.params, strategy.parameters),
      subscribe:           1,
      req_id:              ++reqIdRef.current,
    }))
  }, [configs, currency])

  // ── Stop bot ──────────────────────────────────────────────────────────────
  const stopBot = useCallback(() => {
    const ws = authWsRef.current
    const run = activeRunRef.current
    if (!run?.run_id || !ws || ws.readyState !== WebSocket.OPEN) {
      setActiveRun(null); return
    }
    ws.send(JSON.stringify({ auto_stop: 1, run_id: run.run_id, req_id: ++reqIdRef.current }))
    // Forget subscription
    if (subIdRef.current) {
      ws.send(JSON.stringify({ forget: subIdRef.current, req_id: ++reqIdRef.current }))
      setSubId(null)
    }
  }, [])

  // ── Pause / Resume ────────────────────────────────────────────────────────
  const pauseBot = useCallback(() => {
    const ws = authWsRef.current; const run = activeRunRef.current
    if (!run?.run_id || !ws) return
    ws.send(JSON.stringify({ auto_pause: 1, run_id: run.run_id, req_id: ++reqIdRef.current }))
  }, [])

  const resumeBot = useCallback(() => {
    const ws = authWsRef.current; const run = activeRunRef.current
    if (!run?.run_id || !ws) return
    ws.send(JSON.stringify({ auto_resume: 1, run_id: run.run_id, req_id: ++reqIdRef.current }))
  }, [])

  // ── Dominant digit ────────────────────────────────────────────────────────
  const total   = digitFreq.reduce((a, b) => a + b, 0)
  const domDigit = total > 0 ? digitFreq.indexOf(Math.max(...digitFreq)) : null

  // ── Render ─────────────────────────────────────────────────────────────────
  const profit = activeRun ? parseFloat((activeRun.total_payout - activeRun.total_stake).toFixed(2)) : 0
  const wins   = activeRun?.contracts.filter(c => c.contract_status === 'won').length  ?? 0
  const losses = activeRun?.contracts.filter(c => c.contract_status === 'lost').length ?? 0

  return (
    <div style={{ minHeight: '100%', background: '#000', color: '#e5e5e5', padding: '1.5rem', fontFamily: 'var(--font-geist-sans, sans-serif)' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 800, margin: 0 }}>Free Bots</h1>
          <p style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)', margin: '3px 0 0' }}>
            Pre-built strategies powered by Deriv Automation API
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {balance !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#FCA311' }}>{balance.toFixed(2)} {currency}</div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.4)' }}>Balance</div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', borderRadius: '999px',
            background: authReady ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${authReady ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            fontSize: '0.7rem', fontWeight: 600, color: authReady ? '#22c55e' : '#ef4444',
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: authReady ? '#22c55e' : '#ef4444' }} />
            {authReady ? 'Connected' : 'Connecting'}
          </div>
        </div>
      </div>

      {/* ── Banners ────────────────────────────────────────────────────── */}
      {wsErr && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '0.82rem', color: '#ef4444' }}>
          {wsErr}
        </div>
      )}
      {startErr && (
        <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', fontSize: '0.82rem', color: '#ef4444', display: 'flex', justifyContent: 'space-between' }}>
          {startErr}
          <button onClick={() => setStartErr(null)} style={{ background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* ── Active Run Card ─────────────────────────────────────────────── */}
      {activeRun && (
        <div style={{ marginBottom: '1.5rem', padding: '1.25rem', borderRadius: '14px', background: 'rgba(252,163,17,0.06)', border: '1px solid rgba(252,163,17,0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: activeRun.status === 'running' ? '#22c55e' : activeRun.status === 'paused' ? '#FCA311' : '#ef4444', animation: activeRun.status === 'running' ? 'pulse 1.5s infinite' : 'none' }} />
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                {activeRun.status === 'running' ? 'Bot Running' : activeRun.status === 'paused' ? 'Bot Paused' : 'Bot Stopped'}
              </span>
              {activeRun.run_id && (
                <span style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.35)', fontFamily: 'monospace' }}>#{activeRun.run_id.slice(0, 8)}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {activeRun.status === 'running' && (
                <button onClick={pauseBot} style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(252,163,17,0.3)', background: 'rgba(252,163,17,0.08)', color: '#FCA311', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                  ⏸ Pause
                </button>
              )}
              {activeRun.status === 'paused' && (
                <button onClick={resumeBot} style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)', color: '#22c55e', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                  ▶ Resume
                </button>
              )}
              <button onClick={stopBot} style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                ■ Stop
              </button>
            </div>
          </div>

          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.6rem' }}>
            {[
              { label: 'Trades',  value: activeRun.contracts.length, color: undefined },
              { label: 'Wins',    value: wins,                        color: '#22c55e' },
              { label: 'Losses',  value: losses,                      color: '#ef4444' },
              { label: 'Staked',  value: `$${activeRun.total_stake.toFixed(2)}`,   color: undefined },
              { label: 'P/L',     value: `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`, color: profit >= 0 ? '#22c55e' : '#ef4444' },
            ].map(s => (
              <div key={s.label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '9px', padding: '8px', textAlign: 'center' }}>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: s.color ?? '#e5e5e5' }}>{s.value}</div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.4)', marginTop: '2px' }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Recent contracts */}
          {activeRun.contracts.length > 0 && (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {[...activeRun.contracts].reverse().slice(0, 20).map(c => (
                <div key={c.contract_id} style={{
                  width: 24, height: 24, borderRadius: '6px',
                  background: c.contract_status === 'open' ? 'rgba(252,163,17,0.2)'
                            : c.contract_status === 'won'  ? 'rgba(34,197,94,0.25)'
                            : 'rgba(239,68,68,0.25)',
                  border: `1px solid ${c.contract_status === 'open' ? 'rgba(252,163,17,0.4)' : c.contract_status === 'won' ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem',
                  color: c.contract_status === 'open' ? '#FCA311' : c.contract_status === 'won' ? '#22c55e' : '#ef4444',
                }}>
                  {c.contract_status === 'open' ? '●' : c.contract_status === 'won' ? '✓' : '✗'}
                </div>
              ))}
            </div>
          )}

          {activeRun.stop_reason && (
            <div style={{ marginTop: '0.6rem', fontSize: '0.75rem', color: 'rgba(229,229,229,0.5)' }}>
              Stopped: {activeRun.stop_reason}
            </div>
          )}
        </div>
      )}

      {/* ── Dominant Digit Analysis ─────────────────────────────────────── */}
      {total > 0 && (
        <div style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'rgba(229,229,229,0.6)' }}>
              Dominant Digit Analysis
              {domDigit !== null && (
                <span style={{ marginLeft: '0.5rem', color: '#FCA311' }}>
                  — Digit <strong>{domDigit}</strong> most frequent ({((digitFreq[domDigit] / total) * 100).toFixed(1)}%)
                </span>
              )}
            </div>
            <select
              value={tickSymbol}
              onChange={e => setTickSymbol(e.target.value)}
              style={{ background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '4px 8px', fontSize: '0.72rem', color: '#e5e5e5' }}
            >
              {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {digitFreq.map((f, d) => {
              const pct = total > 0 ? (f / total) * 100 : 0
              const isDom = d === domDigit
              return (
                <div key={d} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', marginBottom: 3 }}>
                    <div style={{
                      width: '70%', background: isDom ? '#FCA311' : 'rgba(255,255,255,0.12)',
                      borderRadius: '3px 3px 0 0',
                      height: `${Math.max(4, (pct / 20) * 100)}%`,
                      transition: 'height 0.3s',
                    }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: isDom ? 800 : 500, color: isDom ? '#FCA311' : 'rgba(229,229,229,0.6)' }}>{d}</div>
                  <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.35)' }}>{pct.toFixed(0)}%</div>
                </div>
              )
            })}
          </div>
          {domDigit !== null && (
            <div style={{ marginTop: '0.6rem', fontSize: '0.72rem', color: 'rgba(229,229,229,0.45)', fontStyle: 'italic' }}>
              💡 Tip: Digit {domDigit} is hot — consider a <strong style={{ color: '#14b8a6' }}>Differs</strong> strategy against it, or <strong style={{ color: '#FCA311' }}>Match</strong> if you expect it to continue.
            </div>
          )}
        </div>
      )}

      {/* ── Strategy loading state ──────────────────────────────────────── */}
      {!strategiesOk && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'rgba(229,229,229,0.3)', fontSize: '0.85rem' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>⟳</div>
          Loading available strategies from Deriv…
        </div>
      )}

      {strategiesOk && strategies.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'rgba(229,229,229,0.35)', fontSize: '0.85rem' }}>
          No digit strategies available from Deriv at the moment.
        </div>
      )}

      {/* ── Strategy cards ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {strategies.map(strategy => {
          const digitCTs = strategy.supported_contract_types.filter(ct => DIGIT_CONTRACT_TYPES.has(ct))
          return (
            <div key={strategy.strategy_id} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', overflow: 'hidden' }}>

              {/* Strategy header */}
              <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: '3px' }}>{strategy.display_name}</div>
                {strategy.description && (
                  <div style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)', lineHeight: 1.5 }}>{strategy.description}</div>
                )}
              </div>

              {/* Contract type cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1px', background: 'rgba(255,255,255,0.05)' }}>
                {digitCTs.map(ct => {
                  const botKey  = `${strategy.strategy_id}::${ct}`
                  const cfg     = configs[botKey]
                  const meta    = CT_META[ct] ?? { label: ct, icon: '◉', color: '#e5e5e5', desc: '' }
                  const isActive  = activeRun?.botKey === botKey
                  const isBlocked = activeRun !== null && !isActive
                  const isExpd    = expanded === botKey
                  const paramProps = Object.entries(strategy.parameters?.properties ?? {}) as [string, any][]

                  if (!cfg) return null

                  return (
                    <div key={botKey} style={{
                      background: isActive ? `${meta.color}08` : '#050505',
                      padding: '1rem',
                      opacity: isBlocked ? 0.4 : 1,
                      transition: 'all 0.2s',
                    }}>
                      {/* CT header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.6rem' }}>
                        <div style={{ width: 34, height: 34, borderRadius: '8px', background: `${meta.color}18`, border: `1px solid ${meta.color}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem', color: meta.color, flexShrink: 0 }}>
                          {meta.icon}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.85rem', color: meta.color }}>{ct}</div>
                          <div style={{ fontSize: '0.67rem', color: 'rgba(229,229,229,0.4)' }}>{meta.desc}</div>
                        </div>
                      </div>

                      {/* Quick settings row */}
                      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
                        {/* Market */}
                        <select
                          disabled={isActive || isBlocked}
                          value={cfg.market}
                          onChange={e => setConfigs(p => ({ ...p, [botKey]: { ...p[botKey], market: e.target.value } }))}
                          style={{ flex: 2, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '5px 6px', fontSize: '0.7rem', color: '#e5e5e5' }}
                        >
                          {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.name}</option>)}
                        </select>

                        {/* Stake */}
                        <input
                          type="number" step="0.01" min="0.35"
                          disabled={isActive || isBlocked}
                          value={cfg.stake}
                          onChange={e => setConfigs(p => ({ ...p, [botKey]: { ...p[botKey], stake: e.target.value } }))}
                          placeholder="Stake $"
                          style={{ flex: 1, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '5px 6px', fontSize: '0.72rem', color: '#e5e5e5' }}
                        />

                        {/* Barrier (if applicable) */}
                        {BARRIER_TYPES.has(ct) && (
                          <select
                            disabled={isActive || isBlocked}
                            value={cfg.barrier}
                            onChange={e => setConfigs(p => ({ ...p, [botKey]: { ...p[botKey], barrier: e.target.value } }))}
                            style={{ width: 52, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '5px 4px', fontSize: '0.7rem', color: '#e5e5e5' }}
                          >
                            {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={String(d)}>{d}</option>)}
                          </select>
                        )}
                      </div>

                      {/* Strategy params toggle */}
                      {paramProps.length > 0 && !isActive && (
                        <button
                          onClick={() => setExpanded(isExpd ? null : botKey)}
                          style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '7px', padding: '5px 10px', cursor: 'pointer', fontSize: '0.72rem', color: 'rgba(229,229,229,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isExpd ? '0.6rem' : '0.6rem' }}
                        >
                          <span>⚙ Strategy parameters</span>
                          <span style={{ transform: isExpd ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
                        </button>
                      )}

                      {isExpd && paramProps.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.7rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '0.6rem' }}>
                          {paramProps.map(([pName, pSchema]) => (
                            <ParamField
                              key={pName}
                              name={pName}
                              schema={pSchema}
                              value={cfg.params[pName] ?? ''}
                              onChange={v => setConfigs(prev => ({
                                ...prev,
                                [botKey]: { ...prev[botKey], params: { ...prev[botKey].params, [pName]: v } }
                              }))}
                            />
                          ))}
                        </div>
                      )}

                      {/* Run / Stop */}
                      <button
                        disabled={(!authReady && !isActive) || isBlocked}
                        onClick={() => isActive ? stopBot() : startBot(strategy, botKey)}
                        style={{
                          width: '100%', padding: '0.6rem', borderRadius: '9px',
                          fontWeight: 800, fontSize: '0.85rem',
                          cursor: isBlocked || (!authReady && !isActive) ? 'not-allowed' : 'pointer',
                          background: isActive    ? 'rgba(239,68,68,0.12)'
                                    : isBlocked   ? 'rgba(255,255,255,0.04)'
                                    : meta.color,
                          color:      isActive    ? '#ef4444'
                                    : isBlocked   ? 'rgba(229,229,229,0.2)'
                                    : '#000',
                          border:     isActive    ? '1px solid rgba(239,68,68,0.3)' : 'none',
                          transition: 'all 0.2s',
                        }}
                      >
                        {isActive ? '■ Stop Bot' : isBlocked ? 'Bot running…' : `▶ Run ${ct}`}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  )
}
