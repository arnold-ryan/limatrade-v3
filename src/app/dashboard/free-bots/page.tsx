'use client'
/**
 * Free Bots — browse strategies, click to load into Bot Builder
 * NEW Deriv API: wss://api.derivws.com/trading/v1/options/ws/public
 * auto_list_strategies (no auth) → click any bot → localStorage → /dashboard/bot-builder
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const PUB_WS = 'wss://api.derivws.com/trading/v1/options/ws/public'
const LS_KEY = 'lima_trade_pending_bot'

const DIGIT_CONTRACT_TYPES = new Set([
  'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF',
])

const BARRIER_DEFAULTS: Record<string, string> = {
  DIGITOVER:  '5',
  DIGITUNDER: '4',
  DIGITMATCH: '5',
  DIGITDIFF:  '0',
}

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
  DIGITEVEN:  { label: 'Even/Odd',     color: '#22c55e', icon: '⊙', desc: 'Last digit is even' },
  DIGITODD:   { label: 'Even/Odd',     color: '#a855f7', icon: '⊗', desc: 'Last digit is odd'  },
  DIGITOVER:  { label: 'Over/Under',   color: '#3b82f6', icon: '▲', desc: 'Over barrier digit' },
  DIGITUNDER: { label: 'Over/Under',   color: '#f97316', icon: '▼', desc: 'Under barrier digit'},
  DIGITMATCH: { label: 'Match/Differ', color: '#FCA311', icon: '◎', desc: 'Matches digit'      },
  DIGITDIFF:  { label: 'Match/Differ', color: '#14b8a6', icon: '◈', desc: 'Differs from digit' },
}

interface DerivStrategy {
  strategy_id: string
  display_name: string
  description?: string
  parameters: Record<string, any>
  supported_contract_types: string[]
}

function defaultParams(schema: Record<string, any>): Record<string, string> {
  const props = schema?.properties ?? {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(props) as [string, any][]) {
    if      (v.default !== undefined)                          out[k] = String(v.default)
    else if (v.type === 'boolean')                             out[k] = 'false'
    else if (v.type === 'integer' || v.type === 'number')     out[k] = String(v.minimum ?? 1)
    else if (v.enum)                                           out[k] = String(v.enum[0])
    else                                                        out[k] = ''
  }
  return out
}

function lastDigitOf(price: number) {
  return Math.abs(Math.round(price * 1000)) % 10
}

export default function FreeBotsPage() {
  const router = useRouter()
  const [strategies,   setStrategies]   = useState<DerivStrategy[]>([])
  const [strategiesOk, setStrategiesOk] = useState(false)
  const [digitFreq,    setDigitFreq]    = useState<number[]>(Array(10).fill(0))
  const [tickSymbol,   setTickSymbol]   = useState('R_100')
  const [hover,        setHover]        = useState<string | null>(null)
  const [justLoaded,   setJustLoaded]   = useState<string | null>(null)

  const pubWsRef = useRef<WebSocket | null>(null)

  // ── Public WS: fetch strategies + ticks ──────────────────────────────────
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
        }
        if (msg.msg_type === 'history') {
          const prices: (number | string)[] = msg.history?.prices ?? []
          const freq = Array(10).fill(0)
          for (const p of prices) { const d = lastDigitOf(parseFloat(String(p))); if (!isNaN(d)) freq[d]++ }
          setDigitFreq(freq)
        }
        if (msg.msg_type === 'tick') {
          const p = parseFloat(String(msg.tick?.quote ?? 0))
          if (!isNaN(p)) setDigitFreq(prev => { const n = [...prev]; n[lastDigitOf(p)]++; return n })
        }
      }
      ws.onclose = () => { if (!dead) setTimeout(connect, 3000) }
      ws.onerror = () => {}
    }
    connect()
    return () => { dead = true; clearInterval(ping); try { ws?.close() } catch { /**/ } }
  }, [])

  // Sync tick stream when market changes
  useEffect(() => {
    const ws = pubWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'ticks' }))
    ws.send(JSON.stringify({ ticks_history: tickSymbol, count: 100, end: 'latest', style: 'ticks', req_id: 2 }))
    ws.send(JSON.stringify({ ticks: tickSymbol, subscribe: 1, req_id: 3 }))
    setDigitFreq(Array(10).fill(0))
  }, [tickSymbol])

  // ── Load bot into builder ─────────────────────────────────────────────────
  function loadBot(strategy: DerivStrategy, ct: string) {
    const config = {
      strategy_id:   strategy.strategy_id,
      display_name:  strategy.display_name,
      description:   strategy.description,
      contract_type: ct,
      parameters:    strategy.parameters,
      market:        'R_100',
      barrier:       BARRIER_DEFAULTS[ct] ?? '',
      stake:         '1.00',
      params:        defaultParams(strategy.parameters),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(config))
    const key = `${strategy.strategy_id}::${ct}`
    setJustLoaded(key)
    setTimeout(() => router.push('/dashboard/bot-builder'), 300)
  }

  // ── Digit analysis ────────────────────────────────────────────────────────
  const total    = digitFreq.reduce((a, b) => a + b, 0)
  const domDigit = total > 0 ? digitFreq.indexOf(Math.max(...digitFreq)) : null
  const maxFreq  = total > 0 ? Math.max(...digitFreq) : 1

  return (
    <div style={{ minHeight: '100%', background: '#000', color: '#e5e5e5', padding: '1.5rem', fontFamily: 'var(--font-geist-sans, sans-serif)' }}>

      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.35rem', fontWeight: 800, margin: 0 }}>Free Bots</h1>
        <p style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)', margin: '3px 0 0' }}>
          Click any bot to load it into the Bot Builder
        </p>
      </div>

      {/* ── Dominant Digit Panel ─────────────────────────────────────────── */}
      {total > 0 && (
        <div style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'rgba(229,229,229,0.6)' }}>
              Dominant Digit Analysis
              {domDigit !== null && (
                <span style={{ marginLeft: '0.5rem', color: '#FCA311' }}>
                  — Digit <strong>{domDigit}</strong> ({((digitFreq[domDigit] / total) * 100).toFixed(1)}%)
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
              const pct   = total > 0 ? (f / total) * 100 : 0
              const isDom = d === domDigit
              const barH  = maxFreq > 0 ? Math.max(2, Math.round((f / maxFreq) * 38)) : 2
              return (
                <div key={d} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', marginBottom: 3, overflow: 'hidden' }}>
                    <div style={{ width: '70%', background: isDom ? '#FCA311' : 'rgba(255,255,255,0.12)', borderRadius: '3px 3px 0 0', height: barH, transition: 'height 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: isDom ? 800 : 500, color: isDom ? '#FCA311' : 'rgba(229,229,229,0.6)' }}>{d}</div>
                  <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.35)' }}>{pct.toFixed(0)}%</div>
                </div>
              )
            })}
          </div>
          {domDigit !== null && (
            <div style={{ marginTop: '0.6rem', fontSize: '0.72rem', color: 'rgba(229,229,229,0.45)', fontStyle: 'italic' }}>
              💡 Digit {domDigit} is hot — try <strong style={{ color: '#14b8a6' }}>Differs</strong> to bet against it, or <strong style={{ color: '#FCA311' }}>Match</strong> to ride it.
            </div>
          )}
        </div>
      )}

      {/* ── Loading state ─────────────────────────────────────────────────── */}
      {!strategiesOk && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'rgba(229,229,229,0.3)', fontSize: '0.85rem' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem', animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</div>
          <div>Loading strategies from Deriv…</div>
        </div>
      )}

      {strategiesOk && strategies.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'rgba(229,229,229,0.35)', fontSize: '0.85rem' }}>
          No digit strategies available from Deriv right now.
        </div>
      )}

      {/* ── Strategy cards ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {strategies.map(strategy => {
          const digitCTs = strategy.supported_contract_types.filter(ct => DIGIT_CONTRACT_TYPES.has(ct))
          if (!digitCTs.length) return null
          const paramCount = Object.keys(strategy.parameters?.properties ?? {}).length

          return (
            <div key={strategy.strategy_id} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', overflow: 'hidden' }}>
              {/* Strategy header */}
              <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: '3px' }}>{strategy.display_name}</div>
                    {strategy.description && (
                      <div style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.45)', lineHeight: 1.5 }}>{strategy.description}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <div style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.35)', padding: '3px 8px', borderRadius: '999px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {paramCount} param{paramCount !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.35)', padding: '3px 8px', borderRadius: '999px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {digitCTs.length} type{digitCTs.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              </div>

              {/* Contract type bot cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1px', background: 'rgba(255,255,255,0.05)' }}>
                {digitCTs.map(ct => {
                  const meta    = CT_META[ct] ?? { label: ct, color: '#e5e5e5', icon: '◉', desc: '' }
                  const cardKey = `${strategy.strategy_id}::${ct}`
                  const isHover = hover === cardKey
                  const loaded  = justLoaded === cardKey

                  return (
                    <div
                      key={cardKey}
                      onClick={() => loadBot(strategy, ct)}
                      onMouseEnter={() => setHover(cardKey)}
                      onMouseLeave={() => setHover(null)}
                      style={{
                        background:  loaded  ? `${meta.color}18`
                                   : isHover ? `${meta.color}10`
                                   : '#050505',
                        padding: '1rem',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                      }}
                    >
                      {/* Icon + name */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: '9px',
                          background: `${meta.color}18`,
                          border: `1px solid ${isHover || loaded ? meta.color + '66' : meta.color + '33'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.9rem', color: meta.color, flexShrink: 0,
                          transition: 'border-color 0.15s',
                        }}>
                          {meta.icon}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.82rem', color: isHover || loaded ? meta.color : '#e5e5e5', transition: 'color 0.15s' }}>{ct}</div>
                          <div style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.4)' }}>{meta.desc}</div>
                        </div>
                      </div>

                      {/* Load button */}
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        gap: '6px',
                        padding: '7px 12px', borderRadius: '8px',
                        background: loaded ? meta.color
                                  : isHover ? `${meta.color}22`
                                  : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${isHover || loaded ? meta.color + '55' : 'rgba(255,255,255,0.08)'}`,
                        fontSize: '0.78rem', fontWeight: 700,
                        color:  loaded  ? '#000'
                               : isHover ? meta.color
                               : 'rgba(229,229,229,0.5)',
                        transition: 'all 0.15s',
                      }}>
                        {loaded ? '✓ Loading…' : isHover ? '⚙ Load Bot' : '🤖 Load Bot'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
      `}</style>
    </div>
  )
}
