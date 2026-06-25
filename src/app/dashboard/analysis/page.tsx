'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

/* ─── Constants ─────────────────────────────────────────── */
const WS_URL      = 'wss://ws.binaryws.com/websockets/v3?app_id=1089'
// Bot WS URL is now fetched via /api/user/ws-url (OTP-authenticated)
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

function EmptyBoxIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
      <path d="M10 20L28 11L46 20V36L28 45L10 36V20Z" stroke="rgba(229,229,229,0.2)" strokeWidth="1.5"/>
      <path d="M10 20L28 29L46 20" stroke="rgba(229,229,229,0.2)" strokeWidth="1.5"/>
      <path d="M28 29V45" stroke="rgba(229,229,229,0.2)" strokeWidth="1.5"/>
    </svg>
  )
}

function RunPanel({
  open,
  onToggle,
  running,
  stats,
  onReset,
  contractType,
  setContractType,
  stake,
  setStake,
  barrier,
  setBarrier,
  botReady,
  botError,
  currency,
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

  const inputStyle: React.CSSProperties = {
    background: '#0a0f1a', border: '1px solid var(--border)',
    borderRadius: '8px', color: '#fff', fontSize: '0.78rem',
    padding: '0.35rem 0.6rem', width: '100%', outline: 'none',
  }

  function downloadCSV() {
    if (!txLog.length) return
    const rows = [
      ['Contract ID','Time','Type','Symbol','Stake','Payout','P/L','Result'],
      ...txLog.map(tx => [
        tx.id, new Date(tx.time).toISOString(), tx.contractType, tx.symbol,
        tx.stake.toFixed(2), tx.payout.toFixed(2), (tx.payout - tx.stake).toFixed(2),
        tx.won ? 'Won' : 'Lost',
      ]),
    ]
    const url = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'lima-trade-log.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  /* Stats always shown pinned to bottom — 3×2 grid */
  const statRows = [
    [
      { label: 'Total stake',   value: `${stats.totalStake.toFixed(2)} ${currency}`,  color: '#fff' },
      { label: 'Total payout',  value: `${stats.totalPayout.toFixed(2)} ${currency}`, color: '#fff' },
      { label: 'No. of runs',   value: String(stats.runs), color: '#fff' },
    ],
    [
      { label: 'Contracts lost',     value: String(stats.lost), color: stats.lost  > 0 ? '#ef4444' : '#fff' },
      { label: 'Contracts won',      value: String(stats.won),  color: stats.won   > 0 ? '#22c55e' : '#fff' },
      {
        label: 'Total profit/loss',
        value: `${stats.profit.toFixed(2)} ${currency}`,
        color: stats.profit > 0 ? '#22c55e' : stats.profit < 0 ? '#ef4444' : '#fff',
      },
    ],
  ]

  return (
    <div style={{
      position: 'fixed', right: 0, top: '56px', bottom: '48px',
      width: '340px',
      transform: open ? 'translateX(0)' : 'translateX(340px)',
      transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
      zIndex: 60,
      background: '#07111e',
      borderLeft: '1px solid rgba(255,255,255,0.08)',
      display: 'flex', flexDirection: 'column',
      boxShadow: open ? '-12px 0 40px rgba(0,0,0,0.7)' : 'none',
    }}>

      {/* Toggle handle */}
      <button
        onClick={onToggle}
        aria-label={open ? 'Close run panel' : 'Open run panel'}
        style={{
          position: 'absolute', left: '-22px', top: '50%', transform: 'translateY(-50%)',
          width: '22px', height: '52px', background: '#07111e',
          border: '1px solid rgba(255,255,255,0.08)', borderRight: 'none',
          borderRadius: '8px 0 0 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(229,229,229,0.45)', padding: 0,
        }}
      >
        <svg width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {open
            ? <><polyline points="7,4 11,9 7,14"/><polyline points="2,4 6,9 2,14"/></>
            : <><polyline points="5,4 1,9 5,14"/><polyline points="10,4 6,9 10,14"/></>}
        </svg>
      </button>

      {/* Tab bar */}
      <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '0.8rem 0',
              fontSize: '0.8rem', fontWeight: tab === t ? 700 : 500,
              cursor: 'pointer', border: 'none', background: 'transparent',
              color: tab === t ? '#fff' : 'rgba(229,229,229,0.4)',
              borderBottom: tab === t ? '2px solid #fff' : '2px solid transparent',
              textTransform: 'capitalize', transition: 'color 0.15s',
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>

        {/* ═══ SUMMARY ═══ */}
        {tab === 'summary' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '1rem' }}>

            {/* Connection badge */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem',
              padding: '0.4rem 0.65rem', borderRadius: '8px',
              background: botError ? 'rgba(239,68,68,0.1)' : botReady ? 'rgba(34,197,94,0.07)' : 'rgba(252,163,17,0.07)',
              border: `1px solid ${botError ? 'rgba(239,68,68,0.2)' : botReady ? 'rgba(34,197,94,0.18)' : 'rgba(252,163,17,0.18)'}`,
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                background: botError ? '#ef4444' : botReady ? '#22c55e' : '#FCA311',
                boxShadow: botReady && !botError ? '0 0 6px #22c55e66' : 'none',
              }}/>
              <span style={{ fontSize: '0.68rem', color: 'rgba(229,229,229,0.55)' }}>
                {botError ?? (botReady ? `Connected · ${currency}` : 'Connecting to Deriv…')}
              </span>
            </div>

            {/* Bot config */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.6rem', fontWeight: 600, color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                  Contract Type
                </label>
                <select value={contractType} onChange={e => setContractType(e.target.value)} disabled={running}
                  style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'pointer' }}>
                  {CONTRACT_TYPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '0.6rem', fontWeight: 600, color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                    Stake ({currency})
                  </label>
                  <input type="number" min="0.35" step="0.01" value={stake} onChange={e => setStake(e.target.value)}
                    disabled={running} style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'text' }} />
                </div>
                {needsBarrier(contractType) && (
                  <div style={{ width: '70px' }}>
                    <label style={{ display: 'block', fontSize: '0.6rem', fontWeight: 600, color: 'rgba(229,229,229,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                      Digit
                    </label>
                    <select value={barrier} onChange={e => setBarrier(e.target.value)} disabled={running}
                      style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'pointer' }}>
                      {DIGITS.map(d => <option key={d} value={String(d)}>{d}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Empty state */}
            {stats.runs === 0 && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
                <p style={{ color: 'rgba(229,229,229,0.6)', fontSize: '0.85rem', lineHeight: 1.65, textAlign: 'center', margin: 0 }}>
                  When you&apos;re ready to trade, hit <strong style={{ color: '#fff' }}>Run</strong>.<br/>
                  You&apos;ll be able to track your bot&apos;s performance here.
                </p>
              </div>
            )}

            {/* Running indicator */}
            {running && stats.runs > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.5rem 0.75rem', borderRadius: '8px',
                background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.15)',
              }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', flexShrink: 0, animation: 'pulse 1.5s infinite' }}/>
                <span style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.55)' }}>
                  Bot running · {stats.runs} contract{stats.runs !== 1 ? 's' : ''} placed
                </span>
              </div>
            )}
          </div>
        )}

        {/* ═══ TRANSACTIONS ═══ */}
        {tab === 'transactions' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>

            {/* Action bar */}
            <div style={{ display: 'flex', gap: '0.5rem', padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['Download', 'View Detail'].map(btn => (
                <button
                  key={btn}
                  onClick={btn === 'Download' ? downloadCSV : undefined}
                  disabled={txLog.length === 0}
                  style={{
                    padding: '0.4rem 0.9rem', borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.15)', background: 'transparent',
                    color: txLog.length === 0 ? 'rgba(229,229,229,0.2)' : 'rgba(229,229,229,0.7)',
                    fontSize: '0.78rem', fontWeight: 600,
                    cursor: txLog.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {btn}
                </button>
              ))}
            </div>

            {txLog.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1.5rem', textAlign: 'center' }}>
                <EmptyBoxIcon />
                <p style={{ color: 'rgba(229,229,229,0.7)', fontWeight: 600, fontSize: '0.88rem', margin: '1rem 0 0.4rem' }}>
                  There are no transactions to display
                </p>
                <p style={{ color: 'rgba(229,229,229,0.38)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                  Here are the possible reasons:
                </p>
                {['The bot is not running', 'The stats are cleared'].map(r => (
                  <div key={r} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                    <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'rgba(229,229,229,0.3)', flexShrink: 0 }}/>
                    <span style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.38)' }}>{r}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {/* Column headers */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                  padding: '0.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)',
                  position: 'sticky', top: 0, background: '#07111e',
                }}>
                  {['Type', 'Entry/Exit spot', 'Buy price and P/L'].map(h => (
                    <span key={h} style={{ fontSize: '0.63rem', fontWeight: 700, color: 'rgba(229,229,229,0.4)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {h}
                    </span>
                  ))}
                </div>

                {txLog.map(tx => {
                  const pl = tx.payout - tx.stake
                  return (
                    <div key={tx.id}
                      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', alignItems: 'center', padding: '0.65rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
                      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'}
                      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                    >
                      <div>
                        <div style={{ fontSize: '0.72rem', fontWeight: 600, color: tx.won ? '#22c55e' : '#ef4444' }}>
                          {tx.won ? 'Won' : 'Lost'}
                        </div>
                        <div style={{ fontSize: '0.62rem', color: 'rgba(229,229,229,0.35)', marginTop: '2px', lineHeight: 1.3 }}>
                          {CONTRACT_TYPES.find(c => c.value === tx.contractType)?.label?.split('→')[1]?.trim() ?? tx.contractType}
                        </div>
                        <div style={{ fontSize: '0.58rem', color: 'rgba(229,229,229,0.2)', marginTop: '1px' }}>
                          {fmtTime(tx.time)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'rgba(229,229,229,0.55)' }}>{tx.symbol}</div>
                        <div style={{ fontSize: '0.6rem', color: 'rgba(229,229,229,0.25)', marginTop: '2px' }}>1 tick · digit</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.7)', fontVariantNumeric: 'tabular-nums' }}>
                          {tx.stake.toFixed(2)} {currency}
                        </div>
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: pl >= 0 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums', marginTop: '2px' }}>
                          {pl >= 0 ? '+' : ''}{pl.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══ JOURNAL ═══ */}
        {tab === 'journal' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>

            {/* Action bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <button
                onClick={downloadCSV}
                disabled={txLog.length === 0}
                style={{
                  padding: '0.4rem 0.9rem', borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.15)', background: 'transparent',
                  color: txLog.length === 0 ? 'rgba(229,229,229,0.2)' : 'rgba(229,229,229,0.7)',
                  fontSize: '0.78rem', fontWeight: 600,
                  cursor: txLog.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                Download
              </button>
              <button style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(229,229,229,0.5)', fontSize: '0.78rem', fontWeight: 500 }}>
                Filters
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
                </svg>
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {/* Account info — always first */}
              <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.65)' }}>
                  You are using your {currency} account.
                </div>
                <div style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.28)', marginTop: '3px' }}>
                  {new Date().toISOString().slice(0, 10)} | {new Date().toISOString().slice(11, 19)} GMT
                </div>
              </div>

              {txLog.length === 0 ? (
                <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'rgba(229,229,229,0.3)', fontSize: '0.78rem', lineHeight: 1.6 }}>
                  No events yet. Start the bot to see activity here.
                </div>
              ) : (
                txLog.map((tx, i) => (
                  <div key={i} style={{ padding: '0.55rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <div style={{ fontSize: '0.75rem', color: tx.won ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.8)', fontWeight: 600 }}>
                      Contract #{tx.id} — {tx.won ? 'Won' : 'Lost'} {Math.abs(tx.payout - tx.stake).toFixed(2)} {currency}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(229,229,229,0.3)', marginTop: '2px' }}>
                      {new Date(tx.time).toISOString().slice(0, 10)} | {new Date(tx.time).toISOString().slice(11, 19)} GMT · {tx.symbol} · Stake {tx.stake.toFixed(2)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════
          PINNED BOTTOM — Stats + Reset
          Same on every tab (matches Deriv UI)
      ══════════════════════════════════════ */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', background: '#07111e', flexShrink: 0 }}>

        {/* "What's this?" */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0.5rem 1rem 0' }}>
          <a href="https://deriv.com/help-centre/" target="_blank" rel="noopener noreferrer"
            style={{ fontSize: '0.63rem', color: 'rgba(229,229,229,0.28)', textDecoration: 'underline', cursor: 'pointer' }}>
            What&apos;s this?
          </a>
        </div>

        {/* Stats grid — 3 × 2 */}
        <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
          {statRows.map((row, ri) => (
            <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', marginBottom: ri === 0 ? '0.75rem' : 0 }}>
              {row.map(s => (
                <div key={s.label}>
                  <div style={{ fontSize: '0.63rem', fontWeight: 600, color: 'rgba(229,229,229,0.42)', marginBottom: '0.18rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.label}
                  </div>
                  <div style={{ fontSize: '0.78rem', fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Reset */}
        <div style={{ padding: '0 0.75rem 0.75rem' }}>
          <button
            onClick={onReset}
            style={{
              width: '100%', padding: '0.72rem',
              borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent', color: 'rgba(229,229,229,0.65)',
              fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
              letterSpacing: '0.03em', transition: 'background 0.15s, color 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'rgba(255,255,255,0.07)'; b.style.color = '#fff'; b.style.borderColor = 'rgba(255,255,255,0.35)' }}
            onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'transparent'; b.style.color = 'rgba(229,229,229,0.65)'; b.style.borderColor = 'rgba(255,255,255,0.2)' }}
          >
            Reset
          </button>
        </div>
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
      justifyContent: 'center',
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
  const runningRef      = useRef(false)
  const contractTypeRef = useRef('DIGITEVEN')
  const stakeRef        = useRef('1.00')
  const barrierRef      = useRef('5')
  const symbolRef       = useRef('1HZ100V')
  const execSpeedRef    = useRef<ExecSpeed>('normal')
  const currencyRef     = useRef('USD')
  const botWsRef        = useRef<WebSocket | null>(null)
  /** Maps contract_id → buy_price for bot trades we initiated */
  const pendingBuysRef  = useRef<Map<number, number>>(new Map())
  const reqIdRef        = useRef(200)
  /** Auto-reconnect: attempt count + backoff timer */
  const reconnectCount  = useRef(0)
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Set to true when user explicitly closes (logout/unmount) — skip reconnect */
  const intentionalClose = useRef(false)

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
        contract_type:     ct,
        underlying_symbol: symbolRef.current,
        duration:          1,
        duration_unit:     't',
        amount,
        basis:    'stake',
        currency: currencyRef.current,
        ...(hasBar ? { barrier: barrierRef.current } : {}),
      },
    }))
  }, [])

  /* ── Bot WebSocket lifecycle with auto-reconnect ── */
  useEffect(() => {
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    intentionalClose.current = false

    /* Backoff schedule: 2s, 4s, 8s, 16s, 30s (capped) */
    function backoffDelay(attempt: number) {
      return Math.min(2000 * Math.pow(2, attempt), 30_000)
    }

    async function connect() {
      setBotError(null)
      setBotReady(false)

      /* ── Get OTP-authenticated WS URL from server ── */
      let wsUrl = ''
      try {
        const res = await fetch('/api/user/ws-url')
        if (!res.ok) {
          if (res.status === 401) {
            intentionalClose.current = true
            window.location.href = '/'
            return
          }
          setBotError('Failed to get WS URL — retrying…')
          scheduleReconnect()
          return
        }
        ;({ wsUrl } = await res.json() as { wsUrl: string })
      } catch {
        setBotError('Network error — retrying…')
        scheduleReconnect()
        return
      }

      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0
        setBotError(null)
        /* New Deriv API: connection is already authenticated via OTP in URL.
           Subscribe to transaction stream immediately. */
        ws!.send(JSON.stringify({ transaction: 1, subscribe: 1 }))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }))
        }, 30_000)
        setBotReady(true)
        if (runningRef.current) executeTrade(ws!)
      }

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }

        if (msg.error) {
          const err = msg.error as { message: string; code?: string }
          /* Token expired — hard stop, don't retry */
          if (err.code === 'AuthorizationRequired' || err.code === 'InvalidToken') {
            intentionalClose.current = true
            setBotError('Session expired. Please log in again.')
            setRunning(false)
            runningRef.current = false
            return
          }
          setBotError(err.message)
          setRunning(false)
          runningRef.current = false
          return
        }

        /* ── buy response ── */
        if (msg.msg_type === 'buy') {
          const buy = msg.buy as { contract_id: number; buy_price: number }
          pendingBuysRef.current.set(buy.contract_id, buy.buy_price)
          setRunStats(prev => ({
            ...prev,
            totalStake: prev.totalStake + buy.buy_price,
            runs: prev.runs + 1,
          }))
        }

        /* ── transaction stream ── */
        if (msg.msg_type === 'transaction') {
          const tx = msg.transaction as {
            action: string
            amount: number
            contract_id?: number
            currency: string
          }

          if (tx.action === 'sell' && tx.contract_id != null) {
            const buyPrice = pendingBuysRef.current.get(tx.contract_id)
            if (buyPrice === undefined) return

            pendingBuysRef.current.delete(tx.contract_id)
            const sellAmount = Math.max(0, tx.amount)
            const won = sellAmount > 0

            setRunStats(prev => {
              const newPayout = prev.totalPayout + sellAmount
              return {
                ...prev,
                totalPayout: newPayout,
                won:    won ? prev.won + 1 : prev.won,
                lost:   won ? prev.lost    : prev.lost + 1,
                profit: newPayout - prev.totalStake,
              }
            })

            setTxLog(prev => [{
              id:           tx.contract_id!,
              time:         Date.now(),
              contractType: contractTypeRef.current,
              stake:        buyPrice,
              payout:       sellAmount,
              won,
              symbol:       symbolRef.current,
            }, ...prev].slice(0, 100))

            if (runningRef.current && ws?.readyState === WebSocket.OPEN) {
              const delay =
                execSpeedRef.current === 'turbo' ? 500 :
                execSpeedRef.current === 'fast'  ? 1500 : 3000
              setTimeout(() => {
                if (runningRef.current && ws?.readyState === WebSocket.OPEN) executeTrade(ws!)
              }, delay)
            }
          }
        }
      }

      ws.onerror = () => {
        /* onerror is always followed by onclose — handle reconnect there */
      }

      ws.onclose = (ev) => {
        setBotReady(false)
        botWsRef.current = null
        if (ping) { clearInterval(ping); ping = null }

        /* Stop bot so it doesn't try to trade on a dead socket */
        if (runningRef.current) {
          setRunning(false)
          runningRef.current = false
        }

        if (!intentionalClose.current) {
          /* Abnormal close — reconnect with backoff */
          const attempt = reconnectCount.current++
          const delay   = backoffDelay(attempt)
          setBotError(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s… (attempt ${attempt + 1})`)
          scheduleReconnect(delay)
        }
      }
    }

    function scheduleReconnect(delay = 2000) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => {
        if (!intentionalClose.current) connect()
      }, delay)
    }

    connect()

    return () => {
      intentionalClose.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
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
                <Sequence seq={ouData.seq.slice(-20)} colorMap={ouColors} />
              </Card>

              <Card title="Match / Differ" streak={mdData.streak} streakLabel={mdData.streakLabel}>
                <DigitPicker selected={mdDigit} onSelect={setMdDigit} />
                <Bar label="Match"  color="#ef4444" count={mdData.match}  total={total} />
                <Bar label="Differ" color="#a855f7" count={mdData.differ} total={total} />
                <Sequence seq={mdData.seq.slice(-20)} colorMap={mdColors} />
              </Card>

              <Card title="Even / Odd" streak={eoData.streak} streakLabel={eoData.streakLabel}>
                <Bar label="Even" color="#FCA311" count={eoData.even} total={total} />
                <Bar label="Odd"  color="#ef4444" count={eoData.odd}  total={total} />
                <Sequence seq={eoData.seq.slice(-20)} colorMap={eoColors} />
              </Card>

              <Card title="Rise / Fall" streak={rfData.streak} streakLabel={rfData.streakLabel}>
                <Bar label="Rise" color="#22c55e" count={rfData.rise} total={rfData.total} />
                <Bar label="Fall" color="#ef4444" count={rfData.fall} total={rfData.total} />
                <Sequence seq={rfData.seq.slice(-20)} colorMap={rfColors} />
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
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.35; }
        }
      `}</style>
    </div>
  )
}
