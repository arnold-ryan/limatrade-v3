'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const LINES = [
  'Deploy ready-made trading bots in minutes.',
  'Copy top performers automatically.',
  'Automate strategies — no coding required.',
  'Trade with real-time Deriv market data.',
]

const REVIEWS = [
  { initials: 'MG', name: 'Mark Gonzales',  role: 'Day Trader',          quote: '"The automated bots handle my strategies flawlessly. Consistent profits from day one."' },
  { initials: 'KM', name: 'Kelvin Maxwell', role: 'Crypto Investor',     quote: '"Portfolio up 40% in 3 months. Copy trading makes it effortless."' },
  { initials: 'DG', name: 'Delvoux Glen',   role: 'Forex Specialist',    quote: '"Lightning-fast execution. The risk tools saved me from major losses."' },
  { initials: 'AK', name: 'Aisha Khan',     role: 'Algorithmic Trader',  quote: '"Automated my setups without writing a single line of code."' },
  { initials: 'JO', name: 'James Okoro',    role: 'Independent Trader',  quote: '"Bots and copy trading in one place saves me hours every week."' },
  { initials: 'SL', name: 'Sophie Laurent', role: 'Options Trader',      quote: '"Monitor signals, adjust risk, and check bots from anywhere."' },
  { initials: 'RP', name: 'Raj Patel',      role: 'Quant Analyst',       quote: '"Clean charts, reliable data, and real drawdown control."' },
  { initials: 'EP', name: 'Elena Petrova',  role: 'Portfolio Manager',   quote: '"Steady growth without watching charts all day."' },
]

const STATS = [
  { value: 50,    suffix: 'K+',  label: 'Active Traders'  },
  { value: 2.5,   prefix: '$', suffix: 'B+',  label: 'Trading Volume'  },
  { value: 99.9,  suffix: '%',   label: 'Uptime'          },
  { value: 150,   suffix: '+',   label: 'Trading Pairs'   },
]

const RISK_ITEMS = [
  'Trading derivatives involves significant risk. You may lose all funds you invest.',
  'Past performance of any trading strategy does not guarantee future results.',
  'Automated bots do not guarantee profit — all trading involves risk of loss.',
  'Never trade with money you cannot afford to lose, including borrowed funds.',
  'Lima Trade provides tools only; you are solely responsible for your trading decisions.',
]

const AUTH_ERRORS: Record<string, string> = {
  no_tokens_received:    'Login was cancelled or failed. Please try again.',
  no_accounts:           'No Deriv accounts were returned. Please try logging in again.',
  server_error:          'A server error occurred. Please try again in a moment.',
  network:               'Network error during login. Check your connection and try again.',
  invalid_session:       'Your login attempt expired before it finished. Please try logging in again.',
  missing_state:         'Your login attempt expired before it finished. Please try logging in again.',
}

function StarRow() {
  return (
    <div className="flex gap-1">
      {[...Array(5)].map((_, i) => (
        <svg key={i} width="13" height="13" viewBox="0 0 24 24" fill="var(--gold)">
          <path d="M12 17.3l-6.18 3.73 1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.46 4.76 1.64 7.03z"/>
        </svg>
      ))}
    </div>
  )
}

