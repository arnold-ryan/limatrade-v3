'use client'

import { useState } from 'react'

const QUICK_STAKES = ['5', '10', '25', '50']

const DURATIONS = [
  { label: '1 min',  value: 1,  unit: 'm' },
  { label: '5 min',  value: 5,  unit: 'm' },
  { label: '15 min', value: 15, unit: 'm' },
  { label: '1 hr',   value: 1,  unit: 'h' },
]

const MARKET_LABELS: Record<string, string> = {
  R_10:   'Volatility 10',
  R_25:   'Volatility 25',
  R_50:   'Volatility 50',
  R_75:   'Volatility 75',
  R_100:  'Volatility 100',
  RDBULL: 'Bull Market',
  RDBEAR: 'Bear Market',
}

export default function TradePanel({ market = 'R_10' }: { market?: string }) {
  const [stake,    setStake]    = useState('10')
  const [duration, setDuration] = useState(DURATIONS[0])
  const [notice,   setNotice]   = useState(false)

  const stakeNum = parseFloat(stake) || 0
  // Indicative payout: 90% win probability × 2× stake ≈ 1.8× stake
  // Real payout comes from Deriv proposal API (wired in a future step)
  const payout = (stakeNum * 1.85).toFixed(2)

  const handleBuy = () => setNotice(true)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '1.25rem',
        gap: '1.1rem',
        borderLeft: '1px solid var(--border)',
        background: '#050505',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginBottom: '0.2rem' }}>
          Place Trade
        </h2>
        <p style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.4)' }}>
          Rise / Fall · {MARKET_LABELS[market] ?? market}
        </p>
      </div>

      {/* Stake */}
      <div>
        <label
          style={{
            display: 'block',
            fontSize: '0.72rem',
            fontWeight: 600,
            color: 'rgba(229,229,229,0.5)',
            marginBottom: '0.5rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Stake (USD)
        </label>

        {/* Input row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: '#111',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            padding: '0 0.75rem',
            marginBottom: '0.6rem',
          }}
        >
          <span style={{ color: 'rgba(229,229,229,0.4)', fontSize: '1rem', fontWeight: 600 }}>$</span>
          <input
            type="number"
            value={stake}
            min="1"
            step="1"
            onChange={e => setStake(e.target.value)}
            style={{
              flex: 1,
              padding: '0.75rem 0',
              background: 'transparent',
              border: 'none',
              color: '#fff',
              fontSize: '1.15rem',
              fontWeight: 700,
              outline: 'none',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
        </div>

        {/* Quick-pick buttons */}
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {QUICK_STAKES.map(v => (
            <button
              key={v}
              onClick={() => setStake(v)}
              style={{
                flex: 1,
                padding: '0.45rem 0',
                borderRadius: '7px',
                border: '1px solid',
                cursor: 'pointer',
                fontSize: '0.78rem',
                fontWeight: 600,
                transition: 'all 0.15s',
                borderColor: stake === v ? 'var(--gold)'            : 'var(--border)',
                background:  stake === v ? 'rgba(252,163,17,0.12)'  : '#111',
                color:       stake === v ? 'var(--gold)'            : 'rgba(229,229,229,0.5)',
              }}
            >
              ${v}
            </button>
          ))}
        </div>
      </div>

      {/* Duration */}
      <div>
        <label
          style={{
            display: 'block',
            fontSize: '0.72rem',
            fontWeight: 600,
            color: 'rgba(229,229,229,0.5)',
            marginBottom: '0.5rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Duration
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          {DURATIONS.map(d => (
            <button
              key={d.label}
              onClick={() => setDuration(d)}
              style={{
                padding: '0.65rem',
                borderRadius: '8px',
                border: '1px solid',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 600,
                transition: 'all 0.15s',
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

      {/* Payout summary */}
      <div
        style={{
          padding: '0.9rem 1rem',
          borderRadius: '10px',
          background: 'rgba(252,163,17,0.05)',
          border: '1px solid var(--border)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.5rem',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: 'rgba(229,229,229,0.45)' }}>Stake</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
            ${stakeNum.toFixed(2)}
          </span>
        </div>
        <div
          style={{ height: '1px', background: 'var(--border)', marginBottom: '0.5rem' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', color: 'rgba(229,229,229,0.45)' }}>Est. Payout</span>
          <span style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--gold)' }}>
            ${payout}
          </span>
        </div>
      </div>

      {/* Coming-soon notice */}
      {notice && (
        <div
          style={{
            padding: '0.75rem 1rem',
            borderRadius: '10px',
            background: 'rgba(252,163,17,0.08)',
            border: '1px solid rgba(252,163,17,0.3)',
            fontSize: '0.78rem',
            color: 'var(--gold)',
            lineHeight: 1.5,
          }}
        >
          <strong>Trade execution is coming next.</strong> We are wiring up the Deriv proposal + buy API — stay tuned!
          <button
            onClick={() => setNotice(false)}
            style={{
              float: 'right',
              background: 'none',
              border: 'none',
              color: 'var(--gold)',
              cursor: 'pointer',
              fontSize: '1rem',
              lineHeight: 1,
              marginTop: '-2px',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Buy buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: 'auto' }}>
        {/* Rise */}
        <button
          onClick={handleBuy}
          style={{
            width: '100%',
            padding: '1rem',
            borderRadius: '12px',
            border: 'none',
            background: 'linear-gradient(135deg, #22c55e, #16a34a)',
            color: '#fff',
            fontSize: '0.95rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 4px 20px rgba(34,197,94,0.2)',
            transition: 'opacity 0.15s, transform 0.15s',
          }}
          onMouseOver={e => (e.currentTarget.style.opacity = '0.9')}
          onMouseOut={e  => (e.currentTarget.style.opacity = '1')}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
            Rise
          </span>
          <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>Win ${payout}</span>
        </button>

        {/* Fall */}
        <button
          onClick={handleBuy}
          style={{
            width: '100%',
            padding: '1rem',
            borderRadius: '12px',
            border: 'none',
            background: 'linear-gradient(135deg, #ef4444, #dc2626)',
            color: '#fff',
            fontSize: '0.95rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 4px 20px rgba(239,68,68,0.2)',
            transition: 'opacity 0.15s',
          }}
          onMouseOver={e => (e.currentTarget.style.opacity = '0.9')}
          onMouseOut={e  => (e.currentTarget.style.opacity = '1')}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            Fall
          </span>
          <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>Win ${payout}</span>
        </button>
      </div>

      {/* Risk disclaimer */}
      <p
        style={{
          fontSize: '0.62rem',
          color: 'rgba(229,229,229,0.25)',
          textAlign: 'center',
          lineHeight: 1.5,
        }}
      >
        Trading involves risk. Only trade with funds you can afford to lose.
        <br />Payout shown is indicative and subject to market conditions.
      </p>
    </div>
  )
}
