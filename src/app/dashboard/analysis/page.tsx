'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

/* ─── Constants ─────────────────────────────────────────── */
const WS_URL      = 'wss://ws.binaryws.com/websockets/v3?app_id=1089'
const BOT_WS_BASE = 'wss://ws.binaryws.com/websockets/v3?app_id='
const MAX_HISTORY = 5000

const MARKETS = [
  { symbol: '1HZ100V',  label: 'Volatility 100 (1s) Index' },
  { symbol: '1HZ10V',   label: 'Volatility 10 (1s) Index' },
  { symbol: '1HZ25V',   label: 'Volatility 25 (1s) Index' },
  { symbol: '1HZ50V',   label: 'Volatility 50 (1s) Index' },
  { symbol: '1HZ75V',   label: 'Volatility 75 (1s) Index' },
  { symbol: 'BOOM1000', label: 'Boom 1000 Index' },
  { symbol: 'BOOM500',  label: 'Boom 500 Index' },
  { symbol: 'BOOM600',  label: 'Boom 600 Index' },
  { symbol: 'BOOM900',  label: 'Boom 900 Index' },
  { symbol: 'CRASH1000',label: 'Crash 1000 Index' },
  { symbol: 'CRASH500', label: 'Crash 500 Index' },
  { symbol: 'CRASH600', label: 'Crash 600 Index' },
  { symbol: 'CRASH900', label: 'Crash 900 Index' },
  { symbol: 'JD10',     label: 'Jump 10 Index' },
  { symbol: 'JD100',    label: 'Jump 100 Index' },
  { symbol: 'JD25',     label: 'Jump 25 Index' },
  { symbol: 'JD50',     label: 'Jump 50 Index' },
  { symbol: 'JD75',     label: 'Jump 75 Index' },
  { symbol: 'RDBEAR',   label: 'Bear Market Index' },
  { symbol: 'RDBULL',   label: 'Bull Market Index' },
  { symbol: 'R_10',     label: 'Volatility 10 Index' },
  { symbol: 'R_100',    label: 'Volatility 100 Index' },
  { symbol: 'R_25',     label: 'Volatility 25 Index' },
  { symbol: 'R_50',     label: 'Volatility 50 Index' },
  { symbol: 'R_75',     label: 'Volatility 75 Index' },
  { symbol: 'stpRNG',   label: 'Step Index 100' },
  { symbol: 'stpRNG2',  label: 'Step Index 200' },
  { symbol: 'stpRNG3',  label: 'Step Index 300' },
  { symbol: 'stpRNG4',  label: 'Step Index 400' },
  { symbol: 'stpRNG5',  label: 'Step Index 500' },
]

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/* Contract types that need a digit barrier */
const BARRIER_TYPES = ['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER']
function needsBarrier(ct: string) { return BARRIER_TYPES.includes(ct) }

const CONTRACT_TYPES = [
  { value: 'DIGITEVEN',  label: 'Even/Odd → Even' },
  { value: 'DIGITODD',   label: 'Even/Odd → Odd' },
  { value: 'DIGITMATCH', label: 'Match/Differ → Match' },
  { value: 'DIGITDIFF',  label: 'Match/Differ → Differ' },
  { value: 'DIGITOVER',  label: 'Over/Under → Over' },
  { value: 'DIGITUNDER', label: 'Over/Under → Under' },
]

/* ─── Helpers ───────────────────────────────────────────── */
function getLastDigit(price: number): number {
  const s = price.toFixed(2)
  return parseInt(s[s.length - 1], 10)
}

