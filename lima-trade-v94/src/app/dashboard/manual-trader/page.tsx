'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL  = 'wss://api.derivws.com/trading/v1/options/ws/public'
const MAX_HISTORY    = 5000
const MAX_RECONNECT  = 5

const MARKETS = [
  { symbol: '1HZ100V',   label: 'Volatility 100 (1s) Index' },
  { symbol: '1HZ10V',    label: 'Volatility 10 (1s) Index'  },
  { symbol: '1HZ25V',    label: 'Volatility 25 (1s) Index'  },
  { symbol: '1HZ50V',    label: 'Volatility 50 (1s) Index'  },
  { symbol: '1HZ75V',    label: 'Volatility 75 (1s) Index'  },
  { symbol: 'BOOM1000',  label: 'Boom 1000 Index'           },
  { symbol: 'BOOM500',   label: 'Boom 500 Index'            },
  { symbol: 'CRASH1000', label: 'Crash 1000 Index'          },
  { symbol: 'CRASH500',  label: 'Crash 500 Index'           },
  { symbol: 'JD10',      label: 'Jump 10 Index'             },
  { symbol: 'JD25',      label: 'Jump 25 Index'             },
  { symbol: 'JD50',      label: 'Jump 50 Index'             },
  { symbol: 'JD75',      label: 'Jump 75 Index'             },
  { symbol: 'JD100',     label: 'Jump 100 Index'            },
  { symbol: 'R_10',      label: 'Volatility 10 Index'       },
  { symbol: 'R_25',      label: 'Volatility 25 Index'       },
  { symbol: 'R_50',      label: 'Volatility 50 Index'       },
  { symbol: 'R_75',      label: 'Volatility 75 Index'       },
  { symbol: 'R_100',     label: 'Volatility 100 Index'      },
  { symbol: 'stpRNG',    label: 'Step Index'                },
]

// req_id → contract_type routing for proposal responses
const REQ_TO_CT: Record<number, string> = {
  10: 'DIGITOVER', 11: 'DIGITUNDER',
  20: 'DIGITMATCH', 21: 'DIGITDIFF',
  30: 'DIGITEVEN',  31: 'DIGITODD',
  40: 'CALL',       41: 'PUT',
}

