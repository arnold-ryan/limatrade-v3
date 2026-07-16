'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * TradePanel — Rise/Fall options trading
 *
 * New Deriv API WebSocket flow (2024+):
 *   1. GET /api/user/ws-url → { wsUrl } (server gets OTP from Deriv REST)
 *   2. Connect to wsUrl (authenticated via OTP in URL)
 *   3. Send proposal → get { proposal: { id, ask_price } }
 *   4. Send buy      → get { buy: { contract_id, ... } }
 *
 * WebSocket message format is the same as legacy API.
 * The only difference is how we authenticate the connection (OTP vs authorize msg).
 */

interface ProposalState {
  id:        string
  ask_price: number
  payout:    number
  error?:    string
}

const SYMBOL    = 'R_100'
const DURATION  = 1
const DUR_UNIT  = 't'   // ticks

function formatNum(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

export default function TradePanel() {
  const [stake,        setStake]        = useState('1.00')
  const [callProposal, setCallProposal] = useState<ProposalState | null>(null)
  const [putProposal,  setPutProposal]  = useState<ProposalState | null>(null)
  const [wsReady,      setWsReady]      = useState(false)
  const [wsError,      setWsError]      = useState<string | null>(null)
  const [buying,       setBuying]       = useState<'CALL' | 'PUT' | null>(null)
  const [lastResult,   setLastResult]   = useState<string | null>(null)
  const [reconnectCount, setReconnectCount] = useState(0)

  const wsRef            = useRef<WebSocket | null>(null)
  const reconnectTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalClose = useRef(false)
  const mountedRef       = useRef(true)

  function backoffDelay(attempt: number) {
    return Math.min(2000 * Math.pow(2, attempt), 30_000)
  }

  /* ── Connect to Deriv WS via OTP ────────────────────────────────────────── */
  const connect = useCallback(async (attempt = 0) => {
    if (!mountedRef.current) return
    intentionalClose.current = false

    // Clear any pending reconnect timer
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }

    setWsError(null)
    setWsReady(false)
    setCallProposal(null)
    setPutProposal(null)

    try {
      // Get OTP WebSocket URL from our server (server calls Deriv REST with Bearer token)
      const urlRes = await fetch('/api/user/ws-url')
      if (!urlRes.ok) {
        const err = await urlRes.json().catch(() => ({}))
        throw new Error(err.error ?? `ws-url ${urlRes.status}`)
      }
      const { wsUrl, token } = await urlRes.json() as { wsUrl: string; token: string }
      if (!wsUrl) throw new Error('no_ws_url')

      if (!mountedRef.current) return

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return }
        setReconnectCount(0)
        // Legacy Deriv WS: must authorize before any other calls
        ws.send(JSON.stringify({ authorize: token }))
      }

      ws.onmessage = (e) => {
        if (!mountedRef.current) return
        try {
          const msg = JSON.parse(e.data)

          // Legacy WS: authorize response — now safe to request proposals
          if (msg.authorize) {
            setWsReady(true)
            setWsError(null)
            ws.send(JSON.stringify({
              proposal: 1, subscribe: 1, req_id: 1,
              amount: parseFloat(stake) || 1,
              basis: 'stake',
              contract_type: 'CALL',
              currency: 'USD',
              duration: DURATION,
              duration_unit: DUR_UNIT,
              symbol: SYMBOL,
            }))
            ws.send(JSON.stringify({
              proposal: 1, subscribe: 1, req_id: 2,
              amount: parseFloat(stake) || 1,
              basis: 'stake',
              contract_type: 'PUT',
              currency: 'USD',
              duration: DURATION,
              duration_unit: DUR_UNIT,
              symbol: SYMBOL,
            }))
            return
          }

          if (msg.error) {
            // Session / auth errors — don't reconnect
            const fatal = ['AuthorizationRequired', 'InvalidToken', 'InvalidAppID']
            if (fatal.includes(msg.error.code)) {
              intentionalClose.current = true
              setWsError('Session expired. Please log out and log back in.')
              ws.close()
              return
            }
            if (msg.req_id === 1) setCallProposal({ id: '', ask_price: 0, payout: 0, error: msg.error.message })
            if (msg.req_id === 2) setPutProposal({ id: '', ask_price: 0, payout: 0, error: msg.error.message })
            return
          }

          if (msg.msg_type === 'proposal') {
            const p = msg.proposal
            const state: ProposalState = {
              id:        p.id,
              ask_price: p.ask_price,
              payout:    p.payout,
            }
            if (msg.req_id === 1) setCallProposal(state)
            if (msg.req_id === 2) setPutProposal(state)
          }

          if (msg.msg_type === 'buy') {
            const b = msg.buy
            setLastResult(`✓ Contract opened — ID ${b.contract_id}. Buy price: ${formatNum(b.buy_price)} ${b.currency ?? 'USD'}`)
            setBuying(null)
          }
        } catch { /* ignore parse errors */ }
      }

      ws.onerror = () => {
        if (!mountedRef.current) return
        setWsError('Connection error')
        setWsReady(false)
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        setWsReady(false)
        setCallProposal(null)
        setPutProposal(null)
        setBuying(null)

        if (intentionalClose.current) return

        // Auto-reconnect with exponential backoff
        const delay = backoffDelay(attempt)
        setWsError(`Reconnecting in ${Math.round(delay / 1000)}s…`)
        setReconnectCount(c => c + 1)
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) connect(attempt + 1)
        }, delay)
      }

    } catch (err: any) {
      if (!mountedRef.current) return
      setWsError(err.message ?? 'Connection failed')
      // Retry for transient errors (not auth errors)
      if (!intentionalClose.current) {
        const delay = backoffDelay(attempt)
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) connect(attempt + 1)
        }, delay)
      }
    }
  }, [stake])

  useEffect(() => {
    mountedRef.current = true
    connect(0)
    return () => {
      mountedRef.current = false
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-subscribe proposals when stake changes
  useEffect(() => {
    if (!wsReady || !wsRef.current) return
    const ws = wsRef.current
    const s = parseFloat(stake) || 1
    ws.send(JSON.stringify({ proposal: 1, subscribe: 1, req_id: 1, amount: s, basis: 'stake', contract_type: 'CALL', currency: 'USD', duration: DURATION, duration_unit: DUR_UNIT, underlying_symbol: SYMBOL }))
    ws.send(JSON.stringify({ proposal: 1, subscribe: 1, req_id: 2, amount: s, basis: 'stake', contract_type: 'PUT',  currency: 'USD', duration: DURATION, duration_unit: DUR_UNIT, underlying_symbol: SYMBOL }))
  }, [stake, wsReady])

  /* ── Buy ───────────────────────────────────────────────────────────────── */
  function buyContract(type: 'CALL' | 'PUT') {
    const proposal = type === 'CALL' ? callProposal : putProposal
    if (!proposal?.id || !wsRef.current || !wsReady || buying) return
    setBuying(type)
    setLastResult(null)
    wsRef.current.send(JSON.stringify({
      buy:   proposal.id,
      price: proposal.ask_price * 1.02, // 2% slippage buffer
    }))
  }

  /* ── Render ───────────────────────────────────────────────────────────── */
  const s = parseFloat(stake) || 1

  return (
    <div style={{
      background: '#07111e',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '1.05rem', fontWeight: 700 }}>
            Rise / Fall
          </h2>
          <div style={{ color: '#888', fontSize: '0.75rem', marginTop: '2px' }}>
            Volatility 100 Index · {DURATION}{DUR_UNIT} · Stake basis
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: wsReady ? '#22c55e' : '#888',
            animation: wsReady ? 'pulse 2s ease infinite' : 'none',
          }} />
          <span style={{ color: wsReady ? '#22c55e' : '#888', fontSize: '0.75rem' }}>
            {wsReady ? 'Live' : reconnectCount > 0 ? `Reconnect #${reconnectCount}` : 'Connecting…'}
          </span>
        </div>
      </div>

      {/* WS error banner */}
      {wsError && (
        <div style={{
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          borderRadius: '8px', padding: '10px 14px',
          color: '#fca5a5', fontSize: '0.8rem',
        }}>
          {wsError}
        </div>
      )}

      {/* Stake */}
      <div>
        <label style={{ color: '#888', fontSize: '0.78rem', display: 'block', marginBottom: '6px' }}>
          Stake (USD)
        </label>
        <input
          type="number"
          min="0.35"
          step="0.01"
          value={stake}
          onChange={e => setStake(e.target.value)}
          style={{
            width: '100%', padding: '10px 12px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '8px', color: '#fff',
            fontSize: '1rem', fontWeight: 600,
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Payout preview */}
      {(callProposal || putProposal) && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: '8px', fontSize: '0.78rem',
        }}>
          {[
            { label: 'Rise payout', val: callProposal?.payout },
            { label: 'Fall payout', val: putProposal?.payout },
          ].map(({ label, val }) => (
            <div key={label} style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '8px', padding: '8px 10px',
            }}>
              <div style={{ color: '#888', marginBottom: '2px' }}>{label}</div>
              <div style={{ color: '#FCA311', fontWeight: 600, fontSize: '0.9rem' }}>
                {val ? `USD ${formatNum(val)}` : '—'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Buy buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <button
          onClick={() => buyContract('CALL')}
          disabled={!callProposal?.id || !!buying || !wsReady}
          style={{
            padding: '14px 0', borderRadius: '10px', border: 'none',
            background: !callProposal?.id || buying || !wsReady
              ? 'rgba(34,197,94,0.2)' : 'linear-gradient(135deg, #22c55e, #16a34a)',
            color: '#fff', fontWeight: 700, fontSize: '0.95rem',
            cursor: !callProposal?.id || buying || !wsReady ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {buying === 'CALL' ? '…' : `▲ Rise`}
          {callProposal?.ask_price && !buying ? (
            <div style={{ fontSize: '0.72rem', fontWeight: 400, opacity: 0.8, marginTop: '2px' }}>
              {formatNum(callProposal.ask_price)} USD
            </div>
          ) : null}
        </button>
        <button
          onClick={() => buyContract('PUT')}
          disabled={!putProposal?.id || !!buying || !wsReady}
          style={{
            padding: '14px 0', borderRadius: '10px', border: 'none',
            background: !putProposal?.id || buying || !wsReady
              ? 'rgba(239,68,68,0.2)' : 'linear-gradient(135deg, #ef4444, #dc2626)',
            color: '#fff', fontWeight: 700, fontSize: '0.95rem',
            cursor: !putProposal?.id || buying || !wsReady ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {buying === 'PUT' ? '…' : `▼ Fall`}
          {putProposal?.ask_price && !buying ? (
            <div style={{ fontSize: '0.72rem', fontWeight: 400, opacity: 0.8, marginTop: '2px' }}>
              {formatNum(putProposal.ask_price)} USD
            </div>
          ) : null}
        </button>
      </div>

      {/* Error on proposal */}
      {(callProposal?.error || putProposal?.error) && (
        <div style={{ color: '#f87171', fontSize: '0.78rem' }}>
          {callProposal?.error || putProposal?.error}
        </div>
      )}

      {/* Last trade result */}
      {lastResult && (
        <div style={{
          background: 'rgba(34,197,94,0.08)',
          border: '1px solid rgba(34,197,94,0.2)',
          borderRadius: '8px', padding: '10px 14px',
          color: '#86efac', fontSize: '0.8rem',
        }}>
          {lastResult}
        </div>
      )}

      {/* Disclaimer */}
      <div style={{ color: '#555', fontSize: '0.7rem', lineHeight: 1.4 }}>
        Trading derivatives involves risk. You may lose your entire stake.
        Only trade with money you can afford to lose.
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  )
}
