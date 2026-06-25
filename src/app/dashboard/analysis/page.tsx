'use client'

import { useState, useEffect, useRef, useMemo } from 'react'

/* ─── Constants ─────────────────────────────────────────── */
const WS_URL      = 'wss://ws.binaryws.com/websockets/v3?app_id=1089'
const MAX_HISTORY = 5000   // always request this much; tickCount just filters analysis

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
  const [activeTab, setActiveTab] = useState<'circles' | 'scanner'>('circles')
  const [symbol,    setSymbol]    = useState('1HZ100V')
  const [tickCount, setTickCount] = useState(1000)
  const [prices,    setPrices]    = useState<number[]>([])
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [ouBarrier, setOuBarrier] = useState(5)
  const [mdDigit,   setMdDigit]   = useState(5)

  const wsRef = useRef<WebSocket | null>(null)

  /* ── WebSocket: re-init on symbol change ── */
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

  /* ── Derived data ── */
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

  return (
    <div style={{ background: '#000', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>

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
              {/* Over / Under */}
              <Card title="Over / Under" streak={ouData.streak} streakLabel={ouData.streakLabel}>
                <DigitPicker selected={ouBarrier} onSelect={setOuBarrier} />
                <Bar label="Over"  color="#22c55e" count={ouData.over}  total={total} />
                <Bar label="Under" color="#3b82f6" count={ouData.under} total={total} />
                <Sequence seq={ouData.seq.slice(-10)} colorMap={ouColors} />
              </Card>

              {/* Match / Differ */}
              <Card title="Match / Differ" streak={mdData.streak} streakLabel={mdData.streakLabel}>
                <DigitPicker selected={mdDigit} onSelect={setMdDigit} />
                <Bar label="Match"  color="#ef4444" count={mdData.match}  total={total} />
                <Bar label="Differ" color="#a855f7" count={mdData.differ} total={total} />
                <Sequence seq={mdData.seq.slice(-10)} colorMap={mdColors} />
              </Card>

              {/* Even / Odd */}
              <Card title="Even / Odd" streak={eoData.streak} streakLabel={eoData.streakLabel}>
                <Bar label="Even" color="#FCA311" count={eoData.even} total={total} />
                <Bar label="Odd"  color="#ef4444" count={eoData.odd}  total={total} />
                <Sequence seq={eoData.seq.slice(-10)} colorMap={eoColors} />
              </Card>

              {/* Rise / Fall */}
              <Card title="Rise / Fall" streak={rfData.streak} streakLabel={rfData.streakLabel}>
                <Bar label="Rise" color="#22c55e" count={rfData.rise} total={rfData.total} />
                <Bar label="Fall" color="#ef4444" count={rfData.fall} total={rfData.total} />
                <Sequence seq={rfData.seq.slice(-10)} colorMap={rfColors} />
              </Card>
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes priceFlash {
          0%   { opacity: 0.5; transform: scale(1.06); }
          100% { opacity: 1;   transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