const CT_LABELS: Record<string, string> = {
  DIGITOVER: 'Over', DIGITUNDER: 'Under',
  DIGITMATCH: 'Match', DIGITDIFF: 'Differ',
  DIGITEVEN: 'Even', DIGITODD: 'Odd',
  CALL: 'Rise', PUT: 'Fall',
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function getLastDigit(price: number, pipSize = 2): number {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}

function trailingStreak(arr: string[]): { count: number; val: string } {
  if (!arr.length) return { count: 0, val: '' }
  const val = arr[arr.length - 1]
  let count = 0
  for (let i = arr.length - 1; i >= 0 && arr[i] === val; i--) count++
  return { count, val }
}

function fmt2(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTime(epoch: number) {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface Prop { id: string; ask_price: number; payout: number; error?: string }
type Props = Record<string, Prop | null>

interface OpenPos {
  contract_id: number; contract_type: string; underlying: string
  buy_price: number; profit: number; status: string
  is_sold: number; is_valid_to_sell: number
  currency: string; purchase_time: number; longcode: string; settling?: boolean
}

interface HistRow {
  contract_id: number; contract_type: string
  buy_price: number; sell_price: number; purchase_time: number
}

type SeqColor = { bg: string; border: string; text: string }

/* ─── Color maps ─────────────────────────────────────────────────────────── */
const OU_COLORS: Record<string, SeqColor> = {
  O: { bg: 'rgba(34,197,94,0.15)',  border: '#22c55e', text: '#22c55e' },
  U: { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#3b82f6' },
}
const MD_COLORS: Record<string, SeqColor> = {
  M: { bg: 'rgba(239,68,68,0.15)',  border: '#ef4444', text: '#ef4444' },
  D: { bg: 'rgba(168,85,247,0.15)', border: '#a855f7', text: '#a855f7' },
}
const EO_COLORS: Record<string, SeqColor> = {
  E: { bg: 'rgba(252,163,17,0.15)', border: '#FCA311',  text: '#FCA311'  },
  O: { bg: 'rgba(99,102,241,0.15)', border: '#6366f1',  text: '#6366f1'  },
}
const RF_COLORS: Record<string, SeqColor> = {
  R: { bg: 'rgba(34,197,94,0.15)',  border: '#22c55e', text: '#22c55e' },
  F: { bg: 'rgba(239,68,68,0.15)', border: '#ef4444', text: '#ef4444' },
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */
function Bar({ label, color, count, total }: {
  label: string; color: string; count: number; total: number
}) {
  const pct = total ? (count / total) * 100 : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
      <span style={{ width: '44px', fontSize: '0.72rem', fontWeight: 600, color, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '99px', transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ width: '42px', fontSize: '0.72rem', fontWeight: 600, color: 'rgba(229,229,229,0.7)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}

function Sequence({ seq, colorMap, rawDigits }: {
  seq: string[]; colorMap: Record<string, SeqColor>; rawDigits?: number[]
}) {
  // Show only last 15 — single row, no wrap (matches Analysis Tool style)
  const recent = seq.slice(-15)
  const recentRaw = rawDigits ? rawDigits.slice(-15) : undefined
  return (
    <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.75rem', overflow: 'hidden', justifyContent: 'center' }}>
      {recent.map((s, i) => {
        const c = colorMap[s] ?? { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', text: '#aaa' }
        const isLast = i === recent.length - 1
        const display = recentRaw != null ? String(recentRaw[i] ?? s) : s
        return (
          <div key={i} style={{
            width: '26px', height: '26px', borderRadius: '6px', flexShrink: 0,
            fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isLast ? c.bg.replace('0.15', '0.28') : c.bg,
            border: `1.5px solid ${isLast ? c.border : c.border + '80'}`,
            color: c.text,
            transform: isLast ? 'scale(1.12)' : 'scale(1)',
            transition: 'transform 0.1s',
          }}>{display}</div>
        )
      })}
    </div>
  )
}

function DigitPicker({ selected, onSelect }: { selected: number; onSelect: (d: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.7rem', justifyContent: 'center' }}>
      {[0,1,2,3,4,5,6,7,8,9].map(d => (
        <button key={d} onClick={() => onSelect(d)} style={{
          width: '27px', height: '27px', borderRadius: '50%',
          fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer',
          border: `1.5px solid ${selected === d ? 'var(--gold)' : 'rgba(255,255,255,0.14)'}`,
          background: selected === d ? 'rgba(252,163,17,0.18)' : 'transparent',
          color: selected === d ? 'var(--gold)' : 'rgba(229,229,229,0.55)',
          transition: 'all 0.15s',
        }}>{d}</button>
      ))}
    </div>
  )
}

/* ─── TradeControls — buy section at bottom of each card ────────────────── */
function TradeControls({
  labelA, labelB, colorA, colorB,
  propA, propB, buyingA, buyingB,
  wsReady, currency,
  stake, onStakeChange,
  duration, onDurationChange,
  durUnit, onDurUnitChange, showDurUnit,
  onBuyA, onBuyB,
  showDigitPicker, selectedDigit, onDigitSelect, digitLabel,
}: {
  labelA: string; labelB: string; colorA: string; colorB: string
  propA: Prop | null; propB: Prop | null
  buyingA: boolean; buyingB: boolean
  wsReady: boolean; currency: string
  stake: string; onStakeChange: (v: string) => void
  duration: number; onDurationChange: (v: number) => void
  durUnit: string; onDurUnitChange: (v: string) => void; showDurUnit: boolean
  onBuyA: () => void; onBuyB: () => void
  showDigitPicker?: boolean; selectedDigit?: number
  onDigitSelect?: (d: number) => void; digitLabel?: string
}) {
  const inp: React.CSSProperties = {
    background: '#0a0f1a', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px', color: '#fff', fontSize: '0.78rem',
    padding: '0.3rem 0.45rem', outline: 'none', boxSizing: 'border-box',
  }
  const busy = buyingA || buyingB
  const canA = !!propA?.id && !propA.error && !busy && wsReady
  const canB = !!propB?.id && !propB.error && !busy && wsReady

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', marginTop: '0.8rem', paddingTop: '0.8rem' }}>

      {/* Stake + Digit (optional) + Duration — all in one row */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.57rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>
            Stake ({currency})
          </div>
          <input type="number" min="0.35" step="0.01" value={stake}
            onChange={e => onStakeChange(e.target.value)}
            style={{ ...inp, width: '100%' }} />
        </div>

        {/* Inline digit dropdown — only for OU / MD */}
        {showDigitPicker && selectedDigit !== undefined && onDigitSelect && (
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.57rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>
              {digitLabel ?? 'Digit'}
            </div>
            <select
              value={selectedDigit}
              onChange={e => onDigitSelect(parseInt(e.target.value))}
              style={{ ...inp, width: '100%', cursor: 'pointer' }}
            >
              {[0,1,2,3,4,5,6,7,8,9].map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.57rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>
            Duration
          </div>
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <input type="number" min="1" max={!showDurUnit || durUnit === 't' ? 10 : 60} value={duration}
              onChange={e => onDurationChange(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ ...inp, flex: 1, minWidth: 0 }} />
            {showDurUnit ? (
              <select value={durUnit} onChange={e => onDurUnitChange(e.target.value)}
                style={{ ...inp, width: '50px', cursor: 'pointer' }}>
                <option value="t">T</option>
                <option value="m">M</option>
                <option value="h">H</option>
              </select>
            ) : (
              <span style={{ ...inp, width: '50px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(229,229,229,0.3)', fontSize: '0.65rem' }}>
                Ticks
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Proposal quotes preview */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '0.55rem' }}>
        {[
          { label: labelA, prop: propA, color: colorA },
          { label: labelB, prop: propB, color: colorB },
        ].map(({ label, prop, color }) => (
          <div key={label} style={{
            background: 'rgba(255,255,255,0.03)', borderRadius: '6px',
            padding: '0.28rem 0.5rem', textAlign: 'center',
            border: '1px solid rgba(255,255,255,0.05)',
          }}>
            <div style={{ fontSize: '0.56rem', color: 'rgba(229,229,229,0.3)', marginBottom: '1px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
            {prop?.error ? (
              <div style={{ fontSize: '0.58rem', color: '#ef4444', lineHeight: 1.2 }}>{prop.error.slice(0, 28)}</div>
            ) : prop?.ask_price ? (
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
                {fmt2(prop.ask_price)} · {fmt2(prop.payout)}
              </div>
            ) : (
              <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.18)' }}>—</div>
            )}
          </div>
        ))}
      </div>

      {/* Buy buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        {[
          { label: labelA, color: colorA, can: canA, isBuying: buyingA, onBuy: onBuyA },
          { label: labelB, color: colorB, can: canB, isBuying: buyingB, onBuy: onBuyB },
        ].map(({ label, color, can, isBuying, onBuy }) => (
          <button key={label} onClick={onBuy} disabled={!can} style={{
            padding: '0.58rem 0.4rem', borderRadius: '8px', border: 'none',
            fontWeight: 800, fontSize: '0.78rem', letterSpacing: '0.02em',
            cursor: can ? 'pointer' : 'not-allowed', transition: 'all 0.15s',
            background: can ? color : `${color}22`,
            color: can ? '#fff' : `${color}55`,
          }}>
            {isBuying ? '…' : `Buy ${label}`}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ─── Card wrapper ───────────────────────────────────────────────────────── */
function Card({ title, streakCount, streakLabel, children }: {
  title: string; streakCount: number; streakLabel: string; children: React.ReactNode
}) {
  return (
    <div style={{ background: '#050505', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.9rem' }}>
        <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {title}
        </span>
        {streakCount > 0 && (
          <span style={{
            fontSize: '0.68rem', fontWeight: 700, color: 'var(--gold)',
            background: 'rgba(252,163,17,0.1)', padding: '0.15rem 0.55rem',
            borderRadius: '20px', border: '1px solid rgba(252,163,17,0.3)',
          }}>
            {streakCount}x {streakLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

/* ─── Positions Panel (slides in from right) ─────────────────────────────── */
function PositionsPanel({
  open, onClose, openPositions, history, currency,
  onSell, onClearHistory,
}: {
  open: boolean; onClose: () => void
  openPositions: Map<number, OpenPos>; history: HistRow[]
  currency: string
  onSell: (id: number) => void
  onClearHistory: () => void
}) {
  const [tab, setTab] = useState<'positions' | 'history'>('positions')
  const openList  = Array.from(openPositions.values())
  const totalPL   = openList.reduce((s, p) => s + p.profit, 0)
  const historyPL = history.reduce((s, r) => s + (r.sell_price - r.buy_price), 0)

  return (
    <div style={{
      position: 'fixed', top: '100px', right: 0, bottom: 0,
      width: open ? '300px' : '0',
      background: '#070f1e',
      borderLeft: open ? '1px solid rgba(255,255,255,0.08)' : 'none',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      transition: 'width 0.28s cubic-bezier(0.4,0,0.2,1)',
      zIndex: 40,
    }}>
      <div style={{ minWidth: '300px', display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* Header */}
        <div style={{ padding: '1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#fff' }}>Positions</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {openList.length > 0 && (
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: totalPL >= 0 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                  {totalPL >= 0 ? '+' : ''}{fmt2(totalPL)} {currency}
                </span>
              )}
              <button onClick={onClose} style={{
                background: 'none', border: 'none', color: 'rgba(229,229,229,0.4)',
                cursor: 'pointer', fontSize: '1rem', lineHeight: 1,
              }}>✕</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {(['positions', 'history'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                flex: 1, padding: '0.35rem', borderRadius: '6px', border: 'none',
                background: tab === t ? 'rgba(252,163,17,0.12)' : 'rgba(255,255,255,0.04)',
                color: tab === t ? 'var(--gold)' : 'rgba(229,229,229,0.4)',
                fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize',
              }}>
                {t}{t === 'positions' && openList.length > 0 ? ` (${openList.length})` : ''}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>

          {tab === 'positions' && (
            openList.length === 0 ? (
              <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'rgba(229,229,229,0.22)', fontSize: '0.75rem' }}>
                No open positions.
              </div>
            ) : (
              openList.map(pos => {
                const settled = pos.is_sold === 1
                const won = pos.status === 'won'
                const pl  = pos.profit
                return (
                  <div key={pos.contract_id} style={{
                    padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: settled ? (won ? 'rgba(34,197,94,0.04)' : 'rgba(239,68,68,0.04)') : 'transparent',
                    transition: 'background 0.3s',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                      <div>
                        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#fff' }}>
                          {CT_LABELS[pos.contract_type] ?? pos.contract_type}
                        </span>
                        <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.35)', marginLeft: '6px' }}>
                          {pos.underlying.replace('_', ' ')}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: settled ? (won ? '#22c55e' : '#ef4444') : pl >= 0 ? '#22c55e' : '#ef4444' }}>
                        {pl >= 0 ? '+' : ''}{fmt2(pl)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.3)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtTime(pos.purchase_time)} · {fmt2(pos.buy_price)} {pos.currency}
                      </span>
                      {!settled && pos.is_valid_to_sell === 1 ? (
                        <button onClick={() => onSell(pos.contract_id)} style={{
                          padding: '0.18rem 0.55rem', borderRadius: '5px',
                          border: '1px solid rgba(239,68,68,0.3)',
                          background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                          fontSize: '0.62rem', fontWeight: 700, cursor: 'pointer',
                        }}>Sell</button>
                      ) : (
                        <span style={{ fontSize: '0.6rem', fontWeight: 600, color: settled ? (won ? '#22c55e' : '#ef4444') : 'rgba(229,229,229,0.2)' }}>
                          {settled ? (won ? '✓ Won' : '✗ Lost') : 'Running…'}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )
          )}

          {tab === 'history' && (
            history.length === 0 ? (
              <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'rgba(229,229,229,0.22)', fontSize: '0.75rem', flex: 1 }}>No trades yet.<br /><span style={{ fontSize: '0.65rem', opacity: 0.6 }}>Trades placed here will appear after settlement.</span></div>
            ) : (
              <>
                {/* Scrollable list */}
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 1rem 0.25rem', position: 'sticky', top: 0, background: '#070f1e', zIndex: 1 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 48px 52px 58px', flex: 1 }}>
                      {['Time','Type','Stake','P/L'].map(h => (
                        <span key={h} style={{ fontSize: '0.57rem', fontWeight: 700, color: 'rgba(229,229,229,0.28)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</span>
                      ))}
                    </div>
                    <button onClick={onClearHistory} style={{
                      marginLeft: '0.5rem', padding: '0.18rem 0.5rem', borderRadius: '5px', flexShrink: 0,
                      border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.07)',
                      color: '#ef4444', fontSize: '0.6rem', fontWeight: 700, cursor: 'pointer',
                    }}>Reset</button>
                  </div>
                  {history.map(row => {
                    const pl  = row.sell_price - row.buy_price
                    const won = pl > 0
                    return (
                      <div key={row.contract_id} style={{ display: 'grid', gridTemplateColumns: '1fr 48px 52px 58px', alignItems: 'center', padding: '0.45rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)', width: '100%' }}>
                        <span style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.35)', fontVariantNumeric: 'tabular-nums' }}>
                          {row.purchase_time ? fmtTime(row.purchase_time) : '—'}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: won ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
                          <span style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.5)' }}>{CT_LABELS[row.contract_type] ?? row.contract_type}</span>
                        </div>
                        <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.5)', fontVariantNumeric: 'tabular-nums' }}>{fmt2(row.buy_price)}</span>
                        <span style={{ fontSize: '0.62rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: won ? '#22c55e' : '#ef4444' }}>
                          {won ? '+' : ''}{fmt2(pl)}
                        </span>
                      </div>
                    )
                  })}
                </div>
                {/* P/L footer */}
                <div style={{
                  flexShrink: 0, padding: '0.75rem 1rem',
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  background: '#070f1e',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>
                      Total P/L ({history.length} trades)
                    </div>
                    <div style={{ fontSize: '1rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: historyPL >= 0 ? '#22c55e' : '#ef4444' }}>
                      {historyPL >= 0 ? '+' : ''}{fmt2(historyPL)} {currency}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Win Rate</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'rgba(229,229,229,0.75)' }}>
                      {history.length > 0 ? ((history.filter(r => r.sell_price > r.buy_price).length / history.length) * 100).toFixed(0) : '0'}%
                    </div>
                  </div>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export default function ManualTraderPage() {

  /* ── Tick / analysis state ── */
  const [symbol,    setSymbol]    = useState('1HZ100V')
  const [tickCount, setTickCount] = useState(1000)
  const [prices,    setPrices]    = useState<number[]>([])
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [loading,   setLoading]   = useState(true)

  /* ── Barrier config ── */
  /* ── Analysis digit (circles at card top — purely visual, does not affect trades) ── */
  const [ouAnalysisDigit, setOuAnalysisDigit] = useState(5)
  const [mdAnalysisDigit, setMdAnalysisDigit] = useState(5)

  /* ── Trade barrier (dropdown in TradeControls — drives proposals) ── */
  const [ouBarrier, setOuBarrier] = useState(5)
  const [mdDigit,   setMdDigit]   = useState(5)

  /* ── Per-card trade config ── */
  const [stakeOU, setStakeOU] = useState('1.00')
  const [stakeMD, setStakeMD] = useState('1.00')
  const [stakeEO, setStakeEO] = useState('1.00')
  const [stakeRF, setStakeRF] = useState('1.00')

  const [durOU, setDurOU] = useState(1)
  const [durMD, setDurMD] = useState(1)
  const [durEO, setDurEO] = useState(1)
  const [durRF, setDurRF] = useState(1)
  const [durUnitRF, setDurUnitRF] = useState<'t'|'m'|'h'>('t')

  /* ── Auth WS state ── */
  const [wsReady,      setWsReady]      = useState(false)
  const [wsError,      setWsError]      = useState<string | null>(null)
  const [currency,     setCurrency]     = useState('USD')
  const [accountLabel, setAccountLabel] = useState('')

  /* ── Proposals & buying ── */
  const [proposals, setProposals] = useState<Props>({})
  const [buying,    setBuying]    = useState<Record<string, boolean>>({})

  /* ── Portfolio ── */
  const [openPositions, setOpenPositions] = useState<Map<number, OpenPos>>(new Map())
  const [history,       setHistory]       = useState<HistRow[]>([])

  /* ── UI ── */
  const [panelOpen, setPanelOpen] = useState(true)

  /* ── Toast notifications ── */
  interface Toast { id: number; type: 'success' | 'error'; msg: string }
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastIdRef = useRef(0)
  const addToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { ...t, id }])
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 3500)
  }, [])

  /* ── Refs ── */
  const botWsRef              = useRef<WebSocket | null>(null)
  const pipSizeRef            = useRef(2)
  const reqIdRef              = useRef(500)
  const buyReqToCtRef         = useRef<Map<number, string>>(new Map())
  const manualTraderBoughtIds = useRef<Set<number>>(new Set())
  const reconnectCount        = useRef(0)
  const reconnectTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalClose = useRef(false)

  // Stable refs for WS callbacks (avoid stale closure)
  const symbolRef     = useRef(symbol)
  const currencyRef   = useRef('USD')
  const ouBarrierRef  = useRef(5)
  const mdDigitRef    = useRef(5)
  const stakeOURef    = useRef('1.00')
  const stakeMDRef    = useRef('1.00')
  const stakeEORef    = useRef('1.00')
  const stakeRFRef    = useRef('1.00')
  const durOURef      = useRef(1)
  const durMDRef      = useRef(1)
  const durEORef      = useRef(1)
  const durRFRef      = useRef(1)
  const durUnitRFRef  = useRef<'t'|'m'|'h'>('t')

  useEffect(() => { symbolRef.current    = symbol    }, [symbol])
  useEffect(() => { currencyRef.current  = currency  }, [currency])
  useEffect(() => { ouBarrierRef.current = ouBarrier }, [ouBarrier])
  useEffect(() => { mdDigitRef.current   = mdDigit   }, [mdDigit])
  useEffect(() => { stakeOURef.current   = stakeOU   }, [stakeOU])
  useEffect(() => { stakeMDRef.current   = stakeMD   }, [stakeMD])
  useEffect(() => { stakeEORef.current   = stakeEO   }, [stakeEO])
  useEffect(() => { stakeRFRef.current   = stakeRF   }, [stakeRF])
  useEffect(() => { durOURef.current     = durOU     }, [durOU])
  useEffect(() => { durMDRef.current     = durMD     }, [durMD])
  useEffect(() => { durEORef.current     = durEO     }, [durEO])
  useEffect(() => { durRFRef.current     = durRF     }, [durRF])
  useEffect(() => { durUnitRFRef.current = durUnitRF }, [durUnitRF])

  /* ── Public WS — live ticks ── */
  useEffect(() => {
    setLoading(true)
    setPrices([])
    setLivePrice(null)

    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol, end: 'latest', start: 1,
        count: MAX_HISTORY, style: 'ticks', subscribe: 1,
      }))
    }
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }
      if (msg.msg_type === 'history') {
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps != null) pipSizeRef.current = ps
        const hist = (msg as { history: { prices: number[] } }).history.prices.map(Number)
        setPrices(hist)
        setLivePrice(hist[hist.length - 1] ?? null)
        setLoading(false)
      }
      if (msg.msg_type === 'tick') {
        const td = (msg as { tick: { quote: number; pip_size: number } }).tick
        if (td.pip_size != null) pipSizeRef.current = td.pip_size
        const q = td.quote
        setLivePrice(q)
        setPrices(prev => { const n = [...prev, q]; return n.length > MAX_HISTORY ? n.slice(-MAX_HISTORY) : n })
      }
    }
    ws.onerror = () => setLoading(false)
    ws.onclose = () => {}
    return () => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 9999 })) } catch { /**/ }
      ws.close()
    }
  }, [symbol])

  /* ── Proposal resubscription ── */
  const resubscribeAll = useCallback((ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ forget_all: 'proposal', req_id: 9994 }))
    // Do NOT clear proposals here — that flashes all cards. New values arrive quickly.

    const sym  = symbolRef.current
    const curr = currencyRef.current
    const base = (amt: string) => ({ proposal: 1, subscribe: 1, amount: parseFloat(amt) || 1, basis: 'stake', currency: curr, underlying_symbol: sym })

    ws.send(JSON.stringify({ ...base(stakeOURef.current), contract_type: 'DIGITOVER',  duration: durOURef.current, duration_unit: 't', barrier: String(ouBarrierRef.current), req_id: 10 }))
    ws.send(JSON.stringify({ ...base(stakeOURef.current), contract_type: 'DIGITUNDER', duration: durOURef.current, duration_unit: 't', barrier: String(ouBarrierRef.current), req_id: 11 }))
    ws.send(JSON.stringify({ ...base(stakeMDRef.current), contract_type: 'DIGITMATCH', duration: durMDRef.current, duration_unit: 't', barrier: String(mdDigitRef.current),  req_id: 20 }))
    ws.send(JSON.stringify({ ...base(stakeMDRef.current), contract_type: 'DIGITDIFF',  duration: durMDRef.current, duration_unit: 't', barrier: String(mdDigitRef.current),  req_id: 21 }))
    ws.send(JSON.stringify({ ...base(stakeEORef.current), contract_type: 'DIGITEVEN',  duration: durEORef.current, duration_unit: 't', req_id: 30 }))
    ws.send(JSON.stringify({ ...base(stakeEORef.current), contract_type: 'DIGITODD',   duration: durEORef.current, duration_unit: 't', req_id: 31 }))
    ws.send(JSON.stringify({ ...base(stakeRFRef.current), contract_type: 'CALL', duration: durRFRef.current, duration_unit: durUnitRFRef.current, req_id: 40 }))
    ws.send(JSON.stringify({ ...base(stakeRFRef.current), contract_type: 'PUT',  duration: durRFRef.current, duration_unit: durUnitRFRef.current, req_id: 41 }))
  }, [])

  /* ── Auth WS ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    intentionalClose.current = false

    function backoff(n: number) { return Math.min(2000 * 2 ** n, 30_000) }

    async function connect() {
      setWsError(null); setWsReady(false)

      try {
        const r = await fetch('/api/user/balance', { cache: 'no-store' })
        if (r.ok) {
          const d = await r.json() as { activeAccountId: string; accounts: { accountId: string; currency: string; isDemo: boolean }[] }
          const acc = d.accounts.find(a => a.accountId === d.activeAccountId)
          if (acc) { setCurrency(acc.currency); currencyRef.current = acc.currency; setAccountLabel(acc.isDemo ? 'Demo' : 'Real') }
        }
      } catch { /**/ }

      let wsUrl = ''
      try {
        const r = await fetch('/api/user/ws-url')
        if (!r.ok) { if (r.status === 401) { intentionalClose.current = true; window.location.href = '/'; return }; setWsError('Connection failed — retrying…'); scheduleReconnect(); return }
        ;({ wsUrl } = await r.json() as { wsUrl: string })
      } catch { setWsError('Network error — retrying…'); scheduleReconnect(); return }

      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0; setWsError(null); setWsReady(true)
        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
        ws!.send(JSON.stringify({ portfolio: 1, req_id: 600 }))
        ws!.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1, req_id: 300 }))
        resubscribeAll(ws!)
        ping = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })) }, 30_000)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          if (err.code && ['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(err.code)) {
            intentionalClose.current = true; setWsError('Session expired — please log in again.'); return
          }
          const rid = msg.req_id as number
          const buyCt = buyReqToCtRef.current.get(rid)
          if (buyCt) {
            // Error on a buy request
            buyReqToCtRef.current.delete(rid)
            setBuying(prev => ({ ...prev, [buyCt]: false }))
            addToast({ type: 'error', msg: err.message })
          } else {
            // Error on a proposal subscription
            const ct = REQ_TO_CT[rid]
            if (ct) setProposals(prev => ({ ...prev, [ct]: { id: '', ask_price: 0, payout: 0, error: err.message } }))
            setBuying(prev => Object.fromEntries(Object.keys(prev).map(k => [k, false])))
          }
          return
        }

        if (msg.msg_type === 'balance') {
          const b = (msg as { balance: { balance: number; currency: string } }).balance
          window.dispatchEvent(new CustomEvent('deriv-balance', { detail: { balance: b.balance, currency: b.currency } }))
        }

        if (msg.msg_type === 'proposal') {
          const p = (msg as { proposal: { id: string; ask_price: number; payout: number } }).proposal
          const ct = REQ_TO_CT[msg.req_id as number]
          if (ct) setProposals(prev => ({ ...prev, [ct]: { id: p.id, ask_price: p.ask_price, payout: p.payout } }))
        }

        if (msg.msg_type === 'buy') {
          const buyData = (msg as { buy: { contract_id: number } }).buy
          const rid = msg.req_id as number
          const ct = buyReqToCtRef.current.get(rid)
          if (ct) {
            buyReqToCtRef.current.delete(rid)
            setBuying(prev => ({ ...prev, [ct]: false }))
            // Clear only this CT's proposal so only this card briefly shows "—"
            setProposals(prev => ({ ...prev, [ct]: null }))
            addToast({ type: 'success', msg: `${CT_LABELS[ct] ?? ct} contract purchased!` })
            // Mark this contract as placed from Manual Trader — history tracks only these
            if (buyData?.contract_id) manualTraderBoughtIds.current.add(buyData.contract_id)
          } else {
            setBuying(prev => Object.fromEntries(Object.keys(prev).map(k => [k, false])))
          }
          // Refresh proposal for the bought CT only
          setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) resubscribeAll(ws) }, 200)
        }

        if (msg.msg_type === 'portfolio') {
          type PfC = { contract_id: number; contract_type: string; underlying_symbol: string; buy_price: number | string; longcode: string; purchase_time: number; currency: string }
          const pf = (msg as { portfolio: { contracts?: PfC[] } }).portfolio
          if (pf.contracts?.length) {
            setOpenPositions(prev => {
              const next = new Map(prev)
              pf.contracts!.forEach(c => {
                if (!next.has(c.contract_id)) next.set(c.contract_id, {
                  contract_id: c.contract_id, contract_type: c.contract_type,
                  underlying: c.underlying_symbol, buy_price: parseFloat(String(c.buy_price)) || 0,
                  profit: 0, status: 'open', is_sold: 0, is_valid_to_sell: 0,
                  currency: c.currency, purchase_time: c.purchase_time, longcode: c.longcode ?? '',
                })
              })
              return next
            })
          }
        }

        if (msg.msg_type === 'proposal_open_contract') {
          const poc = (msg as { proposal_open_contract: {
            contract_id: number; contract_type: string; underlying_symbol: string
            buy_price: string; sell_price?: string; profit: string; status: string
            is_sold: number; is_valid_to_sell: number; is_settleable?: number
            currency: string; purchase_time: number; longcode: string
          }}).proposal_open_contract

          if (!poc.contract_id) return

          if (poc.is_settleable === 1 && !poc.is_sold) {
            ws?.send(JSON.stringify({ sell_expired: 1, req_id: ++reqIdRef.current }))
          }

          if (poc.is_sold === 1) {
            setOpenPositions(prev => {
              const next = new Map(prev)
              const ex = next.get(poc.contract_id)
              next.set(poc.contract_id, {
                ...(ex ?? { contract_id: poc.contract_id, contract_type: poc.contract_type, underlying: poc.underlying_symbol, buy_price: parseFloat(poc.buy_price) || 0, currency: poc.currency, purchase_time: poc.purchase_time, longcode: poc.longcode ?? '' }),
                profit: parseFloat(poc.profit) || 0, status: poc.status, is_sold: 1, is_valid_to_sell: 0, settling: true,
              })
              return next
            })
            setTimeout(() => {
              setOpenPositions(prev => { const n = new Map(prev); n.delete(poc.contract_id); return n })
              // Only add to history if this contract was placed from the Manual Trader
              if (manualTraderBoughtIds.current.has(poc.contract_id)) {
                manualTraderBoughtIds.current.delete(poc.contract_id)
                const bp = parseFloat(poc.buy_price) || 0
                const sp = poc.sell_price != null ? parseFloat(poc.sell_price) : bp + (parseFloat(poc.profit) || 0)
                setHistory(prev => [{
                  contract_id: poc.contract_id,
                  contract_type: poc.contract_type,
                  buy_price: bp,
                  sell_price: sp,
                  purchase_time: poc.purchase_time,
                }, ...prev].slice(0, 500))
              }
            }, 2500)
          } else {
            setOpenPositions(prev => {
              const next = new Map(prev)
              next.set(poc.contract_id, {
                contract_id: poc.contract_id, contract_type: poc.contract_type,
                underlying: poc.underlying_symbol, buy_price: parseFloat(poc.buy_price) || 0,
                profit: parseFloat(poc.profit) || 0, status: poc.status,
                is_sold: poc.is_sold, is_valid_to_sell: poc.is_valid_to_sell,
                currency: poc.currency, purchase_time: poc.purchase_time, longcode: poc.longcode ?? '',
              })
              return next
            })
          }
        }

      }

      ws.onerror = () => {}
      ws.onclose = () => {
        setWsReady(false); botWsRef.current = null; setBuying({})
        if (ping) { clearInterval(ping); ping = null }
        if (!intentionalClose.current) {
          if (reconnectCount.current >= MAX_RECONNECT) { setWsError('Connection lost — please refresh.'); return }
          const delay = backoff(reconnectCount.current++)
          setWsError(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`)
          scheduleReconnect(delay)
        }
      }
    }

    function scheduleReconnect(delay = 2000) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => { if (!intentionalClose.current) connect() }, delay)
    }

    connect()

    return () => {
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (ping) clearInterval(ping)
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ forget_all: 'proposal',               req_id: 9993 }))
          ws.send(JSON.stringify({ forget_all: 'proposal_open_contract', req_id: 9992 }))
        } catch { /**/ }
      }
      ws?.close(); botWsRef.current = null
    }
  }, [resubscribeAll])

  /* ── Reconnect when user switches account via the header ── */
  useEffect(() => {
    const handler = () => {
      // Force the auth WS to close + reconnect with the new account token
      reconnectCount.current = 0
      intentionalClose.current = false
      setWsReady(false)
      setProposals({})
      botWsRef.current?.close()
    }
    window.addEventListener('deriv-account-switch', handler)
    return () => window.removeEventListener('deriv-account-switch', handler)
  }, [])

  /* ── Debounce resubscription on config changes ── */
  useEffect(() => {
    if (!botWsRef.current) return
    const t = setTimeout(() => { if (botWsRef.current?.readyState === WebSocket.OPEN) resubscribeAll(botWsRef.current) }, 450)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, ouBarrier, mdDigit, stakeOU, stakeMD, stakeEO, stakeRF, durOU, durMD, durEO, durRF, durUnitRF, currency, wsReady])

  /* ── Buy handler ── */
  const doBuy = useCallback((ct: string, proposalId: string, askPrice: number) => {
    const ws = botWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || buying[ct]) return
    setBuying(prev => ({ ...prev, [ct]: true }))
    const rid = ++reqIdRef.current
    buyReqToCtRef.current.set(rid, ct)
    ws.send(JSON.stringify({ buy: proposalId, price: parseFloat((askPrice * 1.02).toFixed(2)), req_id: rid }))
  }, [buying])

  /* ── Sell handler ── */
  const handleSell = useCallback((contractId: number) => {
    const ws = botWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ sell: contractId, price: 0, req_id: ++reqIdRef.current }))
  }, [])

  /* ── Derived digit data ── */
  const digits = useMemo(
    () => prices.slice(-tickCount).map(p => getLastDigit(p, pipSizeRef.current)),
    [prices, tickCount],
  )
  const total = digits.length

  const digitCounts = useMemo(() => {
    const c = Array(10).fill(0) as number[]
    digits.forEach(d => c[d]++)
    return c
  }, [digits])

  const ranked = useMemo(
    () => digitCounts.map((c, d) => ({ d, c })).sort((a, b) => b.c - a.c),
    [digitCounts],
  )
  const highest    = ranked[0]?.d ?? -1
  const secondHigh = ranked[1]?.d ?? -1
  const lowest     = ranked[ranked.length - 1]?.d ?? -1
  const secondLow  = ranked[ranked.length - 2]?.d ?? -1
  const lastDig    = digits.length ? digits[digits.length - 1] : null

  const ouData = useMemo(() => {
    const s50 = digits.slice(-50)
    const over = digits.filter(d => d > ouAnalysisDigit).length
    const under = digits.filter(d => d <= ouAnalysisDigit).length
    const seq = s50.map(d => d > ouAnalysisDigit ? 'O' : 'U')
    const { count, val } = trailingStreak(seq)
    return { over, under, seq, rawDigits: s50, streak: count, streakLabel: val === 'O' ? 'Over' : 'Under' }
  }, [digits, ouAnalysisDigit])

  const mdData = useMemo(() => {
    const s50 = digits.slice(-50)
    const match = digits.filter(d => d === mdAnalysisDigit).length
    const differ = digits.filter(d => d !== mdAnalysisDigit).length
    const seq = s50.map(d => d === mdAnalysisDigit ? 'M' : 'D')
    const { count, val } = trailingStreak(seq)
    return { match, differ, seq, rawDigits: s50, streak: count, streakLabel: val === 'M' ? 'Match' : 'Differ' }
  }, [digits, mdAnalysisDigit])

  const eoData = useMemo(() => {
    const s50 = digits.slice(-50)
    const even = digits.filter(d => d % 2 === 0).length
    const odd  = digits.filter(d => d % 2 !== 0).length
    const seq  = s50.map(d => d % 2 === 0 ? 'E' : 'O')
    const { count, val } = trailingStreak(seq)
    return { even, odd, seq, streak: count, streakLabel: val === 'E' ? 'Even' : 'Odd' }
  }, [digits])

  const rfData = useMemo(() => {
    const slice = prices.slice(-tickCount)
    let rise = 0, fall = 0
    const seq: string[] = []
    const rawDigits: number[] = []
    for (let i = 1; i < slice.length; i++) {
      if (slice[i] > slice[i - 1])      { rise++; seq.push('R'); rawDigits.push(getLastDigit(slice[i], pipSizeRef.current)) }
      else if (slice[i] < slice[i - 1]) { fall++; seq.push('F'); rawDigits.push(getLastDigit(slice[i], pipSizeRef.current)) }
    }
    const recent = seq.slice(-50)
    const recentRaw = rawDigits.slice(-50)
    const { count, val } = trailingStreak(recent)
    return { rise, fall, seq: recent, rawDigits: recentRaw, streak: count, streakLabel: val === 'R' ? 'Rise' : 'Fall', total: rise + fall }
  }, [prices, tickCount])

  /* Circle style */
  function circleStyle(d: number): React.CSSProperties {
    let bg = '#0d1524', border = '2px solid rgba(252,163,17,0.12)', color = 'rgba(229,229,229,0.65)'
    if      (d === highest)    { bg = '#FCA311'; border = '2px solid #FCA311'; color = '#000' }
    else if (d === secondHigh) { bg = 'rgba(252,163,17,0.2)'; border = '2px solid rgba(252,163,17,0.5)'; color = '#FCA311' }
    else if (d === lowest)     { bg = 'rgba(239,68,68,0.22)'; border = '2px solid #ef4444'; color = '#ef4444' }
    else if (d === secondLow)  { bg = 'rgba(239,68,68,0.1)'; border = '2px solid rgba(239,68,68,0.4)'; color = 'rgba(239,68,68,0.85)' }
    if (d === lastDig)         { border = '3px solid #fff' }
    return { background: bg, border, color }
  }

  const p = proposals
  const openCount = Array.from(openPositions.values()).filter(o => !o.settling).length

  /* ── Render ── */
  return (
    <div style={{
      background: '#000', minHeight: '100%', display: 'flex', flexDirection: 'column',
      paddingRight: panelOpen ? '300px' : '0',
      transition: 'padding-right 0.28s cubic-bezier(0.4,0,0.2,1)',
    }}>

      {/* ── Controls bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '0.65rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#050505', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <select value={symbol} onChange={e => setSymbol(e.target.value)} style={{
          background: '#0a0f1a', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '8px', color: '#fff', fontSize: '0.8rem',
          padding: '0.38rem 0.6rem', cursor: 'pointer', outline: 'none',
        }}>
          {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
        </select>

        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(229,229,229,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>TICKS</span>
        <input type="number" min="100" max="5000" step="100" value={tickCount}
          onChange={e => setTickCount(Math.min(5000, Math.max(100, parseInt(e.target.value) || 1000)))}
          style={{ background: '#0a0f1a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.8rem', padding: '0.38rem 0.6rem', outline: 'none', width: '72px' }} />

        {livePrice != null && (
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: '0.55rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>LIVE PRICE</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#FCA311', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
              {livePrice.toFixed(pipSizeRef.current)}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: wsError ? '#ef4444' : wsReady ? '#22c55e' : '#FCA311',
            boxShadow: wsReady && !wsError ? '0 0 6px #22c55e88' : 'none',
            animation: wsReady && !wsError ? 'pulse 2s ease infinite' : 'none',
          }} />
          <span style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.45)' }}>
            {wsError ? 'Error' : wsReady ? `${accountLabel || 'Live'} · ${currency}` : 'Connecting…'}
          </span>
        </div>

        <button onClick={() => setPanelOpen(v => !v)} style={{
          display: 'flex', alignItems: 'center', gap: '0.35rem',
          padding: '0.32rem 0.65rem', borderRadius: '7px',
          border: `1px solid ${panelOpen ? 'rgba(252,163,17,0.4)' : 'rgba(255,255,255,0.12)'}`,
          background: panelOpen ? 'rgba(252,163,17,0.1)' : 'rgba(255,255,255,0.04)',
          color: panelOpen ? '#FCA311' : 'rgba(229,229,229,0.55)',
          fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer',
        }}>
          Positions
          {openCount > 0 && (
            <span style={{ background: '#ef4444', color: '#fff', borderRadius: '9px', padding: '1px 5px', fontSize: '0.58rem', fontWeight: 800, lineHeight: 1.4 }}>
              {openCount}
            </span>
          )}
        </button>
      </div>

      {wsError && (
        <div style={{ padding: '0.45rem 1.5rem', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)', color: '#fca5a5', fontSize: '0.73rem', flexShrink: 0 }}>
          ⚠ {wsError}
        </div>
      )}

      {/* ── Digit Circles ── */}
      <div style={{ padding: '1rem 1.5rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'rgba(229,229,229,0.25)', fontSize: '0.78rem' }}>Loading tick data…</div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {[0,1,2,3,4,5,6,7,8,9].map(d => {
              const cnt = digitCounts[d] ?? 0
              const pct = total ? (cnt / total) * 100 : 0
              const sty = circleStyle(d)
              return (
                <div key={d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                  <div style={{
                    width: '50px', height: '50px', borderRadius: '50%',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1rem', fontWeight: 800, lineHeight: 1,
                    ...sty,
                  }}>
                    <span>{d}</span>
                    <span style={{ fontSize: '0.54rem', fontWeight: 600, opacity: 0.82, marginTop: '1px' }}>{pct.toFixed(1)}%</span>
                  </div>
                  {d === lastDig && (
                    <div style={{ width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '5px solid rgba(255,255,255,0.65)' }} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 4-card grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, overflow: 'auto' }}>

        {/* OVER / UNDER */}
        <Card title="Over / Under" streakCount={ouData.streak} streakLabel={ouData.streakLabel}>
          <DigitPicker selected={ouAnalysisDigit} onSelect={setOuAnalysisDigit} />
          <Bar label="Over"  color="#22c55e" count={ouData.over}  total={total} />
          <Bar label="Under" color="#3b82f6" count={ouData.under} total={total} />
          <Sequence seq={ouData.seq} colorMap={OU_COLORS} rawDigits={ouData.rawDigits} />
          <TradeControls
            labelA="Over" labelB="Under" colorA="#22c55e" colorB="#3b82f6"
            propA={p['DIGITOVER'] ?? null} propB={p['DIGITUNDER'] ?? null}
            buyingA={!!buying['DIGITOVER']} buyingB={!!buying['DIGITUNDER']}
            wsReady={wsReady} currency={currency}
            stake={stakeOU} onStakeChange={setStakeOU}
            duration={durOU} onDurationChange={setDurOU}
            durUnit="t" onDurUnitChange={() => {}} showDurUnit={false}
            onBuyA={() => { const pr = p['DIGITOVER'];  if (pr?.id) doBuy('DIGITOVER',  pr.id, pr.ask_price) }}
            onBuyB={() => { const pr = p['DIGITUNDER']; if (pr?.id) doBuy('DIGITUNDER', pr.id, pr.ask_price) }}
            showDigitPicker selectedDigit={ouBarrier} onDigitSelect={setOuBarrier} digitLabel="Barrier"
          />
        </Card>

        {/* MATCH / DIFFER */}
        <div style={{ borderLeft: '1px solid rgba(255,255,255,0.07)' }}>
          <Card title="Match / Differ" streakCount={mdData.streak} streakLabel={mdData.streakLabel}>
            <DigitPicker selected={mdAnalysisDigit} onSelect={setMdAnalysisDigit} />
            <Bar label="Match"  color="#ef4444" count={mdData.match}  total={total} />
            <Bar label="Differ" color="#a855f7" count={mdData.differ} total={total} />
            <Sequence seq={mdData.seq} colorMap={MD_COLORS} rawDigits={mdData.rawDigits} />
            <TradeControls
              labelA="Match" labelB="Differ" colorA="#ef4444" colorB="#a855f7"
              propA={p['DIGITMATCH'] ?? null} propB={p['DIGITDIFF'] ?? null}
              buyingA={!!buying['DIGITMATCH']} buyingB={!!buying['DIGITDIFF']}
              wsReady={wsReady} currency={currency}
              stake={stakeMD} onStakeChange={setStakeMD}
              duration={durMD} onDurationChange={setDurMD}
              durUnit="t" onDurUnitChange={() => {}} showDurUnit={false}
              onBuyA={() => { const pr = p['DIGITMATCH']; if (pr?.id) doBuy('DIGITMATCH', pr.id, pr.ask_price) }}
              onBuyB={() => { const pr = p['DIGITDIFF'];  if (pr?.id) doBuy('DIGITDIFF',  pr.id, pr.ask_price) }}
              showDigitPicker selectedDigit={mdDigit} onDigitSelect={setMdDigit} digitLabel="Digit"
            />
          </Card>
        </div>

        {/* EVEN / ODD */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <Card title="Even / Odd" streakCount={eoData.streak} streakLabel={eoData.streakLabel}>
            <Bar label="Even" color="#FCA311" count={eoData.even} total={total} />
            <Bar label="Odd"  color="#6366f1" count={eoData.odd}  total={total} />
            <Sequence seq={eoData.seq} colorMap={EO_COLORS} />
            <TradeControls
              labelA="Even" labelB="Odd" colorA="#FCA311" colorB="#6366f1"
              propA={p['DIGITEVEN'] ?? null} propB={p['DIGITODD'] ?? null}
              buyingA={!!buying['DIGITEVEN']} buyingB={!!buying['DIGITODD']}
              wsReady={wsReady} currency={currency}
              stake={stakeEO} onStakeChange={setStakeEO}
              duration={durEO} onDurationChange={setDurEO}
              durUnit="t" onDurUnitChange={() => {}} showDurUnit={false}
              onBuyA={() => { const pr = p['DIGITEVEN']; if (pr?.id) doBuy('DIGITEVEN', pr.id, pr.ask_price) }}
              onBuyB={() => { const pr = p['DIGITODD'];  if (pr?.id) doBuy('DIGITODD',  pr.id, pr.ask_price) }}
            />
          </Card>
        </div>

        {/* RISE / FALL */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', borderLeft: '1px solid rgba(255,255,255,0.07)' }}>
          <Card title="Rise / Fall" streakCount={rfData.streak} streakLabel={rfData.streakLabel}>
            <Bar label="Rise" color="#22c55e" count={rfData.rise} total={rfData.total} />
            <Bar label="Fall" color="#ef4444" count={rfData.fall} total={rfData.total} />
            <Sequence seq={rfData.seq} colorMap={RF_COLORS} rawDigits={rfData.rawDigits} />
            <TradeControls
              labelA="Rise" labelB="Fall" colorA="#22c55e" colorB="#ef4444"
              propA={p['CALL'] ?? null} propB={p['PUT'] ?? null}
              buyingA={!!buying['CALL']} buyingB={!!buying['PUT']}
              wsReady={wsReady} currency={currency}
              stake={stakeRF} onStakeChange={setStakeRF}
              duration={durRF} onDurationChange={setDurRF}
              durUnit={durUnitRF} onDurUnitChange={v => setDurUnitRF(v as 't'|'m'|'h')} showDurUnit={true}
              onBuyA={() => { const pr = p['CALL']; if (pr?.id) doBuy('CALL', pr.id, pr.ask_price) }}
              onBuyB={() => { const pr = p['PUT'];  if (pr?.id) doBuy('PUT',  pr.id, pr.ask_price) }}
            />
          </Card>
        </div>
      </div>

      {/* ── Positions Panel ── */}
      <PositionsPanel
        open={panelOpen} onClose={() => setPanelOpen(false)}
        openPositions={openPositions} history={history}
        currency={currency} onSell={handleSell}
        onClearHistory={() => setHistory([])}
      />

      {/* Edge tab — opens panel when closed, closes when open */}
      <button onClick={() => setPanelOpen(v => !v)} style={{
        position: 'fixed', right: panelOpen ? '300px' : '0',
        top: 'calc(50% + 50px)', transform: 'translateY(-50%)',
        background: '#070f1e',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRight: 'none', borderRadius: '8px 0 0 8px',
        padding: '0.65rem 0.32rem', cursor: 'pointer', zIndex: 42,
        color: panelOpen ? '#FCA311' : openCount > 0 ? '#FCA311' : 'rgba(229,229,229,0.5)',
        fontSize: '0.9rem', fontWeight: 700, lineHeight: 1,
        transition: 'right 0.28s cubic-bezier(0.4,0,0.2,1)',
        borderColor: openCount > 0 || panelOpen ? 'rgba(252,163,17,0.35)' : 'rgba(255,255,255,0.1)',
      }}>
        {panelOpen ? '›' : openCount > 0 ? `‹${openCount}` : '‹'}
      </button>

      {/* ── Toast notifications ── */}
      <div style={{ position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 200, pointerEvents: 'none', alignItems: 'center' }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            padding: '0.55rem 1.1rem', borderRadius: '8px', fontSize: '0.8rem', fontWeight: 700,
            background: t.type === 'success' ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)',
            border: `1px solid ${t.type === 'success' ? '#22c55e' : '#ef4444'}`,
            color: t.type === 'success' ? '#22c55e' : '#ef4444',
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            whiteSpace: 'nowrap',
            animation: 'toastIn 0.2s ease',
          }}>
            {t.type === 'success' ? '✓ ' : '✕ '}{t.msg}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes toastIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  )
}