function trailingStreak(arr: string[]): { count: number; val: string } {
  if (!arr.length) return { count: 0, val: '' }
  const val = arr[arr.length - 1]
  let count = 0
  for (let i = arr.length - 1; i >= 0 && arr[i] === val; i--) count++
  return { count, val }
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/* ─── Sub-components ────────────────────────────────────── */
function Bar({ label, color, count, total }: {
  label: string; color: string; count: number; total: number
}) {
  const pct = total ? (count / total) * 100 : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
      <span style={{ width: '44px', fontSize: '0.72rem', fontWeight: 600, color, flexShrink: 0 }}>
        {label}
      </span>
      <div style={{
        flex: 1, height: '8px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '99px', overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: color, borderRadius: '99px',
          transition: 'width 0.5s ease',
        }} />
      </div>
      <span style={{
        width: '42px', fontSize: '0.72rem', fontWeight: 600,
        color: 'rgba(229,229,229,0.7)', textAlign: 'right',
        fontVariantNumeric: 'tabular-nums', flexShrink: 0,
      }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}

interface SeqColor { bg: string; border: string; text: string }
function Sequence({ seq, colorMap }: { seq: string[]; colorMap: Record<string, SeqColor> }) {
  return (
    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
      {seq.map((s, i) => {
        const c = colorMap[s] ?? { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', text: '#aaa' }
        return (
          <div key={i} style={{
            width: '26px', height: '26px', borderRadius: '6px',
            fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: c.bg, border: `1.5px solid ${c.border}`, color: c.text,
          }}>
            {s}
          </div>
        )
      })}
    </div>
  )
}

function Card({ title, streak, streakLabel, children }: {
  title: string; streak: number; streakLabel: string; children: React.ReactNode
}) {
  return (
    <div style={{ background: '#050505', padding: '1rem 1.25rem' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '0.9rem',
      }}>
        <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {title}
        </span>
        {streak > 0 && (
          <span style={{
            fontSize: '0.68rem', fontWeight: 700, color: 'var(--gold)',
            background: 'rgba(252,163,17,0.1)', padding: '0.15rem 0.55rem',
            borderRadius: '20px', border: '1px solid rgba(252,163,17,0.3)',
          }}>
            {streak}x {streakLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function DigitPicker({ selected, onSelect }: { selected: number; onSelect: (d: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.85rem', justifyContent: 'center' }}>
      {DIGITS.map(d => (
        <button
          key={d}
          onClick={() => onSelect(d)}
          style={{
            width: '27px', height: '27px', borderRadius: '50%',
            fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer',
            border: `1.5px solid ${selected === d ? 'var(--gold)' : 'rgba(255,255,255,0.14)'}`,
            background: selected === d ? 'rgba(252,163,17,0.18)' : 'transparent',
            color: selected === d ? 'var(--gold)' : 'rgba(229,229,229,0.55)',
            transition: 'all 0.15s',
          }}
        >
          {d}
        </button>
      ))}
    </div>
  )
}

/* ─── Types ─────────────────────────────────────────────── */
interface RunStats {
  totalStake: number
  totalPayout: number
  runs: number
  lost: number
  won: number
  profit: number
}

interface TxEntry {
  id: number         // contract_id
  time: number       // epoch ms
  contractType: string
  stake: number
  payout: number
  won: boolean
  symbol: string
}

/* ─── Run Panel ─────────────────────────────────────────── */
type RunTab = 'summary' | 'transactions' | 'journal'

function RunPanel({
  open,
  onToggle,
  running,
  stats,
  onReset,
  /* bot config */
  contractType,
  setContractType,
  stake,
  setStake,
  barrier,
  setBarrier,
  /* status */
  botReady,
  botError,
  currency,
  /* tx log */
  txLog,
}: {
  open: boolean
  onToggle: () => void
  running: boolean
  stats: RunStats
  onReset: () => void
  contractType: string
  setContractType: (v: string) => void
  stake: string
  setStake: (v: string) => void
  barrier: string
  setBarrier: (v: string) => void
  botReady: boolean
  botError: string | null
  currency: string
  txLog: TxEntry[]
}) {
  const [tab, setTab] = useState<RunTab>('summary')

  const TABS: RunTab[] = ['summary', 'transactions', 'journal']

  const statTiles = [
    { label: 'Total stake',      value: `${stats.totalStake.toFixed(2)} ${currency}` },
    { label: 'Total payout',     value: `${stats.totalPayout.toFixed(2)} ${currency}` },
    { label: 'No. of runs',      value: String(stats.runs) },
    { label: 'Contracts lost',   value: String(stats.lost) },
    { label: 'Contracts won',    value: String(stats.won) },
    { label: 'Total profit/loss',value: `${stats.profit >= 0 ? '+' : ''}${stats.profit.toFixed(2)} ${currency}` },
  ]

  /* ── Input style helper ── */
  const inputStyle: React.CSSProperties = {
    background: '#050505',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '0.78rem',
    padding: '0.35rem 0.6rem',
    width: '100%',
    outline: 'none',
  }

  return (
    <div style={{
      position: 'fixed',
      right: 0,
      top: '88px',
      bottom: '48px',
      width: '350px',
      transform: open ? 'translateX(0)' : 'translateX(350px)',
      transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
      zIndex: 60,
      background: '#0a0a0a',
      borderLeft: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: open ? '-8px 0 32px rgba(0,0,0,0.55)' : 'none',
    }}>

      {/* ── Toggle handle ── */}
      <button
        onClick={onToggle}
        aria-label={open ? 'Close run panel' : 'Open run panel'}
        style={{
          position: 'absolute',
          left: '-22px',
          top: '50%',
          transform: 'translateY(-50%)',
          width: '22px',
          height: '52px',
          background: '#0a0a0a',
          border: '1px solid var(--border)',
          borderRight: 'none',
          borderRadius: '8px 0 0 8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(229,229,229,0.45)',
          padding: 0,
        }}
      >
        <svg width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {open ? (
            <>
              <polyline points="7,4 11,9 7,14"/>
              <polyline points="2,4  6,9 2,14"/>
            </>
          ) : (
            <>
              <polyline points="5,4  1,9  5,14"/>
              <polyline points="10,4 6,9 10,14"/>
            </>
          )}
        </svg>
      </button>

      {/* ── Tab bar ── */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        background: '#050505',
        flexShrink: 0,
      }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '0.65rem 0',
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: 'pointer',
              border: 'none',
              background: 'transparent',
              color: tab === t ? 'var(--gold)' : 'rgba(229,229,229,0.38)',
              borderBottom: tab === t ? '2px solid var(--gold)' : '2px solid transparent',
              textTransform: 'capitalize',
              transition: 'color 0.15s, border-color 0.15s',
              letterSpacing: '0.03em',
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.85rem' }}>

        {/* ═══ SUMMARY TAB ═══ */}
        {tab === 'summary' && (
          <>
            {/* Connection status badge */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              marginBottom: '0.85rem',
              padding: '0.4rem 0.6rem',
              borderRadius: '8px',
              background: botError
                ? 'rgba(239,68,68,0.1)'
                : botReady
                ? 'rgba(34,197,94,0.08)'
                : 'rgba(252,163,17,0.08)',
              border: `1px solid ${botError ? 'rgba(239,68,68,0.25)' : botReady ? 'rgba(34,197,94,0.2)' : 'rgba(252,163,17,0.2)'}`,
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                background: botError ? '#ef4444' : botReady ? '#22c55e' : '#FCA311',
                boxShadow: botReady && !botError ? '0 0 6px #22c55e' : 'none',
              }}/>
              <span style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.6)' }}>
                {botError ? botError : botReady ? 'Connected to Deriv' : 'Connecting…'}
              </span>
            </div>

            {/* ── Bot config ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', marginBottom: '1rem' }}>
              {/* Contract type */}
              <div>
                <label style={{
                  display: 'block', fontSize: '0.6rem', fontWeight: 600,
                  color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase',
                  letterSpacing: '0.06em', marginBottom: '0.3rem',
                }}>
                  Contract Type
                </label>
                <select
                  value={contractType}
                  onChange={e => setContractType(e.target.value)}
                  disabled={running}
                  style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'pointer' }}
                >
                  {CONTRACT_TYPES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              {/* Stake + barrier row */}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{
                    display: 'block', fontSize: '0.6rem', fontWeight: 600,
                    color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase',
                    letterSpacing: '0.06em', marginBottom: '0.3rem',
                  }}>
                    Stake ({currency})
                  </label>
                  <input
                    type="number"
                    min="0.35"
                    step="0.01"
                    value={stake}
                    onChange={e => setStake(e.target.value)}
                    disabled={running}
                    style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'text' }}
                  />
                </div>
                {needsBarrier(contractType) && (
                  <div style={{ width: '70px' }}>
                    <label style={{
                      display: 'block', fontSize: '0.6rem', fontWeight: 600,
                      color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase',
                      letterSpacing: '0.06em', marginBottom: '0.3rem',
                    }}>
                      Digit
                    </label>
                    <select
                      value={barrier}
                      onChange={e => setBarrier(e.target.value)}
                      disabled={running}
                      style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'pointer' }}
                    >
                      {DIGITS.map(d => (
                        <option key={d} value={String(d)}>{d}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* ── Idle hint ── */}
            {!running && stats.runs === 0 && (
              <div style={{
                textAlign: 'center',
                color: 'rgba(229,229,229,0.35)',
                fontSize: '0.78rem',
                lineHeight: 1.7,
                padding: '0.5rem 0.5rem 0.75rem',
              }}>
                Configure your bot above, then hit{' '}
                <strong style={{ color: 'rgba(229,229,229,0.55)' }}>Run</strong>.
                {' '}Stats will appear here.
              </div>
            )}

            {/* ── Stats tiles ── */}
            {stats.runs > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.55rem' }}>
                {statTiles.map(s => (
                  <div
                    key={s.label}
                    style={{
                      background: '#050505',
                      border: '1px solid var(--border)',
                      borderRadius: '10px',
                      padding: '0.65rem 0.7rem',
                    }}
                  >
                    <div style={{
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      color: 'rgba(229,229,229,0.32)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      marginBottom: '0.28rem',
                    }}>
                      {s.label}
                    </div>
                    <div style={{
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      color:
                        s.label === 'Total profit/loss'
                          ? stats.profit > 0 ? '#22c55e' : stats.profit < 0 ? '#ef4444' : '#fff'
                          : s.label === 'Contracts won' && stats.won > 0 ? '#22c55e'
                          : s.label === 'Contracts lost' && stats.lost > 0 ? '#ef4444'
                          : '#fff',
                    }}>
                      {s.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ═══ TRANSACTIONS TAB ═══ */}
        {tab === 'transactions' && (
          txLog.length === 0 ? (
            <div style={{
              textAlign: 'center',
              color: 'rgba(229,229,229,0.3)',
              fontSize: '0.78rem',
              marginTop: '2rem',
              lineHeight: 1.7,
            }}>
              No trades yet.<br/>Start the bot to see results here.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              {txLog.map(tx => (
                <div
                  key={tx.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.55rem 0.65rem',
                    borderRadius: '8px',
                    background: '#050505',
                    border: `1px solid ${tx.won ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  }}
                >
                  {/* W/L badge */}
                  <span style={{
                    fontSize: '0.62rem', fontWeight: 800,
                    color: tx.won ? '#22c55e' : '#ef4444',
                    background: tx.won ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    border: `1px solid ${tx.won ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
                    borderRadius: '4px',
                    padding: '0.1rem 0.35rem',
                    flexShrink: 0,
                    letterSpacing: '0.04em',
                  }}>
                    {tx.won ? 'WIN' : 'LOSS'}
                  </span>

                  {/* details */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.7)', fontWeight: 600 }}>
                      {CONTRACT_TYPES.find(c => c.value === tx.contractType)?.label ?? tx.contractType}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.35)', marginTop: '1px' }}>
                      {fmtTime(tx.time)} · {tx.symbol}
                    </div>
                  </div>

                  {/* payout */}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{
                      fontSize: '0.78rem', fontWeight: 700,
                      color: tx.won ? '#22c55e' : '#ef4444',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {tx.won ? '+' : '-'}{Math.abs(tx.payout - tx.stake).toFixed(2)}
                    </div>
                    <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.3)' }}>
                      stake {tx.stake.toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* ═══ JOURNAL TAB ═══ */}
        {tab === 'journal' && (
          txLog.length === 0 ? (
            <div style={{
              textAlign: 'center',
              color: 'rgba(229,229,229,0.3)',
              fontSize: '0.78rem',
              marginTop: '2rem',
              lineHeight: 1.7,
            }}>
              No journal entries yet.<br/>Events will appear here when the bot runs.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {txLog.map((tx, i) => (
                <div key={i} style={{
                  fontSize: '0.7rem',
                  color: 'rgba(229,229,229,0.55)',
                  padding: '0.3rem 0',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  <span style={{ color: 'rgba(229,229,229,0.3)' }}>{fmtTime(tx.time)}</span>
                  {' '}Contract #{tx.id}: {tx.won ? '✓ Won' : '✗ Lost'} | stake {tx.stake.toFixed(2)} | payout {tx.payout.toFixed(2)}
                </div>
              ))}
            </div>
          )
        )}

      </div>

      {/* ── Footer: Reset ── */}
      <div style={{ padding: '0.75rem', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button
          onClick={onReset}
          style={{
            width: '100%',
            padding: '0.6rem',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'rgba(229,229,229,0.5)',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: 'pointer',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            transition: 'background 0.15s, color 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(229,229,229,0.8)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(229,229,229,0.5)'
          }}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

/* ─── Run Bar ────────────────────────────────────────────── */
type ExecSpeed = 'normal' | 'fast' | 'turbo'
const SPEED_LABELS: Record<ExecSpeed, string> = {
  normal: 'Normal Speed',
  fast:   'Fast Speed',
  turbo:  'Turbo Speed',
}

function RunBar({
  running,
  onToggleRun,
  speed,
  onCycleSpeed,
  disabled,
}: {
  running: boolean
  onToggleRun: () => void
  speed: ExecSpeed
  onCycleSpeed: () => void
  disabled: boolean
}) {
  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '48px',
      background: '#050505',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      gap: '1rem',
      padding: '0 1.25rem',
      zIndex: 50,
    }}>
      <button
        onClick={onToggleRun}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.45rem',
          padding: '0.4rem 1.2rem',
          borderRadius: '8px',
          border: 'none',
          background: disabled ? '#333' : running ? '#ef4444' : '#22c55e',
          color: disabled ? '#666' : '#fff',
          fontWeight: 700,
          fontSize: '0.82rem',
          cursor: disabled ? 'not-allowed' : 'pointer',
          letterSpacing: '0.04em',
          transition: 'background 0.2s',
        }}
        title={disabled ? 'Connecting to Deriv…' : undefined}
      >
        {running ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="1" y="1" width="10" height="10" rx="2"/>
          </svg>
        ) : (
          <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor">
            <polygon points="0,0 11,6.5 0,13"/>
          </svg>
        )}
        {running ? 'Stop' : 'Run'}
      </button>

      <button
        onClick={onCycleSpeed}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '0.35rem 0.75rem',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}
      >
        <span style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Speed
        </span>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'rgba(229,229,229,0.7)' }}>
          {SPEED_LABELS[speed]}
        </span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="rgba(229,229,229,0.35)" strokeWidth="1.5" strokeLinecap="round">
          <polyline points="1,1 5,5 9,1"/>
        </svg>
      </button>
    </div>
  )
}

/* ─── Scanner iframe ────────────────────────────────────── */
function ScannerView() {
  return (
    <iframe
      src="https://signals-scanner.vercel.app/"
      title="Signal Scanner"
      style={{
        width: '100%',
        flex: 1,
        border: 'none',
        display: 'block',
        minHeight: 'calc(100vh - 160px)',
      }}
      allow="autoplay"
    />
  )
}

/* ─── Main Page ─────────────────────────────────────────── */
export default function AnalysisPage() {
  /* ── Ticks / analysis state ── */
  const [activeTab, setActiveTab] = useState<'circles' | 'scanner'>('circles')
  const [symbol,    setSymbol]    = useState('1HZ100V')
  const [tickCount, setTickCount] = useState(1000)
  const [prices,    setPrices]    = useState<number[]>([])
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [ouBarrier, setOuBarrier] = useState(5)
  const [mdDigit,   setMdDigit]   = useState(5)

  const wsRef = useRef<WebSocket | null>(null)

  /* ── Run panel UI state ── */
  const [runOpen,   setRunOpen]   = useState(false)
  const [running,   setRunning]   = useState(false)
  const [execSpeed, setExecSpeed] = useState<ExecSpeed>('normal')
  const [runStats,  setRunStats]  = useState<RunStats>({
    totalStake: 0, totalPayout: 0, runs: 0, lost: 0, won: 0, profit: 0,
  })

  /* ── Bot config state ── */
  const [contractType, setContractType] = useState('DIGITEVEN')
  const [stake,        setStake]        = useState('1.00')
  const [barrier,      setBarrier]      = useState('5')
  const [currency,     setCurrency]     = useState('USD')
  const [botReady,     setBotReady]     = useState(false)
  const [botError,     setBotError]     = useState<string | null>(null)
  const [txLog,        setTxLog]        = useState<TxEntry[]>([])

  /* ── Refs (avoid stale closures in WS callbacks) ── */
  const runningRef     = useRef(false)
  const contractTypeRef = useRef('DIGITEVEN')
  const stakeRef       = useRef('1.00')
  const barrierRef     = useRef('5')
  const symbolRef      = useRef('1HZ100V')
  const execSpeedRef   = useRef<ExecSpeed>('normal')
  const currencyRef    = useRef('USD')
  const botWsRef       = useRef<WebSocket | null>(null)
  /** Maps contract_id → buy_price for bot trades we initiated */
  const pendingBuysRef = useRef<Map<number, number>>(new Map())
  const reqIdRef       = useRef(200)

  /* ── Keep refs in sync with state ── */
  useEffect(() => { symbolRef.current      = symbol      }, [symbol])
  useEffect(() => { contractTypeRef.current = contractType }, [contractType])
  useEffect(() => { stakeRef.current       = stake       }, [stake])
  useEffect(() => { barrierRef.current     = barrier     }, [barrier])
  useEffect(() => { execSpeedRef.current   = execSpeed   }, [execSpeed])
  useEffect(() => { currencyRef.current    = currency    }, [currency])

  /* ── Execute one trade via the authorized bot WS ── */
  const executeTrade = useCallback((ws: WebSocket) => {
    if (!runningRef.current || ws.readyState !== WebSocket.OPEN) return

    const ct      = contractTypeRef.current
    const hasBar  = needsBarrier(ct)
    const amount  = parseFloat(stakeRef.current) || 1.00
    const reqId   = ++reqIdRef.current

    /*
     * Deriv WebSocket API — buy (without prior proposal)
     * buy: "1"   → use inline parameters instead of a proposal id
     * price: 1000 → max price we'll pay (always fills at actual ask_price)
     *
     * contract_type: one of DIGITEVEN | DIGITODD | DIGITMATCH | DIGITDIFF | DIGITOVER | DIGITUNDER
     * duration: 1, duration_unit: "t" → 1-tick digit contract
     * barrier (optional): the digit prediction for MATCH/DIFF/OVER/UNDER
     */
    ws.send(JSON.stringify({
      buy: '1',
      price: 1000,
      req_id: reqId,
      parameters: {
        contract_type: ct,
        symbol:        symbolRef.current,
        duration:      1,
        duration_unit: 't',
        amount,
        basis:    'stake',
        currency: currencyRef.current,
        ...(hasBar ? { barrier: barrierRef.current } : {}),
      },
    }))
  }, [])

  /* ── Bot WebSocket lifecycle ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null

    async function connect() {
      setBotError(null)
      setBotReady(false)

      let token = '', appId = ''
      try {
        const res = await fetch('/api/user/token')
        if (!res.ok) {
          setBotError(res.status === 401 ? 'Log in to enable the bot' : 'Failed to fetch token')
          return
        }
        ;({ token, appId } = await res.json() as { token: string; appId: string })
      } catch {
        setBotError('Network error')
        return
      }

      ws = new WebSocket(`${BOT_WS_BASE}${appId}`)
      botWsRef.current = ws

      ws.onopen = () => {
        // Step 1: authorize with the user's OAuth access token
        ws!.send(JSON.stringify({ authorize: token }))

        // Keep-alive ping every 30 s
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30_000)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        if (msg.error) {
          const errMsg = (msg.error as { message: string }).message
          setBotError(errMsg)
          // Stop bot on API error
          setRunning(false)
          runningRef.current = false
          return
        }

        /* ── authorize response ──
         * Deriv returns account info including currency.
         * Once authorized, subscribe to the transaction stream so we
         * can track every buy/sell event in real time.
         */
        if (msg.msg_type === 'authorize') {
          const auth = msg.authorize as { currency: string; loginid: string }
          setCurrency(auth.currency)
          currencyRef.current = auth.currency

          // Step 2: subscribe to real-time transaction stream
          ws!.send(JSON.stringify({ transaction: 1, subscribe: 1 }))

          setBotReady(true)
          // If user clicked Run before WS finished connecting, start now
          if (runningRef.current) executeTrade(ws!)
        }

        /* ── buy response ──
         * Sent immediately after a buy request is accepted.
         * We record contract_id → buy_price so we can match the sell later.
         */
        if (msg.msg_type === 'buy') {
          if (msg.error) return // already handled above
          const buy = msg.buy as { contract_id: number; buy_price: number }
          pendingBuysRef.current.set(buy.contract_id, buy.buy_price)
          setRunStats(prev => ({
            ...prev,
            totalStake: prev.totalStake + buy.buy_price,
            runs: prev.runs + 1,
          }))
        }

        /* ── transaction stream ──
         * action: "buy"  → money deducted (amount is negative)
         * action: "sell" → payout credited (amount is positive; 0 if contract lost)
         *
         * We only process sell events for contracts we initiated (via pendingBuysRef).
         * On settle: update stats, log the trade, schedule next trade if still running.
         */
        if (msg.msg_type === 'transaction') {
          const tx = msg.transaction as {
            action: string
            amount: number
            contract_id?: number
            currency: string
          }

          if (tx.action === 'sell' && tx.contract_id != null) {
            const buyPrice = pendingBuysRef.current.get(tx.contract_id)
            if (buyPrice === undefined) return // not our contract

            pendingBuysRef.current.delete(tx.contract_id)
            const sellAmount = Math.max(0, tx.amount) // 0 on full loss
            const won = sellAmount > 0

            setRunStats(prev => {
              const newPayout = prev.totalPayout + sellAmount
              return {
                ...prev,
                totalPayout: newPayout,
                won:    won ? prev.won + 1  : prev.won,
                lost:   won ? prev.lost     : prev.lost + 1,
                profit: newPayout - prev.totalStake,
              }
            })

            // Add to transaction log (capped at 100 entries)
            setTxLog(prev => [{
              id:           tx.contract_id!,
              time:         Date.now(),
              contractType: contractTypeRef.current,
              stake:        buyPrice,
              payout:       sellAmount,
              won,
              symbol:       symbolRef.current,
            }, ...prev].slice(0, 100))

            // Schedule next trade based on execution speed
            if (runningRef.current && ws?.readyState === WebSocket.OPEN) {
              const delay =
                execSpeedRef.current === 'turbo'  ? 500  :
                execSpeedRef.current === 'fast'   ? 1500 : 3000
              setTimeout(() => {
                if (runningRef.current && ws?.readyState === WebSocket.OPEN) {
                  executeTrade(ws!)
                }
              }, delay)
            }
          }
        }
      }

      ws.onerror = () => setBotError('WebSocket connection error')
      ws.onclose = () => {
        setBotReady(false)
        botWsRef.current = null
        if (ping) { clearInterval(ping); ping = null }
      }
    }

    connect()

    return () => {
      if (ping) clearInterval(ping)
      ws?.close()
      botWsRef.current = null
    }
  }, [executeTrade])

  /* ── Sync running ref + trigger first trade ── */
  useEffect(() => {
    runningRef.current = running
    if (running && botWsRef.current?.readyState === WebSocket.OPEN) {
      executeTrade(botWsRef.current)
    }
  }, [running, executeTrade])

  /* ── Reset handler ── */
  function handleReset() {
    setRunning(false)
    runningRef.current = false
    pendingBuysRef.current.clear()
    setRunStats({ totalStake: 0, totalPayout: 0, runs: 0, lost: 0, won: 0, profit: 0 })
    setTxLog([])
  }

  function cycleSpeed() {
    setExecSpeed(s => s === 'normal' ? 'fast' : s === 'fast' ? 'turbo' : 'normal')
  }

  /* ── Ticks WebSocket: re-init on symbol change ── */
  useEffect(() => {
    setLoading(true)
    setPrices([])
    setLivePrice(null)

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        end:    'latest',
        start:  1,
        count:  MAX_HISTORY,
        style:  'ticks',
        subscribe: 1,
      }))
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(ev.data as string) } catch { return }

      if (msg.error) { setLoading(false); return }

      if (msg.msg_type === 'history') {
        const hist = (msg as { history: { prices: string[] } }).history.prices
          .map((p: string) => parseFloat(p))
        setPrices(hist)
        setLoading(false)
      }

      if (msg.msg_type === 'tick') {
        const q = (msg as { tick: { quote: number } }).tick.quote
        setLivePrice(q)
        setPrices(prev => {
          const next = [...prev, q]
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
        })
      }
    }

    ws.onerror  = () => setLoading(false)
    ws.onclose  = () => {}

    return () => { ws.close(); wsRef.current = null }
  }, [symbol])

  /* ── Derived digit data ── */
  const digits = useMemo(
    () => prices.slice(-tickCount).map(getLastDigit),
    [prices, tickCount],
  )
  const total = digits.length

  const digitCounts = useMemo(() => {
    const c = Array(10).fill(0)
    digits.forEach(d => c[d]++)
    return c as number[]
  }, [digits])

  const ranked = useMemo(
    () => digitCounts.map((c, d) => ({ d, c })).sort((a, b) => b.c - a.c),
    [digitCounts],
  )
  const highest    = ranked[0]?.d  ?? -1
  const secondHigh = ranked[1]?.d  ?? -1
  const lowest     = ranked[ranked.length - 1]?.d  ?? -1
  const secondLow  = ranked[ranked.length - 2]?.d  ?? -1
  const lastDigit  = digits.length ? digits[digits.length - 1] : null

  /* Over / Under */
  const ouData = useMemo(() => {
    const over  = digits.filter(d => d > ouBarrier).length
    const under = digits.filter(d => d <= ouBarrier).length
    const seq   = digits.slice(-50).map(d => d > ouBarrier ? 'O' : 'U')
    const { count, val } = trailingStreak(seq)
    return { over, under, seq, streak: count, streakLabel: val === 'O' ? 'Over' : 'Under' }
  }, [digits, ouBarrier])

  /* Match / Differ */
  const mdData = useMemo(() => {
    const match  = digits.filter(d => d === mdDigit).length
    const differ = digits.filter(d => d !== mdDigit).length
    const seq    = digits.slice(-50).map(d => d === mdDigit ? 'M' : 'D')
    const { count, val } = trailingStreak(seq)
    return { match, differ, seq, streak: count, streakLabel: val === 'M' ? 'Match' : 'Differ' }
  }, [digits, mdDigit])

  /* Even / Odd */
  const eoData = useMemo(() => {
    const even = digits.filter(d => d % 2 === 0).length
    const odd  = digits.filter(d => d % 2 !== 0).length
    const seq  = digits.slice(-50).map(d => d % 2 === 0 ? 'E' : 'O')
    const { count, val } = trailingStreak(seq)
    return { even, odd, seq, streak: count, streakLabel: val === 'E' ? 'Even' : 'Odd' }
  }, [digits])

  /* Rise / Fall */
  const rfData = useMemo(() => {
    const slice = prices.slice(-tickCount)
    let rise = 0, fall = 0
    const seq: string[] = []
    for (let i = 1; i < slice.length; i++) {
      if (slice[i] > slice[i - 1])      { rise++; seq.push('R') }
      else if (slice[i] < slice[i - 1]) { fall++; seq.push('F') }
    }
    const recent = seq.slice(-50)
    const { count, val } = trailingStreak(recent)
    return { rise, fall, seq: recent, streak: count, streakLabel: val === 'R' ? 'Rise' : 'Fall', total: rise + fall }
  }, [prices, tickCount])

  /* Circle styling */
  function circleStyle(digit: number): React.CSSProperties {
    let bg = '#0d1524', border = '2px solid rgba(252,163,17,0.12)', color = 'rgba(229,229,229,0.65)'
    if      (digit === highest)    { bg = '#FCA311'; border = '2px solid #FCA311'; color = '#000' }
    else if (digit === secondHigh) { bg = 'rgba(252,163,17,0.2)'; border = '2px solid rgba(252,163,17,0.5)'; color = '#FCA311' }
    else if (digit === lowest)     { bg = 'rgba(239,68,68,0.22)'; border = '2px solid #ef4444'; color = '#ef4444' }
    else if (digit === secondLow)  { bg = 'rgba(239,68,68,0.1)'; border = '2px solid rgba(239,68,68,0.4)'; color = 'rgba(239,68,68,0.85)' }
    if (digit === lastDigit)       { border = '3px solid #fff' }
    return { background: bg, border, color } as React.CSSProperties
  }

  const ouColors = {
    O: { bg: 'rgba(34,197,94,0.15)',    border: '#22c55e',  text: '#22c55e' },
    U: { bg: 'rgba(59,130,246,0.15)',   border: '#3b82f6',  text: '#3b82f6' },
  }
  const mdColors = {
    M: { bg: 'rgba(239,68,68,0.15)',    border: '#ef4444',  text: '#ef4444' },
    D: { bg: 'rgba(168,85,247,0.15)',   border: '#a855f7',  text: '#a855f7' },
  }
  const eoColors = {
    E: { bg: 'rgba(252,163,17,0.15)',   border: 'var(--gold)', text: 'var(--gold)' },
    O: { bg: 'rgba(239,68,68,0.15)',    border: '#ef4444',  text: '#ef4444' },
  }
  const rfColors = {
    R: { bg: 'rgba(34,197,94,0.15)',    border: '#22c55e',  text: '#22c55e' },
    F: { bg: 'rgba(239,68,68,0.15)',    border: '#ef4444',  text: '#ef4444' },
  }

  /* ── Render ── */
  return (
    <div style={{ background: '#000', minHeight: '100%', display: 'flex', flexDirection: 'column', paddingBottom: '48px' }}>

      {/* ── Circles / Scanner toggle ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        {(['circles', 'scanner'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              flex: 1, padding: '0.65rem',
              fontSize: '0.82rem', fontWeight: 700,
              cursor: 'pointer', border: 'none',
              background: activeTab === t ? 'rgba(252,163,17,0.12)' : '#050505',
              color: activeTab === t ? 'var(--gold)' : 'rgba(229,229,229,0.4)',
              borderBottom: activeTab === t ? '2px solid var(--gold)' : '2px solid transparent',
              textTransform: 'capitalize', transition: 'all 0.15s',
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'scanner' ? (
        <ScannerView />
      ) : (
        <>
          {/* ── Top controls ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '1rem',
            padding: '0.75rem 1.25rem',
            borderBottom: '1px solid var(--border)',
            background: '#050505', flexWrap: 'wrap',
          }}>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              style={{
                background: '#0d0d0d', border: '1px solid var(--border)',
                color: '#fff', padding: '0.4rem 0.75rem',
                borderRadius: '8px', fontSize: '0.82rem', cursor: 'pointer',
                minWidth: '200px',
              }}
            >
              {MARKETS.map(m => (
                <option key={m.symbol} value={m.symbol}>{m.label}</option>
              ))}
            </select>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'rgba(229,229,229,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Ticks
              </label>
              <input
                type="number"
                value={tickCount}
                min={10}
                max={MAX_HISTORY}
                onChange={e => setTickCount(Math.min(MAX_HISTORY, Math.max(10, parseInt(e.target.value) || 1000)))}
                style={{
                  width: '80px', background: '#0d0d0d', border: '1px solid var(--border)',
                  color: '#fff', padding: '0.4rem 0.5rem',
                  borderRadius: '8px', fontSize: '0.82rem', textAlign: 'center',
                }}
              />
            </div>

            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Live Price
              </div>
              <div style={{
                fontSize: '1.1rem', fontWeight: 800, color: '#ef4444',
                fontVariantNumeric: 'tabular-nums',
                animation: livePrice ? 'priceFlash 0.3s ease' : 'none',
              }}>
                {livePrice?.toFixed(2) ?? '—'}
              </div>
            </div>
          </div>

          {/* ── Digit circles ── */}
          <div style={{ padding: '1.25rem 1rem 0.75rem', borderBottom: '1px solid var(--border)', background: '#020c1a' }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '1rem', fontSize: '0.78rem', color: 'rgba(229,229,229,0.35)' }}>
                Loading {tickCount} ticks for {MARKETS.find(m => m.symbol === symbol)?.label ?? symbol}…
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'center', gap: '0.55rem', flexWrap: 'wrap' }}>
                {DIGITS.map(d => {
                  const cs = circleStyle(d)
                  const pctVal = total ? ((digitCounts[d] / total) * 100).toFixed(1) : '0.0'
                  return (
                    <div key={d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                      <div style={{
                        width: '54px', height: '54px', borderRadius: '50%',
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.35s ease',
                        ...cs,
                      }}>
                        <span style={{ fontSize: '1.05rem', fontWeight: 800, lineHeight: 1 }}>{d}</span>
                        <span style={{ fontSize: '0.58rem', opacity: 0.85, marginTop: '1px' }}>{pctVal}%</span>
                      </div>
                      <span style={{
                        fontSize: '0.6rem', height: '10px',
                        color: 'var(--gold)', visibility: d === lastDigit ? 'visible' : 'hidden',
                      }}>▲</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── 4 Analysis cards ── */}
          {!loading && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '1px',
              background: 'var(--border)',
              flex: 1,
            }}>
              <Card title="Over / Under" streak={ouData.streak} streakLabel={ouData.streakLabel}>
                <DigitPicker selected={ouBarrier} onSelect={setOuBarrier} />
                <Bar label="Over"  color="#22c55e" count={ouData.over}  total={total} />
                <Bar label="Under" color="#3b82f6" count={ouData.under} total={total} />
                <Sequence seq={ouData.seq.slice(-10)} colorMap={ouColors} />
              </Card>

              <Card title="Match / Differ" streak={mdData.streak} streakLabel={mdData.streakLabel}>
                <DigitPicker selected={mdDigit} onSelect={setMdDigit} />
                <Bar label="Match"  color="#ef4444" count={mdData.match}  total={total} />
                <Bar label="Differ" color="#a855f7" count={mdData.differ} total={total} />
                <Sequence seq={mdData.seq.slice(-10)} colorMap={mdColors} />
              </Card>

              <Card title="Even / Odd" streak={eoData.streak} streakLabel={eoData.streakLabel}>
                <Bar label="Even" color="#FCA311" count={eoData.even} total={total} />
                <Bar label="Odd"  color="#ef4444" count={eoData.odd}  total={total} />
                <Sequence seq={eoData.seq.slice(-10)} colorMap={eoColors} />
              </Card>

              <Card title="Rise / Fall" streak={rfData.streak} streakLabel={rfData.streakLabel}>
                <Bar label="Rise" color="#22c55e" count={rfData.rise} total={rfData.total} />
                <Bar label="Fall" color="#ef4444" count={rfData.fall} total={rfData.total} />
                <Sequence seq={rfData.seq.slice(-10)} colorMap={rfColors} />
              </Card>
            </div>
          )}
        </>
      )}

      {/* ── Run Panel (right-side drawer) ── */}
      <RunPanel
        open={runOpen}
        onToggle={() => setRunOpen(o => !o)}
        running={running}
        stats={runStats}
        onReset={handleReset}
        contractType={contractType}
        setContractType={setContractType}
        stake={stake}
        setStake={setStake}
        barrier={barrier}
        setBarrier={setBarrier}
        botReady={botReady}
        botError={botError}
        currency={currency}
        txLog={txLog}
      />

      {/* ── Run Bar (sticky bottom) ── */}
      <RunBar
        running={running}
        onToggleRun={() => setRunning(r => !r)}
        speed={execSpeed}
        onCycleSpeed={cycleSpeed}
        disabled={!botReady}
      />

      <style>{`
        @keyframes priceFlash {
          0%   { opacity: 0.5; transform: scale(1.06); }
          100% { opacity: 1;   transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
