'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { bg0, bg1, bg2, bdr, txt0, txt1, txt2 } from '@/lib/colors'

/* ─── Constants ─────────────────────────────────────────── */
// New Deriv API public WebSocket — no auth/OTP needed for market data
// Source: https://developers.deriv.com/docs/options/websocket/
const WS_URL      = 'wss://api.derivws.com/trading/v1/options/ws/public'
// Bot WS URL is fetched via /api/user/ws-url (OTP-authenticated for trading)
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

/** Quick lookup: raw symbol → human-readable label */
const SYMBOL_LABEL: Record<string, string> = Object.fromEntries(
  MARKETS.map(m => [m.symbol, m.label])
)
function symLabel(s: string) { return SYMBOL_LABEL[s] ?? s }

/* ─── Helpers ───────────────────────────────────────────── */
/**
 * Extract the last digit of a price using the market's pip_size.
 * pip_size is returned in every tick and history response by Deriv
 * (ticks_response.schema.json marks it as required).
 * Defaults to 2 which covers all current synthetic indices.
 */
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
        background: bg2,
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
        color: txt1, textAlign: 'right',
        fontVariantNumeric: 'tabular-nums', flexShrink: 0,
      }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}

interface SeqColor { bg: string; border: string; text: string }
/**
 * Sequence — scrolling row of colored digit boxes.
 *
 * Flash tracking (v28):
 *   atTickN  = tickNRef.current at the exact moment the exit tick lands on the public WS.
 *   tickN    = current monotonic tick counter (incremented on every public WS tick).
 *   elapsed  = tickN - atTickN  →  how many ticks have arrived since settlement.
 *   flashIdx = seq.length - 1 - elapsed  →  the settlement digit's current position.
 *
 * The glow naturally moves left one box per tick and disappears when flashIdx < 0
 * (box has scrolled off the visible window).  No extra timers needed for movement —
 * React re-renders on every tickN change and recomputes the position automatically.
 */