/* ── Risk Acknowledgment Modal ── */
function RiskModal({ onAccept, onClose }: { onAccept: () => void; onClose: () => void }) {
  const [checked, setChecked] = useState(false)

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '1.5rem',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#0d0d0d', border: '1px solid rgba(252,163,17,0.25)',
        borderRadius: '18px', padding: '2rem', maxWidth: '520px', width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
              <path d="M12 9v4"/><path d="M12 17h.01"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff' }}>Risk Warning</div>
            <div style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.45)', marginTop: '1px' }}>
              Please read before continuing
            </div>
          </div>
        </div>

        {/* Risk items */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1.5rem' }}>
          {RISK_ITEMS.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
              <span style={{
                marginTop: '3px', width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
                background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.55rem', fontWeight: 800, color: '#ef4444',
              }}>
                !
              </span>
              <p style={{ fontSize: '0.78rem', color: 'rgba(229,229,229,0.65)', lineHeight: 1.5, margin: 0 }}>
                {item}
              </p>
            </div>
          ))}
        </div>

        {/* Acknowledgment checkbox */}
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: '0.65rem',
          padding: '0.85rem', borderRadius: '10px', cursor: 'pointer',
          background: checked ? 'rgba(34,197,94,0.07)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${checked ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.1)'}`,
          marginBottom: '1.25rem', transition: 'all 0.2s',
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
            style={{ marginTop: '2px', accentColor: '#22c55e', width: '15px', height: '15px', flexShrink: 0, cursor: 'pointer' }}
          />
          <span style={{ fontSize: '0.8rem', color: checked ? 'rgba(229,229,229,0.85)' : 'rgba(229,229,229,0.55)', lineHeight: 1.5 }}>
            I understand that trading derivatives involves substantial risk of loss and is not suitable for all investors. I am responsible for my own trading decisions.
          </span>
        </label>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '0.75rem', borderRadius: '10px',
              border: '1px solid rgba(255,255,255,0.12)', background: 'transparent',
              color: 'rgba(229,229,229,0.55)', fontSize: '0.85rem', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onAccept}
            disabled={!checked}
            style={{
              flex: 2, padding: '0.75rem', borderRadius: '10px', border: 'none',
              background: checked ? 'var(--gold)' : 'rgba(255,255,255,0.08)',
              color: checked ? '#000' : 'rgba(229,229,229,0.25)',
              fontSize: '0.9rem', fontWeight: 800,
              cursor: checked ? 'pointer' : 'not-allowed',
              transition: 'background 0.2s, color 0.2s',
            }}
          >
            I Understand — Continue
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Auth Error Banner ── */
function AuthErrorBanner() {
  const params = useSearchParams()
  const error = params.get('auth_error')
  if (!error) return null
  const message = AUTH_ERRORS[error] ?? `Login error: ${error}. Please try again.`
  return (
    <div style={{
      position: 'fixed', top: '80px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
      borderRadius: '12px', padding: '0.75rem 1.25rem',
      display: 'flex', alignItems: 'center', gap: '0.6rem',
      zIndex: 200, backdropFilter: 'blur(8px)',
      maxWidth: '90vw', boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
    }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span style={{ fontSize: '0.82rem', color: 'rgba(229,229,229,0.85)' }}>{message}</span>
    </div>
  )
}

export default function Hero() {
  // Typewriter
  const [text, setText] = useState('')
  const lineIdx = useRef(0)
  const charIdx = useRef(0)
  const deleting = useRef(false)

  // Risk modal
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function tick() {
      const line = LINES[lineIdx.current]
      if (!deleting.current) {
        setText(line.slice(0, ++charIdx.current))
        if (charIdx.current === line.length) { deleting.current = true; timer = setTimeout(tick, 2200); return }
        timer = setTimeout(tick, 48)
      } else {
        setText(line.slice(0, --charIdx.current))
        if (charIdx.current === 0) {
          deleting.current = false
          lineIdx.current = (lineIdx.current + 1) % LINES.length
          timer = setTimeout(tick, 400); return
        }
        timer = setTimeout(tick, 28)
      }
    }
    timer = setTimeout(tick, 800)
    return () => clearTimeout(timer)
  }, [])

  // Counter animation
  const statsRef = useRef<HTMLDivElement>(null)
  const [counts, setCounts] = useState(STATS.map(() => 0))
  const animated = useRef(false)

  useEffect(() => {
    const el = statsRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || animated.current) return
      animated.current = true
      STATS.forEach((s, i) => {
        const dur = 1800, start = performance.now()
        function frame(now: number) {
          const p = Math.min((now - start) / dur, 1)
          const ease = 1 - Math.pow(1 - p, 3)
          setCounts(c => { const n = [...c]; n[i] = ease * s.value; return n })
          if (p < 1) requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
    }, { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  function handleCTAClick(e: React.MouseEvent) {
    e.preventDefault()
    // Check if user already acknowledged risk in this session
    try {
      const ack = localStorage.getItem('lt_risk_ack')
      if (ack && Date.now() - parseInt(ack) < 24 * 60 * 60 * 1000) {
        // Acknowledged within last 24h — go straight to login
        window.location.href = '/api/auth/login'
        return
      }
    } catch { /* localStorage unavailable in some browsers */ }
    setShowModal(true)
  }

  function handleAccept() {
    try { localStorage.setItem('lt_risk_ack', String(Date.now())) } catch { /* ignore */ }
    setShowModal(false)
    window.location.href = '/api/auth/login'
  }

  const reviews = [...REVIEWS, ...REVIEWS]

  return (
    <>
      {/* Auth error banner */}
      <Suspense fallback={null}>
        <AuthErrorBanner />
      </Suspense>

      {/* Risk modal */}
      {showModal && (
        <RiskModal onAccept={handleAccept} onClose={() => setShowModal(false)} />
      )}

      <section style={{ minHeight: '100vh', paddingTop: '9rem', background: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', overflow: 'hidden' }}>

        {/* Radial gold glow */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'radial-gradient(ellipse 80% 50% at 50% 20%, rgba(252,163,17,0.07) 0%, transparent 70%)' }} />

        {/* Hero copy */}
        <div className="animate-fade-up" style={{ maxWidth: '840px', width: '100%', padding: '3rem 2rem 0', textAlign: 'center', zIndex: 1 }}>

          {/* Badge */}
          <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold mb-8"
            style={{ background: 'rgba(252,163,17,0.12)', border: '1px solid rgba(252,163,17,0.35)', color: 'var(--gold)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
            </svg>
            Trusted by 50,000+ Traders Worldwide
          </div>

          {/* Headline */}
          <h1 style={{ fontSize: 'clamp(3.4rem, 6vw, 6.5rem)', fontWeight: 900, lineHeight: 1.08, letterSpacing: '-0.03em', marginBottom: '1.2rem' }}>
            Trade smarter,<br />
            <span style={{ color: 'var(--gold)' }}>not harder</span>
          </h1>

          {/* Typewriter */}
          <p style={{ minHeight: '3rem', fontSize: 'clamp(1.4rem, 2vw, 1.8rem)', color: 'var(--silver)', marginBottom: '2.8rem' }}>
            {text}<span style={{ display: 'inline-block', width: '2px', height: '1em', background: 'var(--gold)', marginLeft: '2px', verticalAlign: 'text-bottom', animation: 'blink 0.85s step-end infinite' }} />
          </p>

          {/* CTA */}
          <div className="flex flex-col items-center gap-4">
            <a
              href="/api/auth/login"
              onClick={handleCTAClick}
              className="btn-glow inline-flex items-center gap-2 rounded-full font-bold text-black px-10 py-4 text-lg"
              style={{ background: 'var(--gold)' }}
            >
              Start Trading Now
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
              </svg>
            </a>

            {/* Trust signals */}
            <div className="flex gap-5 flex-wrap justify-center">
              {['No Credit Card Required', '$10,000 Virtual Account', 'Full Platform Access'].map(t => (
                <span key={t} className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--silver)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>
                  </svg>
                  {t}
                </span>
              ))}
            </div>

            {/* New user affiliate CTA */}
            <p style={{ fontSize: '0.82rem', color: 'rgba(229,229,229,0.45)', margin: 0 }}>
              No Deriv account?{' '}
              <a
                href="https://deriv.partners/rx?sidc=6D203A32-6635-4783-BB11-1296C141843C&utm_campaign=dynamicworks&utm_medium=affiliate&utm_source=CU83616"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--gold)', textDecoration: 'underline', fontWeight: 600 }}
              >
                Create a free account on Deriv →
              </a>
            </p>

            {/* Deriv powered note */}
            <p style={{ fontSize: '0.72rem', color: 'rgba(229,229,229,0.3)', margin: 0 }}>
              Powered by Deriv API · Your funds remain in your Deriv account at all times
            </p>
          </div>
        </div>

        {/* Reviews marquee */}
        <div className="fade-edges relative w-full overflow-hidden mt-14" style={{ zIndex: 1 }}>
          <div className="reviews-track flex gap-4 animate-marquee py-2" style={{ width: 'max-content' }}>
            {reviews.map((r, i) => (
              <article key={i} className="rounded-2xl p-5 flex-shrink-0"
                style={{ width: '300px', background: 'var(--glass)', border: '1px solid var(--border)', backdropFilter: 'blur(10px)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-black flex-shrink-0"
                    style={{ background: 'linear-gradient(135deg, var(--gold), #c8820d)' }}>
                    {r.initials}
                  </div>
                  <div>
                    <div className="text-sm font-bold">{r.name}</div>
                    <div className="text-xs" style={{ color: 'var(--gold)' }}>{r.role}</div>
                  </div>
                </div>
                <StarRow />
                <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--silver)' }}>{r.quote}</p>
              </article>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div ref={statsRef} className="grid grid-cols-4 w-full" style={{ borderTop: '1px solid var(--border)', zIndex: 1 }}>
          {STATS.map((s, i) => (
            <div key={i} className="flex flex-col items-center py-8"
              style={{ borderRight: i < 3 ? '1px solid var(--border)' : 'none' }}>
              <div className="font-black" style={{ fontSize: 'clamp(2.4rem, 3.5vw, 3.5rem)', color: 'var(--gold)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                {s.prefix ?? ''}{Number.isInteger(s.value) ? Math.round(counts[i]).toLocaleString() : counts[i].toFixed(1)}{s.suffix}
              </div>
              <div className="text-sm mt-1.5" style={{ color: 'var(--silver)' }}>{s.label}</div>
            </div>
          ))}
        </div>

      </section>
    </>
  )
}
