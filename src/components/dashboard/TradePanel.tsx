'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * TradePanel — Rise/Fall trading using the Deriv WebSocket API
 *
 * API flow:
 *  1. fetch /api/user/token → { token, appId }
 *  2. Open WS: wss://ws.binaryws.com/websockets/v3?app_id={appId}
 *  3. → { authorize: token }               get currency, verify scopes
 *  4. → { proposal: 1, ... CALL, ... }     get Rise payout & proposal id
 *  5. → { proposal: 1, ... PUT,  ... }     get Fall payout & proposal id
 *  6. On Rise click → { buy: callId, price: callAskPrice }
 *     On Fall click → { buy: putId,  price: putAskPrice  }
 *  7. Handle buy response / error
 *
 *  Proposals are re-requested whenever symbol, stake, or duration changes.
 *  Duration units for Deriv: "t"=ticks, "s"=seconds, "m"=minutes, "h"=hours, "d"=days
 */

const QUICK_STAKES = ['1', '5', '10', '25', '50']

const DURATIONS = [
  { label: '1 tick',  value: 1,  unit: 't' },
  { label: '5 min',   value: 5,  unit: 'm' },
  { label: '15 min',  value: 15, unit: 'm' },
  { label: '1 hr',    value: 1,  unit: 'h' },
]

const MARKET_LABELS: Record<string, string> = {
  R_10:     'Volatility 10',
  R_25:     'Volatility 25',
  R_50:     'Volatility 50',
  R_75:     'Volatility 75',
  R_100:    'Volatility 100',
  RDBULL:   'Bull Market',
  RDBEAR:   'Bear Market',
  '1HZ100V':'Vol 100 (1s)',
  '1HZ75V': 'Vol 75 (1s)',
  '1HZ50V': 'Vol 50 (1s)',
  '1HZ25V': 'Vol 25 (1s)',
  '1HZ10V': 'Vol 10 (1s)',
}

interface Proposal {
  id:        string
  ask_price: number
  payout:    number
  longcode:  string
  spot:      number
}

interface TradeResult {
  ok:          boolean
  contract_id?: number
  buy_price?:   number
  payout?:      number
  direction:    'rise' | 'fall'
  error?:       string
}

const REQ_CALL = 1
const REQ_PUT  = 2
const REQ_BUY  = 3

