'use client'

/**
 * Lima Trade — Free Bots Page v107
 *
 * Loads available Deriv automation strategies via auto_list_strategies.
 * Clicking a bot saves config to localStorage and navigates to Bot Builder.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const PUB_WS  = 'wss://api.derivws.com/trading/v1/options/ws/public'
const LS_KEY  = 'lima_trade_pending_bot'

interface DerivStrategy {
  strategy_id:   string
  display_name:  string
  description:   string
  contract_type: string[]
  parameters:    Record<string, unknown>[]
}

const CT_LABEL: Record<string, string> = {
  DIGITOVER:  'Over',
  DIGITUNDER: 'Under',
  DIGITMATCH: 'Match',
  DIGITDIFF:  'Differ',
  DIGITEVEN:  'Even',
  DIGITODD:   'Odd',
  CALL:       'Rise',
  PUT:        'Fall',
}

function defaultParams(params: Record<string, unknown>[]) {
  const out: Record<string, string> = {}
  for (const p of params) {
    const key = p.name as string
    out[key] = String(p.default ?? '')
  }
  return out
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

export default function FreeBotsPage() {
  const router = useRouter()
  const [strategies, setStrategies] = useState<DerivStrategy[]>([])
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string|null>(null)
  const [justLoaded, setJustLoaded] = useState<string|null>(null)
  const wsRef = useRef<WebSocket|null>(null)

  // Load strategies from Deriv automation API
  useEffect(() => {
    let alive = true
    const ws = new WebSocket(PUB_WS)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ auto_list_strategies: 1 }))
    }

    ws.onmessage = (e) => {
      if (!alive) return
      try {
        const msg = JSON.parse(e.data)
        if (msg.auto_list_strategies) {
          setStrategies(msg.auto_list_strategies as DerivStrategy[])
          setLoading(false)
        }
        if (msg.error) {
          setErr(msg.error.message ?? 'Failed to load strategies')
          setLoading(false)
        }
      } catch {}
    }

    ws.onerror = () => { if (alive) setErr('Connection error') }
    ws.onclose = () => { if (alive && loading) setErr('Connection closed') }

    return () => { alive = false; ws.close() }
  }, []) // eslint-disable-line

  const loadBot = useCallback((strategy: DerivStrategy, ct: string) => {
    const key = `${strategy.strategy_id}:${ct}`
    const config = {
      strategy_id:   strategy.strategy_id,
      display_name:  strategy.display_name,
      description:   strategy.description,
      contract_type: ct,
      parameters:    strategy.parameters,
      market:        'R_100',
      stake:         '1.00',
      params:        defaultParams(strategy.parameters),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(config))
    setJustLoaded(key)
    setTimeout(() => router.push('/dashboard/bot-builder'), 300)
  }, [router])

  return (
    <div style={{ minHeight: '100vh', background: bg0, fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: txt0, marginBottom: 6 }}>Free Bots</h1>
        <p style={{ fontSize: 13, color: txt1 }}>Click any bot to load it in the Bot Builder</p>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: txt1, fontSize: 13 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: amber, animation: 'pulse 1s infinite' }} />
          Loading strategies from Deriv…
        </div>
      )}

      {err && (
        <div style={{ background: '#3a1a1a', border: `1px solid #f85149`, borderRadius: 8, padding: '12px 16px', color: '#f85149', fontSize: 13 }}>
          {err}
        </div>
      )}

      {!loading && !err && strategies.length === 0 && (
        <div style={{ color: txt2, fontSize: 13 }}>No strategies available.</div>
      )}

      {/* Strategy cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {strategies.map(s => (
          <div key={s.strategy_id} style={{
            background: bg1, border: `1px solid ${bdr}`, borderRadius: 12,
            overflow: 'hidden',
          }}>
            <div style={{ height: 4, background: amber }} />
            <div style={{ padding: '16px 16px 12px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: txt0, marginBottom: 4 }}>{s.display_name}</div>
              <div style={{ fontSize: 12, color: txt1, marginBottom: 12, lineHeight: 1.5 }}>{s.description}</div>

              {/* Contract type buttons */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(s.contract_type ?? []).map(ct => {
                  const key = `${s.strategy_id}:${ct}`
                  const loaded = justLoaded === key
                  return (
                    <button key={ct}
                      onClick={() => loadBot(s, ct)}
                      style={{
                        padding: '5px 12px', fontSize: 11, fontWeight: 700,
                        background: loaded ? amber : bg2,
                        border: `1px solid ${loaded ? amber : bdr}`,
                        borderRadius: 6, cursor: 'pointer',
                        color: loaded ? '#000' : txt0,
                        transition: 'all 0.15s',
                      }}>
                      {loaded ? '✓ Loaded' : (CT_LABEL[ct] ?? ct)}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Digit frequency analysis panel (shown when strategies load) */}
      {!loading && !err && (
        <div style={{
          marginTop: 32, background: bg1, border: `1px solid ${bdr}`,
          borderRadius: 12, padding: '20px', maxWidth: 600,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: txt0, marginBottom: 12 }}>Digit Frequency Analysis</div>
          <p style={{ fontSize: 12, color: txt1, lineHeight: 1.6 }}>
            Use the <span style={{ color: amber }}>Charts tab</span> to view real-time digit frequency for any market before choosing your bot's barrier digit.
          </p>
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  )
}