function Sequence({ seq, colorMap, rawDigits, flash, tickN }: {
  seq: string[]
  colorMap: Record<string, SeqColor>
  rawDigits?: number[]    // actual last digit at each position — displayed instead of the label
  flash?: { won: boolean; atTickN: number } | null
  tickN?: number          // current monotonic tick counter — drives glow position
}) {
  // Compute which box index the settlement digit is currently at.
  // elapsed=0 → last box (just settled). elapsed=1 → second-to-last, etc.
  const flashIdx = (flash != null && tickN != null)
    ? (seq.length - 1 - (tickN - flash.atTickN))
    : -1

  return (
    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
      {seq.map((s, i) => {
        const c = colorMap[s] ?? { bg: bg1, border: bdr, text: txt1 }
        const isFlashing = flash != null && i === flashIdx
        // Fade glow slightly as it ages (1 = fresh, dims after 3 ticks but still visible)
        const elapsed    = flash != null && tickN != null ? (tickN - flash.atTickN) : 0
        const opacity    = isFlashing ? Math.max(0.4, 1 - elapsed * 0.15) : 1
        const flashWon   = isFlashing && flash!.won
        const display    = rawDigits != null ? String(rawDigits[i] ?? s) : s
        return (
          <div key={i} style={{
            width: '26px', height: '26px', borderRadius: '6px',
            fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isFlashing
              ? (flashWon ? `rgba(34,197,94,${0.45 * opacity})` : `rgba(239,68,68,${0.45 * opacity})`)
              : c.bg,
            border: isFlashing
              ? `2px solid ${flashWon ? '#22c55e' : '#ef4444'}`
              : `1.5px solid ${c.border}`,
            color: isFlashing ? '#fff' : c.text,
            transform: isFlashing ? 'scale(1.22)' : 'scale(1)',
            boxShadow: isFlashing
              ? (flashWon
                  ? `0 0 12px 4px rgba(34,197,94,${0.55 * opacity})`
                  : `0 0 12px 4px rgba(239,68,68,${0.55 * opacity})`)
              : 'none',
            // No CSS transition on transform/boxShadow — the box itself doesn't move,
            // only which box is highlighted changes per-tick. CSS transition would cause
            // the old box to fade out while new box fades in, creating the shift glitch.
            transition: 'background 0.15s ease, border-color 0.15s ease',
            position: 'relative',
            zIndex: isFlashing ? 2 : undefined,
          }}>
            {display}
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
    <div style={{ background: bg1, padding: '1rem 1.25rem' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '0.9rem',
      }}>
        <span style={{ fontSize: '0.84rem', fontWeight: 700, color: txt0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
            border: `1.5px solid ${selected === d ? 'var(--gold)' : bdr}`,
            background: selected === d ? 'rgba(252,163,17,0.18)' : 'transparent',
            color: selected === d ? 'var(--gold)' : txt1,
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
  id: number           // contract_id
  time: number         // epoch ms
  contractType: string
  stake: number
  payout: number
  potentialPayout: number  // potential payout at buy time
  won: boolean
  symbol: string
  entrySpot?: number   // live price at moment of trade entry
  exitSpot?:  number   // real settlement tick from proposal_open_contract (set after sell)
  longcode?:  string   // human-readable contract description from Deriv
  pending?:   boolean  // true while contract is still in-flight (buy sent, sell not yet received)
}

/* ─── Run Panel ─────────────────────────────────────────── */
type RunTab = 'summary' | 'transactions' | 'journal'

function EmptyBoxIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
      <path d="M10 20L28 11L46 20V36L28 45L10 36V20Z" stroke="var(--txt2)" strokeWidth="1.5"/>
      <path d="M10 20L28 29L46 20" stroke="var(--txt2)" strokeWidth="1.5"/>
      <path d="M28 29V45" stroke="var(--txt2)" strokeWidth="1.5"/>
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
  pipSize,
  barrier,
  setBarrier,
  botReady,
  botError,
  currency,
  accountLabel,
  txLog,
  onViewDetail,
  lastContractSummary,
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
  accountLabel: string
  txLog: TxEntry[]
  onViewDetail: () => void
  lastContractSummary: { symbol: string; contractType: string; stake: number; potentialPayout: number } | null
  pipSize: number
}) {
  const [tab, setTab] = useState<RunTab>('summary')
  const TABS: RunTab[] = ['summary', 'transactions', 'journal']

  const inputStyle: React.CSSProperties = {
    background: bg1, border: `1px solid ${bdr}`,
    borderRadius: '8px', color: txt0, fontSize: '0.78rem',
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
      { label: 'Total stake',   value: `${stats.totalStake.toFixed(2)} ${currency}`,  color: txt0 },
      { label: 'Total payout',  value: `${stats.totalPayout.toFixed(2)} ${currency}`, color: txt0 },
      { label: 'No. of runs',   value: String(stats.runs), color: txt0 },
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
      position: 'fixed', right: 0, top: '100px', bottom: '48px',
      width: '340px',
      transform: open ? 'translateX(0)' : 'translateX(340px)',
      transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
      zIndex: 60,
      background: bg1,
      borderLeft: `1px solid ${bdr}`,
      display: 'flex', flexDirection: 'column',
      boxShadow: open ? '-12px 0 40px rgba(0,0,0,0.7)' : 'none',
    }}>

      {/* Toggle handle */}
      <button
        onClick={onToggle}
        aria-label={open ? 'Close run panel' : 'Open run panel'}
        style={{
          position: 'absolute', left: '-22px', top: '50%', transform: 'translateY(-50%)',
          width: '22px', height: '52px', background: bg1,
          border: `1px solid ${bdr}`, borderRight: 'none',
          borderRadius: '8px 0 0 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: open ? txt2 : 'rgba(252,163,17,0.85)', padding: 0,
          overflow: 'visible',
        }}
      >
        <svg
          width="12" height="18" viewBox="0 0 12 18"
          fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round"
          style={!open ? { animation: 'panelNudge 2.4s ease-in-out infinite' } : undefined}
        >
          {open
            ? <><polyline points="7,4 11,9 7,14"/><polyline points="2,4 6,9 2,14"/></>
            : <><polyline points="5,4 1,9 5,14"/><polyline points="10,4 6,9 10,14"/></>}
        </svg>
      </button>
      <style>{`
        @keyframes panelNudge {
          0%,55%,100% { transform: translateX(0); }
          65%          { transform: translateX(-4px); }
          75%          { transform: translateX(-1px); }
          85%          { transform: translateX(-3px); }
          95%          { transform: translateX(0); }
        }
      `}</style>

      {/* Tab bar */}
      <div style={{ display: 'flex', flexShrink: 0, borderBottom: `1px solid ${bdr}` }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '0.8rem 0',
              fontSize: '0.8rem', fontWeight: tab === t ? 700 : 500,
              cursor: 'pointer', border: 'none', background: 'transparent',
              color: tab === t ? '#fff' : txt2,
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

            {/* Last contract summary */}
            {lastContractSummary && (
              <div style={{
                background: 'var(--bg2)', border: `1px solid ${bdr}`,
                borderRadius: '10px', padding: '0.75rem', marginBottom: '0.85rem',
              }}>
                {/* Market + direction */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.55rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: txt0 }}>
                    {symLabel(lastContractSummary.symbol)}
                  </span>
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    fontSize: '0.68rem', fontWeight: 600, color: '#FCA311',
                    background: 'rgba(252,163,17,0.1)', border: '1px solid rgba(252,163,17,0.25)',
                    padding: '2px 8px', borderRadius: '20px',
                  }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 13L13 3M13 3H7M13 3V9"/>
                    </svg>
                    {CONTRACT_TYPES.find(c => c.value === lastContractSummary.contractType)?.label?.split('→')[1]?.trim() ?? lastContractSummary.contractType}
                  </span>
                </div>
                <div style={{ fontSize: '0.62rem', color: txt2, marginBottom: '0.65rem' }}>
                  Tick 0
                </div>
                {/* Stats 2×2 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {[
                    { label: 'Total profit/loss', value: `${stats.profit >= 0 ? '+' : ''}${stats.profit.toFixed(2)} ${currency}`, color: stats.profit > 0 ? '#22c55e' : stats.profit < 0 ? '#ef4444' : '#fff' },
                    { label: 'Contract value',    value: `${lastContractSummary.potentialPayout.toFixed(2)}`, color: txt0 },
                    { label: 'Stake',             value: `${lastContractSummary.stake.toFixed(2)}`, color: txt0 },
                    { label: 'Potential payout',  value: `${lastContractSummary.potentialPayout.toFixed(2)}`, color: txt0 },
                  ].map(s => (
                    <div key={s.label}>
                      <div style={{ fontSize: '0.58rem', color: txt2, marginBottom: '1px' }}>{s.label}</div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
              <span style={{ fontSize: '0.68rem', color: txt1 }}>
                {botError ?? (botReady
                  ? `Connected · ${accountLabel || 'Account'} · ${currency}`
                  : 'Connecting to Deriv…')}
              </span>
            </div>

            {/* Bot config */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.6rem', fontWeight: 600, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                  Contract Type
                </label>
                <select value={contractType} onChange={e => setContractType(e.target.value)} disabled={running}
                  style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'pointer' }}>
                  {CONTRACT_TYPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '0.6rem', fontWeight: 600, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                    Stake ({currency})
                  </label>
                  <input type="number" min="0.35" step="0.01" value={stake} onChange={e => setStake(e.target.value)}
                    disabled={running} style={{ ...inputStyle, cursor: running ? 'not-allowed' : 'text' }} />
                </div>
                {needsBarrier(contractType) && (
                  <div style={{ width: '70px' }}>
                    <label style={{ display: 'block', fontSize: '0.6rem', fontWeight: 600, color: txt2, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
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
                <p style={{ color: txt1, fontSize: '0.85rem', lineHeight: 1.65, textAlign: 'center', margin: 0 }}>
                  When you&apos;re ready to trade, hit <strong style={{ color: txt0 }}>Run</strong>.<br/>
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
                <span style={{ fontSize: '0.72rem', color: txt1 }}>
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
            <div style={{ display: 'flex', gap: '0.5rem', padding: '0.75rem 1rem', borderBottom: `1px solid ${bdr}` }}>
              <button
                onClick={downloadCSV}
                disabled={txLog.length === 0}
                style={{
                  padding: '0.4rem 0.9rem', borderRadius: '6px',
                  border: `1px solid ${bdr}`, background: 'transparent',
                  color: txLog.length === 0 ? txt2 : txt1,
                  fontSize: '0.78rem', fontWeight: 600,
                  cursor: txLog.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >Download</button>
              <button
                onClick={onViewDetail}
                disabled={txLog.length === 0}
                style={{
                  padding: '0.4rem 0.9rem', borderRadius: '6px',
                  border: `1px solid ${bdr}`, background: 'transparent',
                  color: txLog.length === 0 ? txt2 : txt1,
                  fontSize: '0.78rem', fontWeight: 600,
                  cursor: txLog.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >View Detail</button>
            </div>

            {txLog.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1.5rem', textAlign: 'center' }}>
                <EmptyBoxIcon />
                <p style={{ color: txt1, fontWeight: 600, fontSize: '0.88rem', margin: '1rem 0 0.4rem' }}>
                  There are no transactions to display
                </p>
                <p style={{ color: txt2, fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
                  Here are the possible reasons:
                </p>
                {['The bot is not running', 'The stats are cleared'].map(r => (
                  <div key={r} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                    <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: txt2, flexShrink: 0 }}/>
                    <span style={{ fontSize: '0.78rem', color: txt2 }}>{r}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {/* Column headers */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '56px 1fr 90px',
                  padding: '0.45rem 1rem', borderBottom: `1px solid ${bdr}`,
                  position: 'sticky', top: 0, background: bg1,
                }}>
                  {['Type', 'Entry/Exit spot', 'Buy price and P/L'].map(h => (
                    <span key={h} style={{ fontSize: '0.62rem', fontWeight: 700, color: txt2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {h}
                    </span>
                  ))}
                </div>

                {txLog.map(tx => {
                  const pl = tx.payout - tx.stake
                  const potentialPL = tx.potentialPayout - tx.stake
                  return (
                    <div key={tx.id}
                      style={{ display: 'grid', gridTemplateColumns: '56px 1fr 90px', alignItems: 'center', padding: '0.6rem 1rem', borderBottom: `1px solid ${bdr}`, transition: 'background 0.1s' }}
                      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = bg1}
                      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                    >
                      {/* Type: market grid icon + direction arrow */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        {/* 4-dot market icon */}
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="var(--txt2)">
                          <rect x="0" y="0" width="6" height="6" rx="1"/>
                          <rect x="8" y="0" width="6" height="6" rx="1"/>
                          <rect x="0" y="8" width="6" height="6" rx="1"/>
                          <rect x="8" y="8" width="6" height="6" rx="1"/>
                        </svg>
                        {/* Diagonal arrow — orange while pending, won/lost color after */}
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                          style={{ color: '#f97316' }}
                        >
                          <path d="M3 13L13 3M13 3H7M13 3V9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>

                      {/* Entry / Exit spots */}
                      <div>
                        {/* Entry spot — filled red circle */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{
                            width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                            background: '#ef4444', border: '1.5px solid #ef4444',
                          }}/>
                          <span style={{ fontSize: '0.72rem', fontVariantNumeric: 'tabular-nums', color: '#fff' }}>
                            {tx.entrySpot != null ? tx.entrySpot.toFixed(pipSize) : '—'}
                          </span>
                        </div>
                        {/* Exit spot — empty circle, or spinner while pending */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
                          {tx.pending ? (
                            <span style={{
                              width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                              border: '1.5px solid rgba(252,163,17,0.5)', borderTopColor: '#FCA311',
                              animation: 'spin 0.7s linear infinite', display: 'inline-block',
                            }}/>
                          ) : (
                            <span style={{
                              width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                              background: 'transparent', border: `1.5px solid ${bdr}`,
                            }}/>
                          )}
                          <span style={{ fontSize: '0.72rem', fontVariantNumeric: 'tabular-nums', color: txt1 }}>
                            {/* Hide exit spot while pending — POC may arrive before SELL, avoid blip */}
                            {!tx.pending && (tx.exitSpot != null ? tx.exitSpot.toFixed(pipSize) : '')}
                          </span>
                        </div>
                      </div>

                      {/* Buy price + P/L */}
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.72rem', color: txt1, fontVariantNumeric: 'tabular-nums' }}>
                          {tx.stake.toFixed(2)} {currency}
                        </div>
                        {tx.pending ? (
                          /* Blurred potential P/L while trade is in-flight */
                          <div style={{
                            fontSize: '0.72rem', fontWeight: 700,
                            color: '#22c55e',
                            fontVariantNumeric: 'tabular-nums', marginTop: '3px',
                            filter: 'blur(4px)',
                            animation: 'pendingPulse 1.4s ease-in-out infinite',
                            userSelect: 'none',
                          }}>
                            +{potentialPL.toFixed(2)} {currency}
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: pl >= 0 ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums', marginTop: '3px' }}>
                            {pl >= 0 ? '+' : ''}{pl.toFixed(2)} {currency}
                          </div>
                        )}
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
          <JournalTab txLog={txLog} currency={currency} downloadCSV={downloadCSV} />
        )}
      </div>

      {/* ══════════════════════════════════════
          PINNED BOTTOM — Stats + Reset
          Same on every tab (matches Deriv UI)
      ══════════════════════════════════════ */}
      <div style={{ borderTop: `1px solid ${bdr}`, background: bg1, flexShrink: 0 }}>

        {/* "What's this?" */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0.5rem 1rem 0' }}>
          <a href="https://deriv.com/help-centre/" target="_blank" rel="noopener noreferrer"
            style={{ fontSize: '0.63rem', color: txt2, textDecoration: 'underline', cursor: 'pointer' }}>
            What&apos;s this?
          </a>
        </div>

        {/* Stats grid — 3 × 2 */}
        <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
          {statRows.map((row, ri) => (
            <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', marginBottom: ri === 0 ? '0.75rem' : 0 }}>
              {row.map(s => (
                <div key={s.label}>
                  <div style={{ fontSize: '0.63rem', fontWeight: 600, color: txt2, marginBottom: '0.18rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
              borderRadius: '8px', border: `1px solid ${bdr}`,
              background: 'transparent', color: txt1,
              fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
              letterSpacing: '0.03em', transition: 'background 0.15s, color 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = bg2; b.style.color = txt0; b.style.borderColor = bdr }}
            onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.background = 'transparent'; b.style.color = txt1; b.style.borderColor = bdr }}
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Journal Tab ───────────────────────────────────────── */
function JournalTab({ txLog, currency, downloadCSV }: {
  txLog: TxEntry[]; currency: string; downloadCSV: () => void
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filters, setFilters] = useState({ errors: true, notifications: true, system: true })

  function toggle(key: keyof typeof filters) {
    setFilters(f => ({ ...f, [key]: !f[key] }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Action bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: `1px solid ${bdr}`, position: 'relative' }}>
        <button
          onClick={downloadCSV}
          disabled={txLog.length === 0}
          style={{
            padding: '0.4rem 0.9rem', borderRadius: '6px',
            border: `1px solid ${bdr}`, background: 'transparent',
            color: txLog.length === 0 ? txt2 : txt1,
            fontSize: '0.78rem', fontWeight: 600,
            cursor: txLog.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >Download</button>

        {/* Filters button + dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setFiltersOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'transparent', border: 'none', cursor: 'pointer', color: txt2, fontSize: '0.78rem', fontWeight: 500 }}
          >
            Filters
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
            </svg>
          </button>
          {filtersOpen && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)',
              background: bg1, border: `1px solid ${bdr}`,
              borderRadius: '10px', padding: '0.5rem 0', minWidth: '160px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 80,
            }}>
              {(['errors', 'notifications', 'system'] as const).map(key => (
                <label key={key} style={{
                  display: 'flex', alignItems: 'center', gap: '0.6rem',
                  padding: '0.45rem 0.9rem', cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={filters[key]}
                    onChange={() => toggle(key)}
                    style={{ accentColor: '#FCA311', width: '14px', height: '14px', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.82rem', color: txt0, textTransform: 'capitalize' }}>{key}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {txLog.length === 0 ? (
          <div style={{ padding: '2rem 1rem', textAlign: 'center', color: txt2, fontSize: '0.78rem', lineHeight: 1.6 }}>
            No events yet. Start the bot to see activity here.
          </div>
        ) : (
          txLog.map(tx => {
            const pl = tx.payout - tx.stake
            const dateStr = `${new Date(tx.time).toISOString().slice(0, 10)} | ${new Date(tx.time).toISOString().slice(11, 19)} GMT`
            const description = tx.longcode
              ?? `Win payout if ${symLabel(tx.symbol)} after 1 tick satisfies ${tx.contractType} condition.`
            return (
              <div key={tx.id}>
                {/* Bought entry */}
                {filters.notifications && (
                  <div style={{ padding: '0.65rem 1rem', borderBottom: `1px solid ${bdr}` }}>
                    <div style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
                      <span style={{ color: '#4A90D9', fontWeight: 600 }}>Bought</span>
                      <span style={{ color: txt1 }}>: {description} (ID: {tx.id})</span>
                    </div>
                    <div style={{ fontSize: '0.62rem', color: txt2, marginTop: '3px' }}>{dateStr}</div>
                  </div>
                )}
                {/* Result entry */}
                <div style={{ padding: '0.65rem 1rem', borderBottom: `1px solid ${bdr}` }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: pl > 0 ? '#22c55e' : '#ef4444' }}>
                    {pl > 0 ? 'Profit' : 'Loss'} amount: {pl > 0 ? '+' : ''}{pl.toFixed(2)} {currency}
                  </div>
                  <div style={{ fontSize: '0.62rem', color: txt2, marginTop: '3px' }}>{dateStr}</div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ─── View Detail Modal ─────────────────────────────────── */
function ViewDetailModal({
  onClose, txLog, stats, accountId, currency, pipSize,
}: {
  onClose: () => void
  txLog: TxEntry[]
  stats: RunStats
  accountId: string
  currency: string
  pipSize: number
}) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div style={{
        background: bg1, border: `1px solid ${bdr}`,
        borderRadius: '14px', width: '100%', maxWidth: '700px',
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.25rem', borderBottom: `1px solid ${bdr}`,
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: txt0 }}>
            Transactions detailed summary
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: txt2, padding: '4px',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Trade rows — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '160px 80px 80px 80px 80px 80px 80px 90px',
            padding: '0.6rem 1rem',
            borderBottom: `1px solid ${bdr}`,
            background: bg1,
            position: 'sticky', top: 0,
            gap: '0.5rem',
          }}>
            {['Timestamp','Reference','Market','Trade type','Entry spot','Exit spot','Buy price','Profit/Loss'].map(h => (
              <span key={h} style={{
                fontSize: '0.62rem', fontWeight: 700,
                color: txt2, textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>{h}</span>
            ))}
          </div>

          {txLog.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: txt2, fontSize: '0.82rem' }}>
              No transactions yet.
            </div>
          ) : txLog.map(tx => {
            const pl = tx.payout - tx.stake
            return (
              <div key={tx.id} style={{
                display: 'grid',
                gridTemplateColumns: '160px 80px 80px 80px 80px 80px 80px 90px',
                padding: '0.65rem 1rem', gap: '0.5rem',
                borderBottom: `1px solid ${bdr}`,
                alignItems: 'center',
              }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = bg1}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
              >
                <span style={{ fontSize: '0.7rem', color: txt2 }}>
                  {new Date(tx.time).toISOString().slice(0, 10)} {new Date(tx.time).toISOString().slice(11, 19)} GMT
                </span>
                <span style={{ fontSize: '0.68rem', color: txt1, fontVariantNumeric: 'tabular-nums' }}>
                  {tx.id}
                </span>
                <span style={{ fontSize: '0.68rem', color: txt1 }}>
                  {symLabel(tx.symbol).split(' ').slice(0, 2).join(' ')}
                </span>
                <span>
                  {/* Direction arrow based on contract type */}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                    style={{ color: tx.won ? '#22c55e' : '#ef4444' }}
                  >
                    <path d="M3 13L13 3M13 3H7M13 3V9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
                <span style={{ fontSize: '0.72rem', color: txt0, fontVariantNumeric: 'tabular-nums' }}>
                  {tx.entrySpot != null ? tx.entrySpot.toFixed(pipSize) : '—'}
                </span>
                <span style={{ fontSize: '0.72rem', color: txt1, fontVariantNumeric: 'tabular-nums' }}>
                  {tx.pending ? '—' : (tx.exitSpot != null ? tx.exitSpot.toFixed(pipSize) : '—')}
                </span>
                <span style={{ fontSize: '0.72rem', color: txt1, fontVariantNumeric: 'tabular-nums' }}>
                  {tx.stake.toFixed(2)}
                </span>
                <span style={{
                  fontSize: '0.72rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                  color: pl >= 0 ? '#22c55e' : '#ef4444',
                }}>
                  {pl >= 0 ? '+' : ''}{pl.toFixed(2)} {currency}
                </span>
              </div>
            )
          })}
        </div>

        {/* Summary row */}
        <div style={{ borderTop: `1px solid ${bdr}`, flexShrink: 0 }}>
          {/* Summary headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(8, 1fr)',
            padding: '0.5rem 1rem',
            background: bg1,
            gap: '0.5rem',
          }}>
            {['Account','No. of runs','Total stake','Total payout','Win','Loss','Total profit/loss','Balance'].map(h => (
              <span key={h} style={{
                fontSize: '0.62rem', fontWeight: 700,
                color: txt2, textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>{h}</span>
            ))}
          </div>
          {/* Summary values */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)',
            padding: '0.6rem 1rem 0.9rem', gap: '0.5rem',
          }}>
            <span style={{ fontSize: '0.72rem', color: txt1 }}>{accountId || '—'}</span>
            <span style={{ fontSize: '0.72rem', color: txt0, fontVariantNumeric: 'tabular-nums' }}>{stats.runs}</span>
            <span style={{ fontSize: '0.72rem', color: txt0, fontVariantNumeric: 'tabular-nums' }}>{stats.totalStake.toFixed(2)}</span>
            <span style={{ fontSize: '0.72rem', color: txt0, fontVariantNumeric: 'tabular-nums' }}>{stats.totalPayout.toFixed(2)}</span>
            <span style={{ fontSize: '0.72rem', color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>{stats.won}</span>
            <span style={{ fontSize: '0.72rem', color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>{stats.lost}</span>
            <span style={{
              fontSize: '0.72rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: stats.profit > 0 ? '#22c55e' : stats.profit < 0 ? '#ef4444' : '#fff',
            }}>
              {stats.profit >= 0 ? '+' : ''}{stats.profit.toFixed(2)} {currency}
            </span>
            <span style={{ fontSize: '0.72rem', color: txt1, fontVariantNumeric: 'tabular-nums' }}>—</span>
          </div>
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
      background: bg1,
      borderTop: `1px solid ${bdr}`,
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
          border: '1px solid var(--bdr)',
          borderRadius: '8px',
          padding: '0.35rem 0.75rem',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}
      >
        <span style={{ fontSize: '0.62rem', color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Speed
        </span>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: txt1 }}>
          {SPEED_LABELS[speed]}
        </span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="var(--txt2)" strokeWidth="1.5" strokeLinecap="round">
          <polyline points="1,1 5,5 9,1"/>
        </svg>
      </button>
    </div>
  )
}

/* ─── Scanner ────────────────────────────────────────────── */

function ScannerView() {
  return (
    <iframe
      src="https://signals-scanner.vercel.app/"
      title="Signal Scanner"
      style={{ flex: 1, width: '100%', border: 'none', display: 'block' }}
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

  const wsRef     = useRef<WebSocket | null>(null)
  /** pip_size from Deriv tick/history responses — determines decimal places for last-digit calc */
  const pipSizeRef = useRef<number>(2)

  /* ── Run panel UI state ── */
  const [runOpen,   setRunOpen]   = useState(true)
  const [running,   setRunning]   = useState(false)
  const [execSpeed, setExecSpeed] = useState<ExecSpeed>('turbo')
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
  const [accountLabel,    setAccountLabel]    = useState<string>('')
  const [activeAccountId, setActiveAccountId] = useState<string>('')
  const [showDetailModal, setShowDetailModal] = useState(false)
  /** Tracks which tick the settlement occurred on — used to follow the digit as it scrolls */
  const [tradeFlash,      setTradeFlash]      = useState<{ won: boolean; atTickN: number } | null>(null)
  /** Monotonically increasing counter — incremented on every public tick */
  const [tickN,           setTickN]           = useState(0)
  const [lastContractSummary, setLastContractSummary] = useState<{
    symbol: string; contractType: string; stake: number; potentialPayout: number
  } | null>(null)

  /* ── Refs (avoid stale closures in WS callbacks) ── */
  const runningRef      = useRef(false)
  const contractTypeRef = useRef('DIGITEVEN')
  const stakeRef        = useRef('1.00')
  const barrierRef      = useRef('5')
  const symbolRef       = useRef('1HZ100V')
  const execSpeedRef    = useRef<ExecSpeed>('turbo')
  const currencyRef     = useRef('USD')
  const botWsRef        = useRef<WebSocket | null>(null)
  /** Tracks live price from tick stream — captured as entry spot when a trade is placed */
  const livePriceRef      = useRef<number | null>(null)
  /** Maps contract_id → { buyPrice, entrySpot, longcode, potentialPayout } for bot trades we initiated */
  const pendingBuysRef    = useRef<Map<number, { buyPrice: number; entrySpot: number | null; longcode?: string; potentialPayout?: number }>>(new Map())
  /** Maps req_id → entrySpot — bridges executeTrade (req_id) to buy response (contract_id) */
  const pendingSpotsByReq = useRef<Map<number, number | null>>(new Map())
  /** req_ids of in-flight one-shot proposal requests, awaiting a price before the real buy fires */
  const pendingProposalsRef = useRef<Set<number>>(new Set())
  const reqIdRef        = useRef(200)
  /** Auto-reconnect: attempt count + backoff timer */
  const reconnectCount  = useRef(0)
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Set to true when user explicitly closes (logout/unmount) — skip reconnect */
  const intentionalClose = useRef(false)
  /**
   * The accountId the bot WS is currently (or last) connected to.
   * Used to detect account switches and force a reconnect.
   */
  const connectedAccountRef = useRef<string | null>(null)
  /** Ref mirror of tickN — readable synchronously in WS callbacks without stale closures */
  const tickNRef = useRef(0)
  /** Clears the trade flash after it scrolls off the visible sequence window */
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Mirror of the prices array — kept in sync in the tick handler so the POC
   * handler can do a synchronous lastIndexOf() to find the exact exit tick position
   * without relying on React state (which is async and may be stale in a callback).
   */
  const pricesRef = useRef<number[]>([])
  /**
   * Set in the SELL handler. Read by the POC handler (or tick handler) to know
   * which flash to trigger when exit_spot is confirmed.
   */
  const pendingFlashWonRef  = useRef<boolean | null>(null)
  /**
   * Length of pricesRef at the moment SELL fires.
   * The exit tick for a 1-tick contract is at or just before this position,
   * so POC uses it as a search anchor instead of scanning the full array.
   * This prevents false matches from repeated prices elsewhere in the window.
   */
  const pendingFlashSellIdxRef = useRef<number>(0)
  /**
   * Set in the POC handler when exit_spot arrives before the matching public tick.
   * The tick handler watches for this price (with epsilon) and triggers the flash.
   */
  const pendingExitSpotRef  = useRef<number | null>(null)

  /* ── Keep refs in sync with state ── */
  // NOTE: livePriceRef is also updated DIRECTLY in the tick WS handler (faster path)
  // This effect keeps the ref in sync if livePrice is set from elsewhere
  useEffect(() => { livePriceRef.current   = livePrice   }, [livePrice])
  useEffect(() => { symbolRef.current      = symbol      }, [symbol])
  useEffect(() => { contractTypeRef.current = contractType }, [contractType])
  useEffect(() => { stakeRef.current       = stake       }, [stake])
  useEffect(() => { barrierRef.current     = barrier     }, [barrier])
  useEffect(() => { execSpeedRef.current   = execSpeed   }, [execSpeed])
  useEffect(() => { currencyRef.current    = currency    }, [currency])

  /* ── Execute one trade via the authorized bot WS ── */
  const executeTrade = useCallback((ws: WebSocket) => {
    if (!runningRef.current || ws.readyState !== WebSocket.OPEN) return

    const ct         = contractTypeRef.current
    const hasBar     = needsBarrier(ct)
    const amount     = parseFloat(stakeRef.current) || 1.00

    // Deriv minimum stake is 0.35 USD — reject before sending to avoid API error
    if (amount < 0.35) {
      setBotError('Stake must be at least 0.35 USD')
      setRunning(false)
      runningRef.current = false
      return
    }

    const reqId      = ++reqIdRef.current
    // Capture current tick as entry spot and map it to this reqId
    // When the buy response arrives (with the same req_id), we look this up
    pendingSpotsByReq.current.set(reqId, livePriceRef.current)

    /*
     * Request a one-shot proposal first instead of buying with a flat price cap.
     * A fixed price:1000 cap has no relationship to the actual ask_price, so it
     * either does nothing (small stakes) or silently rejects the trade (stakes
     * whose ask_price exceeds 1000). The real buy fires from the 'proposal'
     * response handler below, using Deriv's actual ask_price with a 2% cap.
     *
     * contract_type: one of DIGITEVEN | DIGITODD | DIGITMATCH | DIGITDIFF | DIGITOVER | DIGITUNDER
     * duration: 1, duration_unit: "t" → 1-tick digit contract
     * barrier (optional): the digit prediction for MATCH/DIFF/OVER/UNDER
     */
    pendingProposalsRef.current.add(reqId)
    ws.send(JSON.stringify({
      proposal: 1,
      subscribe: 0,
      req_id: reqId,
      contract_type:     ct,
      underlying_symbol: symbolRef.current,
      duration:          1,
      duration_unit:     't',
      amount,
      basis:    'stake',
      currency: currencyRef.current,
      ...(hasBar ? { barrier: barrierRef.current } : {}),
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

      /* ── Fetch active account + currency from session ─────────────────────
         This MUST happen before getting the OTP so we always connect to the
         account that is currently active in the session, not a stale one.
      ── */
      let activeAccountId = ''
      try {
        const balRes = await fetch('/api/user/balance', { cache: 'no-store' })
        if (balRes.ok) {
          const balData = await balRes.json() as {
            activeAccountId: string
            accounts: { accountId: string; currency: string; isDemo: boolean }[]
          }
          activeAccountId = balData.activeAccountId
          const active = balData.accounts.find(a => a.accountId === activeAccountId)
          if (active) {
            setCurrency(active.currency)
            currencyRef.current = active.currency
            setAccountLabel(active.isDemo ? 'Demo' : 'Real')
          }
          setActiveAccountId(balData.activeAccountId)
        }
      } catch { /* non-fatal — proceed with existing currency */ }

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

      /* Record which account this WS is connected to */
      connectedAccountRef.current = activeAccountId

      ws = new WebSocket(wsUrl)
      botWsRef.current = ws

      ws.onopen = () => {
        reconnectCount.current = 0
        setBotError(null)
        /* New Deriv API: connection is already authenticated via OTP in URL.
           Subscribe to transaction stream immediately.
           req_id: 100 reserved for transaction subscription */
        ws!.send(JSON.stringify({ transaction: 1, subscribe: 1, req_id: 100 }))
        // Subscribe to balance updates — server pushes on every balance change
        // Source: balance_request.schema.json — subscribe: 1, auth_required
        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 51 }))
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

          /* ── Fatal errors: stop bot, don't reconnect ──────────────────── */
          const fatalCodes = ['AuthorizationRequired', 'InvalidToken', 'InvalidAppID']
          if (err.code && fatalCodes.includes(err.code)) {
            intentionalClose.current = true
            setBotError('Session expired — please log in again.')
            setRunning(false)
            runningRef.current = false
            return
          }

          /* ── Trade-level errors: stop bot but keep WS alive ───────────── */
          // These are errors on a specific buy request — bad params, market closed, etc.
          // We stop trading but do NOT close the socket (user can fix and restart).
          const tradeErrorCodes = [
            'InputValidationError',    // stake below minimum, bad barrier, etc.
            'ContractCreationFailure', // e.g. market closed, invalid contract
            'MarketIsClosed',          // market is not open for trading
            'OfferingNotFound',        // contract type not available for this symbol
            'ContractBuyValidationError',
          ]
          if (err.code && tradeErrorCodes.includes(err.code)) {
            setBotError(`Trade error: ${err.message}`)
            setRunning(false)
            runningRef.current = false
            return
          }

          /* ── Transient errors: surface but keep bot running ───────────── */
          // RateLimit — server is throttling, will recover
          if (err.code === 'RateLimit') {
            setBotError('Rate limited — pausing briefly…')
            // Don't stop — next executeTrade will retry after the normal delay
            return
          }

          /* ── All other errors: stop bot ───────────────────────────────── */
          setBotError(err.message ?? 'Unknown error')
          setRunning(false)
          runningRef.current = false
          return
        }

        /* ── Balance subscription push ── */
        if (msg.msg_type === 'balance') {
          const b = (msg as { balance: { balance: number; currency: string } }).balance
          window.dispatchEvent(new CustomEvent('deriv-balance', {
            detail: { balance: b.balance, currency: b.currency },
          }))
          // Auto-clear "insufficient balance" error when Deriv reports a new balance.
          // This covers demo resets and deposits — user can press Run again immediately
          // without needing to refresh the page.
          setBotError(prev =>
            (prev && (prev.toLowerCase().includes('insufficient') || prev.toLowerCase().includes('balance')))
              ? null
              : prev
          )
        }

        /* ── proposal_open_contract — real exit spot when contract settles ──
           Deriv delivers `exit_spot` (string) and `is_sold: 1` when settled.
           Source: proposal_open_contract_response.schema.json

           We also use exit_spot to pin the flash glow to the EXACT exit tick:
           1. Find exit_spot in pricesRef (prices already received on public WS).
              This gives us the tick's precise position regardless of timing.
           2. If not found yet (POC arrived before the public WS tick), store
              exit_spot in pendingExitSpotRef — the tick handler will fire the
              flash the moment that price lands.
        ── */
        if (msg.msg_type === 'proposal_open_contract') {
          const poc = (msg as {
            proposal_open_contract: {
              contract_id: number
              is_sold?: number
              exit_spot?: string | null
              entry_spot?: string | null
            }
          }).proposal_open_contract
          if (poc.is_sold && poc.exit_spot) {
            const exitSpotNum = parseFloat(poc.exit_spot)
            if (Number.isFinite(exitSpotNum)) {
              // Update transaction log with real exit spot
              setTxLog(prev => prev.map(t =>
                t.id === poc.contract_id ? { ...t, exitSpot: exitSpotNum } : t
              ))

              // Trigger glow flash pinned to the exact exit tick
              if (pendingFlashWonRef.current !== null) {
                const won    = pendingFlashWonRef.current
                const prices = pricesRef.current
                const EPSILON = 1e-6  // guards against float precision diff between
                                      // tick.quote (JSON number) and parseFloat(exit_spot string)

                // The exit tick for a 1-tick contract arrived just before SELL fired.
                // pendingFlashSellIdxRef.current holds pricesRef.length at SELL time.
                // We search a tight ±4 window around that bookmark so a repeated price
                // elsewhere in the visible window can never produce a false match.
                const sellLen  = pendingFlashSellIdxRef.current || prices.length
                const lo = Math.max(0, sellLen - 4)
                const hi = Math.min(prices.length - 1, sellLen)  // exit tick ≤ sellLen

                let exitIdx = -1
                // Search from hi downward — prefer the most recent match within window
                for (let i = hi; i >= lo; i--) {
                  if (Math.abs(prices[i] - exitSpotNum) < EPSILON) { exitIdx = i; break }
                }

                if (exitIdx >= 0) {
                  // Found — compute exactly how many ticks ago the exit tick was
                  const ticksAgo = prices.length - 1 - exitIdx
                  const atTickN  = tickNRef.current - ticksAgo
                  if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
                  setTradeFlash({ won, atTickN })
                  flashTimerRef.current = setTimeout(() => setTradeFlash(null), 22_000)
                  pendingFlashWonRef.current     = null
                  pendingFlashSellIdxRef.current = 0
                } else {
                  // Exit tick not yet received on public WS (POC arrived first).
                  // Store exit_spot for the tick handler to match on arrival.
                  pendingExitSpotRef.current = exitSpotNum
                  // pendingFlashWonRef stays set so the tick handler can read it
                }
              }
            }
          }
        }

        /* ── proposal response — fire the real buy at Deriv's ask_price ── */
        if (msg.msg_type === 'proposal') {
          const propReqId = msg.req_id as number | undefined
          if (propReqId != null && pendingProposalsRef.current.has(propReqId)) {
            pendingProposalsRef.current.delete(propReqId)
            const entrySpot = pendingSpotsByReq.current.get(propReqId) ?? null
            pendingSpotsByReq.current.delete(propReqId)
            const prop = msg.proposal as { id: string; ask_price: number }
            const buyReqId = ++reqIdRef.current
            pendingSpotsByReq.current.set(buyReqId, entrySpot)
            ws!.send(JSON.stringify({ buy: prop.id, price: +(Number(prop.ask_price) * 1.02).toFixed(2), req_id: buyReqId }))
          }
        }

        /* ── buy response ── */
        if (msg.msg_type === 'buy') {
          // Clear any leftover pending flash from the previous trade so it doesn't
          // accidentally fire mid-next-contract (edge case: lost POC + immediate re-run)
          pendingFlashWonRef.current     = null
          pendingExitSpotRef.current     = null
          pendingFlashSellIdxRef.current = 0

          const buy = msg.buy as {
            contract_id: number; buy_price: number
            longcode?: string; payout?: number
          }
          const reqId  = msg.req_id as number | undefined
          const entrySpot = reqId != null ? (pendingSpotsByReq.current.get(reqId) ?? null) : null
          if (reqId != null) pendingSpotsByReq.current.delete(reqId)
          pendingBuysRef.current.set(buy.contract_id, {
            buyPrice: buy.buy_price,
            entrySpot,
            longcode: buy.longcode,
            potentialPayout: buy.payout,
          })
          setLastContractSummary({
            symbol:         symbolRef.current,
            contractType:   contractTypeRef.current,
            stake:          buy.buy_price,
            potentialPayout: buy.payout ?? 0,
          })
          setRunStats(prev => ({
            ...prev,
            totalStake: prev.totalStake + buy.buy_price,
            runs: prev.runs + 1,
          }))
          // Add a pending entry to the transaction log immediately —
          // P/L will be blurred until the sell response arrives
          setTxLog(prev => [{
            id:              buy.contract_id,
            time:            Date.now(),
            contractType:    contractTypeRef.current,
            stake:           buy.buy_price,
            payout:          0,
            potentialPayout: buy.payout ?? 0,
            won:             false,
            symbol:          symbolRef.current,
            entrySpot:       entrySpot ?? undefined,
            exitSpot:        undefined,
            longcode:        buy.longcode,
            pending:         true,
          }, ...prev].slice(0, 100))
          // Subscribe to proposal_open_contract so we get the REAL exit spot
          // when the contract settles — NOT livePriceRef (which is a later tick).
          // Source: proposal_open_contract_request.schema.json + response.schema.json
          ws!.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: buy.contract_id,
            subscribe: 1,
            req_id: ++reqIdRef.current,
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
            const pending = pendingBuysRef.current.get(tx.contract_id)
            if (pending === undefined) return

            pendingBuysRef.current.delete(tx.contract_id)
            const { buyPrice, entrySpot, longcode, potentialPayout } = pending
            // Exit spot is NOT set here — proposal_open_contract will deliver the real
            // exit_spot once the contract settles, preventing a confusing double-update.
            const sellAmount = Math.max(0, tx.amount)
            const won = sellAmount > 0

            /* ── Flash: store won + prices bookmark; POC handler pins the exit tick ──
             * We record pricesRef.current.length as a bookmark of where the exit tick
             * should be. For a 1-tick contract, exit tick arrived just before SELL, so
             * it's at or near pricesRef[sellIdx-1]. POC uses this bookmark to search
             * only a tight window — avoiding false matches from repeated prices.
             */
            pendingFlashWonRef.current   = won
            pendingFlashSellIdxRef.current = pricesRef.current.length

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

            // Update the pending entry — reveal P/L, mark not pending.
            // exitSpot intentionally omitted here; proposal_open_contract will
            // deliver the real value once and set it, avoiding a confusing jump.
            setTxLog(prev => {
              const idx = prev.findIndex(t => t.id === tx.contract_id && t.pending)
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = { ...next[idx], payout: sellAmount, won, pending: false }
                return next
              }
              // Fallback: add new entry (in case pending was missed)
              return [{
                id:              tx.contract_id!,
                time:            Date.now(),
                contractType:    contractTypeRef.current,
                stake:           buyPrice,
                payout:          sellAmount,
                potentialPayout: potentialPayout ?? 0,
                won,
                symbol:          symbolRef.current,
                entrySpot:       entrySpot ?? undefined,
                exitSpot:        undefined,
                longcode,
              }, ...prev].slice(0, 100)
            })

            if (runningRef.current && ws?.readyState === WebSocket.OPEN) {
              const delay =
                execSpeedRef.current === 'turbo' ? 0 :
                execSpeedRef.current === 'fast'  ? 400 : 1500
              if (delay === 0) {
                executeTrade(ws!)   // fire instantly — no setTimeout overhead
              } else {
                setTimeout(() => {
                  if (runningRef.current && ws?.readyState === WebSocket.OPEN) executeTrade(ws!)
                }, delay)
              }
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
      // Forget all subscriptions before closing
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ forget_all: 'transaction', req_id: 9998 }))
          ws.send(JSON.stringify({ forget_all: 'proposal_open_contracts', req_id: 9997 }))
        } catch { /* ignore */ }
      }
      ws?.close()
      botWsRef.current = null
    }
  }, [executeTrade])

  /* ── Sync running ref ──────────────────────────────────────────────────────
   * executeTrade is NOT called from this effect.
   *
   * The two paths that fire the first trade are:
   *  1. Start button click handler (synchronous, zero frame-delay)
   *  2. ws.onopen — fires executeTrade when WS reconnects while already running
   *
   * Calling executeTrade here would cause a double-buy: the click handler sends
   * one buy immediately, then this effect fires before the buy response arrives
   * (pendingBuysRef is empty until the response lands), so a second buy goes out.
   * ── */
  useEffect(() => {
    runningRef.current = running
  }, [running])

  /**
   * ── Account-change watchdog ────────────────────────────────────────────────
   * Polls /api/user/balance every 20 seconds.
   * If the active account has changed since the bot last connected (e.g. the
   * user switched from Real → Demo in the header), we close the current WS so
   * the auto-reconnect logic picks up the new account.
   * This prevents the "insufficient balance" error that occurs when the bot is
   * still connected to a real account with $0 after switching to the demo.
   */
  useEffect(() => {
    const poll = setInterval(async () => {
      if (intentionalClose.current) return
      try {
        const res = await fetch('/api/user/balance', { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json() as {
          activeAccountId: string
          accounts: { accountId: string; currency: string; isDemo: boolean }[]
        }
        const newId = data.activeAccountId
        if (newId && connectedAccountRef.current && newId !== connectedAccountRef.current) {
          // Account changed — update currency label and reconnect bot WS
          const active = data.accounts.find(a => a.accountId === newId)
          if (active) {
            setCurrency(active.currency)
            currencyRef.current = active.currency
            setAccountLabel(active.isDemo ? 'Demo' : 'Real')
          }
          // Closing the WS triggers onclose → scheduleReconnect → connect()
          // connect() will fetch the new account's OTP automatically
          setRunning(false)
          runningRef.current = false
          botWsRef.current?.close()
        }
      } catch { /* ignore poll errors */ }
    }, 20_000)
    return () => clearInterval(poll)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Reset handler ── */
  function handleReset() {
    setRunning(false)
    runningRef.current = false
    pendingBuysRef.current.clear()
    pendingSpotsByReq.current.clear()
    pendingProposalsRef.current.clear()
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
        // pip_size is at the top level of the history response (not inside history{})
        // schema: ticks_history_response.schema.json — used for correct last-digit extraction
        const ps = (msg as { pip_size?: number }).pip_size
        if (ps != null) pipSizeRef.current = ps
        // prices are numbers per schema (ticks_history_response.schema.json)
        const hist = (msg as { history: { prices: number[] } }).history.prices
          .map((p: number) => Number(p))
        setPrices(hist)
        setLoading(false)
      }

      if (msg.msg_type === 'tick') {
        const tickData = (msg as { tick: { quote: number; pip_size: number } }).tick
        const q = tickData.quote
        // pip_size is required on every tick per ticks_response.schema.json
        if (tickData.pip_size != null) pipSizeRef.current = tickData.pip_size
        // Update ref IMMEDIATELY (synchronously) so executeTrade always sees the
        // latest tick as entry spot — state update is async and would be 1 tick stale
        livePriceRef.current = q
        setLivePrice(q)
        setPrices(prev => {
          const next = [...prev, q]
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
        })

        // Keep synchronous ref in sync — used by POC handler for exit_spot matching
        pricesRef.current = [...pricesRef.current, q].slice(-MAX_HISTORY)

        // Increment monotonic tick counter — lets the flash glow follow the digit
        // left across the Sequence boxes as each new tick pushes it one position
        tickNRef.current++
        setTickN(tickNRef.current)

        // If POC arrived before this tick, check if this IS the exit tick.
        // Use epsilon instead of === to handle float precision diff between
        // tick.quote (JSON number) and parseFloat(exit_spot string from POC).
        if (pendingExitSpotRef.current !== null && Math.abs(q - pendingExitSpotRef.current) < 1e-6) {
          const won = pendingFlashWonRef.current!
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
          setTradeFlash({ won, atTickN: tickNRef.current })
          flashTimerRef.current = setTimeout(() => setTradeFlash(null), 22_000)
          pendingExitSpotRef.current     = null
          pendingFlashWonRef.current     = null
          pendingFlashSellIdxRef.current = 0
        }
      }
    }

    ws.onerror  = () => setLoading(false)
    ws.onclose  = () => {}

    return () => {
      // Send forget_all before closing so the server cleans up subscriptions
      // immediately rather than waiting for the TCP connection timeout
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ forget_all: 'ticks', req_id: 9999 })) } catch { /* ignore */ }
      }
      ws.close()
      wsRef.current = null
    }
  }, [symbol])

  /* ── Derived digit data ── */
  const digits = useMemo(
    () => prices.slice(-tickCount).map(p => getLastDigit(p, pipSizeRef.current)),
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
    const slice50 = digits.slice(-50)
    const over  = digits.filter(d => d > ouBarrier).length
    const under = digits.filter(d => d <= ouBarrier).length
    const seq   = slice50.map(d => d > ouBarrier ? 'O' : 'U')
    const { count, val } = trailingStreak(seq)
    return { over, under, seq, rawDigits: slice50, streak: count, streakLabel: val === 'O' ? 'Over' : 'Under' }
  }, [digits, ouBarrier])

  /* Match / Differ */
  const mdData = useMemo(() => {
    const slice50 = digits.slice(-50)
    const match  = digits.filter(d => d === mdDigit).length
    const differ = digits.filter(d => d !== mdDigit).length
    const seq    = slice50.map(d => d === mdDigit ? 'M' : 'D')
    const { count, val } = trailingStreak(seq)
    return { match, differ, seq, rawDigits: slice50, streak: count, streakLabel: val === 'M' ? 'Match' : 'Differ' }
  }, [digits, mdDigit])

  /* Even / Odd */
  const eoData = useMemo(() => {
    const slice50 = digits.slice(-50)
    const even = digits.filter(d => d % 2 === 0).length
    const odd  = digits.filter(d => d % 2 !== 0).length
    const seq  = slice50.map(d => d % 2 === 0 ? 'E' : 'O')
    const { count, val } = trailingStreak(seq)
    return { even, odd, seq, rawDigits: slice50, streak: count, streakLabel: val === 'E' ? 'Even' : 'Odd' }
  }, [digits])

  /* Rise / Fall */
  const rfData = useMemo(() => {
    const slice = prices.slice(-tickCount)
    let rise = 0, fall = 0
    const seq: string[] = []
    const rawDigits: number[] = []
    for (let i = 1; i < slice.length; i++) {
      if (slice[i] > slice[i - 1]) {
        rise++; seq.push('R')
        rawDigits.push(getLastDigit(slice[i], pipSizeRef.current))
      } else if (slice[i] < slice[i - 1]) {
        fall++; seq.push('F')
        rawDigits.push(getLastDigit(slice[i], pipSizeRef.current))
      }
    }
    const recent    = seq.slice(-50)
    const recentRaw = rawDigits.slice(-50)
    const { count, val } = trailingStreak(recent)
    return { rise, fall, seq: recent, rawDigits: recentRaw, streak: count, streakLabel: val === 'R' ? 'Rise' : 'Fall', total: rise + fall }
  }, [prices, tickCount])

  /* Circle styling */
  function circleStyle(digit: number): React.CSSProperties {
    let bg = bg2, border = '2px solid rgba(252,163,17,0.12)', color = txt1
    if      (digit === highest)    { bg = '#FCA311'; border = '2px solid #FCA311'; color = '#000' }
    else if (digit === secondHigh) { bg = 'rgba(252,163,17,0.2)'; border = '2px solid rgba(252,163,17,0.5)'; color = '#FCA311' }
    else if (digit === lowest)     { bg = 'rgba(239,68,68,0.22)'; border = '2px solid #ef4444'; color = '#ef4444' }
    else if (digit === secondLow)  { bg = 'rgba(239,68,68,0.1)'; border = '2px solid rgba(239,68,68,0.4)'; color = 'rgba(239,68,68,0.85)' }
    if (digit === lastDigit)       { border = `3px solid ${txt0}` }
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
    <div style={{
      background: bg0, minHeight: '100%', display: 'flex', flexDirection: 'column', paddingBottom: '48px',
      paddingRight: runOpen ? '340px' : '0',
      transition: 'padding-right 0.28s cubic-bezier(0.4,0,0.2,1)',
    }}>

      {/* ── Circles / Scanner toggle ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--bdr)' }}>
        {(['circles', 'scanner'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              flex: 1, padding: '0.65rem',
              fontSize: '0.82rem', fontWeight: 700,
              cursor: 'pointer', border: 'none',
              background: activeTab === t ? 'rgba(252,163,17,0.12)' : bg1,
              color: activeTab === t ? 'var(--gold)' : txt2,
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
            position: 'relative',
            display: 'flex', alignItems: 'center', gap: '1rem',
            padding: '0.75rem 1.25rem',
            borderBottom: `1px solid ${bdr}`,
            background: bg1, flexWrap: 'wrap',
          }}>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              style={{
                background: bg1, border: `1px solid ${bdr}`,
                color: txt0, padding: '0.4rem 0.75rem',
                borderRadius: '8px', fontSize: '0.82rem', cursor: 'pointer',
                minWidth: '200px',
              }}
            >
              {MARKETS.map(m => (
                <option key={m.symbol} value={m.symbol}>{m.label}</option>
              ))}
            </select>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: txt2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Ticks
              </label>
              <input
                type="number"
                value={tickCount}
                min={10}
                max={MAX_HISTORY}
                onChange={e => setTickCount(Math.min(MAX_HISTORY, Math.max(10, parseInt(e.target.value) || 1000)))}
                style={{
                  width: '80px', background: bg1, border: `1px solid ${bdr}`,
                  color: txt0, padding: '0.4rem 0.5rem',
                  borderRadius: '8px', fontSize: '0.82rem', textAlign: 'center',
                }}
              />
            </div>

            {/* Live price — absolutely centered so it sits in the middle regardless of other controls */}
            <div style={{
              position: 'absolute', left: '50%', transform: 'translateX(-50%)',
              textAlign: 'center', pointerEvents: 'none',
            }}>
              <div style={{ fontSize: '0.6rem', color: txt2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Live Price
              </div>
              <div style={{
                fontSize: '1.1rem', fontWeight: 800, color: '#ef4444',
                fontVariantNumeric: 'tabular-nums',
                animation: livePrice ? 'priceFlash 0.3s ease' : 'none',
              }}>
                {livePrice != null ? livePrice.toFixed(pipSizeRef.current) : '—'}
              </div>
            </div>
          </div>

          {/* ── Digit circles ── */}
          <div style={{ padding: '1.25rem 1rem 0.75rem', borderBottom: `1px solid ${bdr}`, background: bg0 }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '1rem', fontSize: '0.78rem', color: txt2 }}>
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
              background: 'var(--bdr)',
              flex: 1,
            }}>
              {/* flash fires on the last Sequence box of the active contract type's card only */}
              <Card title="Over / Under" streak={ouData.streak} streakLabel={ouData.streakLabel}>
                <DigitPicker selected={ouBarrier} onSelect={setOuBarrier} />
                <Bar label="Over"  color="#22c55e" count={ouData.over}  total={total} />
                <Bar label="Under" color="#3b82f6" count={ouData.under} total={total} />
                <Sequence seq={ouData.seq.slice(-20)} rawDigits={ouData.rawDigits.slice(-20)} colorMap={ouColors}
                  flash={(contractType === 'DIGITOVER' || contractType === 'DIGITUNDER') ? tradeFlash : null}
                  tickN={tickN} />
              </Card>

              <Card title="Match / Differ" streak={mdData.streak} streakLabel={mdData.streakLabel}>
                <DigitPicker selected={mdDigit} onSelect={setMdDigit} />
                <Bar label="Match"  color="#ef4444" count={mdData.match}  total={total} />
                <Bar label="Differ" color="#a855f7" count={mdData.differ} total={total} />
                <Sequence seq={mdData.seq.slice(-20)} rawDigits={mdData.rawDigits.slice(-20)} colorMap={mdColors}
                  flash={(contractType === 'DIGITMATCH' || contractType === 'DIGITDIFF') ? tradeFlash : null}
                  tickN={tickN} />
              </Card>

              <Card title="Even / Odd" streak={eoData.streak} streakLabel={eoData.streakLabel}>
                <Bar label="Even" color="#FCA311" count={eoData.even} total={total} />
                <Bar label="Odd"  color="#ef4444" count={eoData.odd}  total={total} />
                <Sequence seq={eoData.seq.slice(-20)} colorMap={eoColors}
                  flash={(contractType === 'DIGITEVEN' || contractType === 'DIGITODD') ? tradeFlash : null}
                  tickN={tickN} />
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
        accountLabel={accountLabel}
        txLog={txLog}
        onViewDetail={() => setShowDetailModal(true)}
        lastContractSummary={lastContractSummary}
        pipSize={pipSizeRef.current}
      />

      {/* ── View Detail Modal ── */}
      {showDetailModal && (
        <ViewDetailModal
          onClose={() => setShowDetailModal(false)}
          txLog={txLog}
          stats={runStats}
          accountId={activeAccountId}
          currency={currency}
          pipSize={pipSizeRef.current}
        />
      )}

      {/* ── Run Bar (sticky bottom) ── */}
      <RunBar
        running={running}
        onToggleRun={() => {
          if (running) {
            runningRef.current = false   // sync immediately — prevents race
            setRunning(false)
          } else {
            // Set ref synchronously BEFORE state update so any concurrent WS
            // callback sees running=true immediately.
            runningRef.current = true
            setRunning(true)
            // Fire the first buy RIGHT NOW — before React re-renders.
            // This eliminates the ~16ms browser-frame gap that would otherwise
            // occur if we waited for the useEffect to trigger executeTrade.
            if (botWsRef.current?.readyState === WebSocket.OPEN) {
              executeTrade(botWsRef.current)
            }
            // If WS not open yet (still connecting), onopen will fire executeTrade
            // automatically because runningRef.current is already true.
          }
        }}
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
        @keyframes pendingPulse {
          0%, 100% { opacity: 0.55; }
          50%       { opacity: 1; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