export default function TradePanel({ market = 'R_10' }: { market?: string }) {
  const [stake,        setStake]        = useState('10')
  const [duration,     setDuration]     = useState(DURATIONS[1]) // 5 min default
  const [callProposal, setCallProposal] = useState<Proposal | null>(null)
  const [putProposal,  setPutProposal]  = useState<Proposal | null>(null)
  const [currency,     setCurrency]     = useState('USD')
  const [wsReady,      setWsReady]      = useState(false)
  const [wsError,      setWsError]      = useState<string | null>(null)
  const [buying,       setBuying]       = useState<'rise' | 'fall' | null>(null)
  const [result,       setResult]       = useState<TradeResult | null>(null)

  const wsRef           = useRef<WebSocket | null>(null)
  const marketRef       = useRef(market)
  const stakeRef        = useRef('10')
  const durationRef     = useRef(DURATIONS[1])
  const reconnectCount  = useRef(0)
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalClose = useRef(false)

  // Keep refs in sync
  useEffect(() => { marketRef.current   = market   }, [market])
  useEffect(() => { stakeRef.current    = stake    }, [stake])
  useEffect(() => { durationRef.current = duration }, [duration])

  /* ── Request fresh proposals ── */
  const requestProposals = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    const amount = parseFloat(stakeRef.current) || 1
    const d      = durationRef.current
    const sym    = marketRef.current
    const base   = {
      proposal:      1,
      amount,
      basis:         'stake',
      currency:      currency || 'USD',
      symbol:        sym,
      duration:      d.value,
      duration_unit: d.unit,
    }
    // CALL = Rise
    ws.send(JSON.stringify({ ...base, contract_type: 'CALL', req_id: REQ_CALL }))
    // PUT  = Fall
    ws.send(JSON.stringify({ ...base, contract_type: 'PUT',  req_id: REQ_PUT  }))
  }, [currency])

  /* ── TradePanel WebSocket lifecycle with auto-reconnect ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    intentionalClose.current = false

    function backoffDelay(attempt: number) {
      return Math.min(2000 * Math.pow(2, attempt), 30_000)
    }

    function scheduleReconnect(delay = 2000) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => {
        if (!intentionalClose.current) connect()
      }, delay)
    }

    async function connect() {
      setWsError(null)
      setWsReady(false)

      let token = '', appId = ''
      try {
        const res = await fetch('/api/user/token')
        if (!res.ok) {
          if (res.status === 401) {
            intentionalClose.current = true
            setWsError('Session expired — please log in again')
            return
          }
          setWsError('Failed to connect')
          scheduleReconnect()
          return
        }
        ;({ token, appId } = await res.json() as { token: string; appId: string })
      } catch {
        setWsError('Network error — retrying…')
        scheduleReconnect()
        return
      }

      ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${appId}`)
      wsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0
        setWsError(null)
        ws!.send(JSON.stringify({ authorize: token }))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30_000)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          if (err.code === 'AuthorizationRequired' || err.code === 'InvalidToken') {
            intentionalClose.current = true
            setWsError('Session expired — please log in again')
            ws?.close()
            return
          }
          if ((msg.req_id as number) === REQ_BUY) {
            setBuying(null)
            setResult({ ok: false, direction: 'rise', error: err.message })
          } else {
            setWsError(err.message)
          }
          return
        }

        /* authorize */
        if (msg.msg_type === 'authorize') {
          const auth = msg.authorize as { currency: string; scopes?: string[] }

          /* Scope check */
          const scopes = auth.scopes ?? []
          if (scopes.length > 0 && !scopes.includes('trade')) {
            intentionalClose.current = true
            setWsError('No trading permission. Log out and log in again to grant trade access.')
            ws?.close()
            return
          }

          setCurrency(auth.currency)
          setWsReady(true)
          requestProposals(ws!)
        }

        /* proposal */
        if (msg.msg_type === 'proposal') {
          const p = msg.proposal as {
            id: string; ask_price: number; payout: number; longcode: string; spot: number
          }
          const proposal: Proposal = { id: p.id, ask_price: p.ask_price, payout: p.payout, longcode: p.longcode, spot: p.spot }
          if ((msg.req_id as number) === REQ_CALL) setCallProposal(proposal)
          if ((msg.req_id as number) === REQ_PUT)  setPutProposal(proposal)
        }

        /* buy response */
        if (msg.msg_type === 'buy') {
          const b = msg.buy as { contract_id: number; buy_price: number; payout: number; longcode: string }
          const dir = buying ?? 'rise'
          setBuying(null)
          setResult({ ok: true, direction: dir, contract_id: b.contract_id, buy_price: b.buy_price, payout: b.payout })
          setTimeout(() => requestProposals(ws!), 500)
        }
      }

      ws.onerror = () => { /* onclose handles reconnect */ }
      ws.onclose = () => {
        setWsReady(false)
        setCallProposal(null)
        setPutProposal(null)
        wsRef.current = null
        if (ping) { clearInterval(ping); ping = null }

        if (!intentionalClose.current) {
          const attempt = reconnectCount.current++
          const delay   = backoffDelay(attempt)
          setWsError(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`)
          scheduleReconnect(delay)
        }
      }
    }

    connect()
    return () => {
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (ping) clearInterval(ping)
      ws?.close()
      wsRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Re-request proposals when market, stake, or duration changes */
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && wsReady) {
      // Debounce so rapid stake typing doesn't spam the API
      const id = setTimeout(() => requestProposals(wsRef.current!), 400)
      return () => clearTimeout(id)
    }
  }, [market, stake, duration, wsReady, requestProposals])

  /* ── Buy handler ── */
  function handleBuy(direction: 'rise' | 'fall') {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const proposal = direction === 'rise' ? callProposal : putProposal
    if (!proposal) return

    setBuying(direction)
    setResult(null)

    /*
     * Deriv buy API:
     * { buy: <proposal_id>, price: <max_price_willing_to_pay> }
     * price = ask_price to execute at the exact quoted price.
     * Setting slightly higher (ask_price * 1.02) adds a tiny slippage buffer.
     */
    ws.send(JSON.stringify({
      buy:     proposal.id,
      price:   parseFloat((proposal.ask_price * 1.02).toFixed(2)),
      req_id:  REQ_BUY,
    }))
  }

  const stakeNum  = parseFloat(stake) || 0
  const callPayout = callProposal?.payout ?? 0
  const putPayout  = putProposal?.payout  ?? 0

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      padding: '1.25rem', gap: '1rem',
      borderLeft: '1px solid var(--border)',
      background: '#050505', overflowY: 'auto',
    }}>

      {/* ── Header ── */}
      <div>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginBottom: '0.2rem' }}>
          Place Trade
        </h2>
        <p style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.4)' }}>
          Rise / Fall · {MARKET_LABELS[market] ?? market}
        </p>
      </div>

      {/* ── Connection status ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.4rem 0.65rem',
        borderRadius: '8px',
        background: wsError
          ? 'rgba(239,68,68,0.08)'
          : wsReady
          ? 'rgba(34,197,94,0.06)'
          : 'rgba(252,163,17,0.06)',
        border: `1px solid ${wsError ? 'rgba(239,68,68,0.2)' : wsReady ? 'rgba(34,197,94,0.15)' : 'rgba(252,163,17,0.15)'}`,
      }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: wsError ? '#ef4444' : wsReady ? '#22c55e' : '#FCA311',
          boxShadow: wsReady && !wsError ? '0 0 5px #22c55e' : 'none',
          flexShrink: 0,
        }}/>
        <span style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.55)' }}>
          {wsError ?? (wsReady ? `Connected · ${currency}` : 'Connecting…')}
        </span>
      </div>

      {/* ── Stake ── */}
      <div>
        <label style={{
          display: 'block', fontSize: '0.72rem', fontWeight: 600,
          color: 'rgba(229,229,229,0.5)', marginBottom: '0.5rem',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Stake ({currency})
        </label>

        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          background: '#111', border: '1px solid var(--border)',
          borderRadius: '10px', padding: '0 0.75rem', marginBottom: '0.6rem',
        }}>
          <span style={{ color: 'rgba(229,229,229,0.4)', fontSize: '1rem', fontWeight: 600 }}>$</span>
          <input
            type="number"
            value={stake}
            min="0.35"
            step="0.01"
            onChange={e => setStake(e.target.value)}
            style={{
              flex: 1, padding: '0.75rem 0',
              background: 'transparent', border: 'none',
              color: '#fff', fontSize: '1.15rem', fontWeight: 700, outline: 'none',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {QUICK_STAKES.map(v => (
            <button
              key={v}
              onClick={() => setStake(v)}
              style={{
                flex: 1, padding: '0.45rem 0',
                borderRadius: '7px', border: '1px solid', cursor: 'pointer',
                fontSize: '0.78rem', fontWeight: 600, transition: 'all 0.15s',
                borderColor: stake === v ? 'var(--gold)'           : 'var(--border)',
                background:  stake === v ? 'rgba(252,163,17,0.12)' : '#111',
                color:       stake === v ? 'var(--gold)'           : 'rgba(229,229,229,0.5)',
              }}
            >
              ${v}
            </button>
          ))}
        </div>
      </div>

      {/* ── Duration ── */}
      <div>
        <label style={{
          display: 'block', fontSize: '0.72rem', fontWeight: 600,
          color: 'rgba(229,229,229,0.5)', marginBottom: '0.5rem',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Duration
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          {DURATIONS.map(d => (
            <button
              key={d.label}
              onClick={() => setDuration(d)}
              style={{
                padding: '0.65rem', borderRadius: '8px',
                border: '1px solid', cursor: 'pointer',
                fontSize: '0.8rem', fontWeight: 600, transition: 'all 0.15s',
                borderColor: duration.label === d.label ? 'var(--gold)'           : 'var(--border)',
                background:  duration.label === d.label ? 'rgba(252,163,17,0.12)' : '#111',
                color:       duration.label === d.label ? 'var(--gold)'           : 'rgba(229,229,229,0.5)',
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Payout summary (from real Deriv proposal) ── */}
      <div style={{
        padding: '0.9rem 1rem', borderRadius: '10px',
        background: 'rgba(252,163,17,0.05)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'rgba(229,229,229,0.45)' }}>Stake</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>${stakeNum.toFixed(2)}</span>
        </div>
        <div style={{ height: '1px', background: 'var(--border)', marginBottom: '0.5rem' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.75rem', color: 'rgba(229,229,229,0.45)' }}>
            {wsReady && (callProposal || putProposal) ? 'Actual Payout' : 'Est. Payout'}
          </span>
          <span style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--gold)' }}>
            {wsReady && callProposal
              ? `$${callPayout.toFixed(2)}`
              : `~$${(stakeNum * 1.85).toFixed(2)}`}
          </span>
        </div>
        {callProposal && (
          <div style={{
            marginTop: '0.5rem', fontSize: '0.62rem',
            color: 'rgba(229,229,229,0.3)', lineHeight: 1.4,
          }}>
            {callProposal.longcode}
          </div>
        )}
      </div>

      {/* ── Trade result toast ── */}
      {result && (
        <div style={{
          padding: '0.75rem 1rem', borderRadius: '10px',
          background: result.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
          border: `1px solid ${result.ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
        }}>
          {result.ok ? (
            <>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#22c55e', marginBottom: '0.3rem' }}>
                Trade placed ✓
              </div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.6)', lineHeight: 1.5 }}>
                Contract #{result.contract_id}<br/>
                Stake: ${result.buy_price?.toFixed(2)} · Potential win: ${result.payout?.toFixed(2)}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#ef4444', marginBottom: '0.3rem' }}>
                Trade failed
              </div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.6)' }}>
                {result.error}
              </div>
            </>
          )}
          <button
            onClick={() => setResult(null)}
            style={{
              float: 'right', marginTop: '-1.5rem',
              background: 'none', border: 'none',
              color: 'rgba(229,229,229,0.4)', cursor: 'pointer', fontSize: '1.1rem',
            }}
          >×</button>
        </div>
      )}

      {/* ── Rise / Fall buttons ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: 'auto' }}>
        {/* Rise = CALL */}
        <button
          onClick={() => handleBuy('rise')}
          disabled={!wsReady || !callProposal || buying !== null}
          style={{
            width: '100%', padding: '1rem', borderRadius: '12px', border: 'none',
            background: !wsReady || buying !== null ? '#1a2a1a' : 'linear-gradient(135deg, #22c55e, #16a34a)',
            color: !wsReady || buying !== null ? 'rgba(255,255,255,0.3)' : '#fff',
            fontSize: '0.95rem', fontWeight: 700, cursor: wsReady && buying === null ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            boxShadow: wsReady ? '0 4px 20px rgba(34,197,94,0.2)' : 'none',
            transition: 'opacity 0.15s',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {buying === 'rise' ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="7" cy="7" r="5" strokeDasharray="25" strokeDashoffset="0"
                  style={{ animation: 'spin 0.8s linear infinite', transformOrigin: '7px 7px' }}/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            )}
            {buying === 'rise' ? 'Placing…' : 'Rise'}
          </span>
          <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>
            Win ${callPayout > 0 ? callPayout.toFixed(2) : (stakeNum * 1.85).toFixed(2)}
          </span>
        </button>

        {/* Fall = PUT */}
        <button
          onClick={() => handleBuy('fall')}
          disabled={!wsReady || !putProposal || buying !== null}
          style={{
            width: '100%', padding: '1rem', borderRadius: '12px', border: 'none',
            background: !wsReady || buying !== null ? '#2a1a1a' : 'linear-gradient(135deg, #ef4444, #dc2626)',
            color: !wsReady || buying !== null ? 'rgba(255,255,255,0.3)' : '#fff',
            fontSize: '0.95rem', fontWeight: 700, cursor: wsReady && buying === null ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            boxShadow: wsReady ? '0 4px 20px rgba(239,68,68,0.2)' : 'none',
            transition: 'opacity 0.15s',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {buying === 'fall' ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="7" cy="7" r="5" strokeDasharray="25" strokeDashoffset="0"
                  style={{ animation: 'spin 0.8s linear infinite', transformOrigin: '7px 7px' }}/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            )}
            {buying === 'fall' ? 'Placing…' : 'Fall'}
          </span>
          <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>
            Win ${putPayout > 0 ? putPayout.toFixed(2) : (stakeNum * 1.85).toFixed(2)}
          </span>
        </button>
      </div>

      {/* ── Risk disclaimer ── */}
      <p style={{
        fontSize: '0.62rem', color: 'rgba(229,229,229,0.22)',
        textAlign: 'center', lineHeight: 1.5,
      }}>
        Trading involves risk. Only trade with funds you can afford to lose.
        Payout shown is the real Deriv API quote and updates with market conditions.
      </p>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
