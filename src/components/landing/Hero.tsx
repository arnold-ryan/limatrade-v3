'use client'

import { useEffect, useRef, useState } from 'react'

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

export default function Hero() {
  // Typewriter
  const [text, setText] = useState('')
  const lineIdx = useRef(0)
  const charIdx = useRef(0)
  const deleting = useRef(false)

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

  const reviews = [...REVIEWS, ...REVIEWS]

  return (
    <section style={{ minHeight: '100vh', paddingTop: '9rem', background: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', overflow: 'hidden' }}>

      {/* Radial gold glow bg */}
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
          <a href="/api/auth/login?mode=signup"
            className="btn-glow inline-flex items-center gap-2 rounded-full font-bold text-black px-10 py-4 text-lg"
            style={{ background: 'var(--gold)' }}>
            Start Trading Now
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </svg>
          </a>
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
              {s.prefix ?? ''}{s.value <= 10 ? counts[i].toFixed(1) : Math.round(counts[i]).toLocaleString()}{s.suffix}
            </div>
            <div className="text-sm mt-1.5" style={{ color: 'var(--silver)' }}>{s.label}</div>
          </div>
        ))}
      </div>

    </section>
  )
}
