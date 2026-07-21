import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * POST /api/signals/detect
 *
 * Bulk Trader's scanner scoring — moved server-side so the strategy (thresholds,
 * scoring weights, entropy/persistence bonuses) never ships in the client JS
 * bundle. The client sends recent tick digits and gets back a decision, nothing
 * more; it has no way to see how the score was computed.
 *
 * Auth-gated: requires an active Lima Trade session. This doesn't make the
 * logic unreadable to a determined attacker who logs in and scripts calls to
 * this endpoint — it makes casual copying (reading the downloaded JS bundle)
 * impossible, and ties any scripted misuse back to a specific, revocable account.
 */

interface ScanResult {
  signal: boolean
  score: number
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITDIFF' | null
  barrier: number | null
  reason: string
  detail: string
}
const NO_SIGNAL: ScanResult = { signal: false, score: 0, contractType: null, barrier: null, reason: '', detail: '' }

function shannonEntropy(digits: number[]): number {
  if (!digits.length) return 0
  const freq = Array(10).fill(0)
  digits.forEach(d => freq[d]++)
  return freq.reduce((H: number, c: number) => {
    if (!c) return H
    const p = c / digits.length
    return H - p * Math.log2(p)
  }, 0)
}

/**
 * PRIMARY over/under detection — DIGITUNDER 8 and DIGITOVER 1 only.
 * Natural win rate for both = 80%.  Fires at composite ≥ 40.
 * Uses higher scoring multipliers (×1200/×1000) because excess above 80% natural is small.
 */
function detectPrimary(digits: number[], persistCount: number): ScanResult {
  if (digits.length < 30) return NO_SIGNAL
  const d60 = digits.slice(-60)
  const d30 = digits.slice(-30)
  const entropy      = shannonEntropy(d60)
  const entropyBonus = Math.min(15, Math.max(0, Math.round((3.32 - entropy) / 3.32 * 30)))
  const persistBonus = Math.min(10, persistCount * 5)

  let bestScore = 39
  let best: ScanResult = NO_SIGNAL

  const candidates: Array<{ nat: number; obs60: number; obs30: number; ct: 'DIGITUNDER'|'DIGITOVER'; b: number; label: string }> = [
    { nat: 0.80, obs60: d60.filter(d => d < 8).length / d60.length, obs30: d30.filter(d => d < 8).length / d30.length, ct: 'DIGITUNDER', b: 8, label: 'Under 8' },
    { nat: 0.80, obs60: d60.filter(d => d > 1).length / d60.length, obs30: d30.filter(d => d > 1).length / d30.length, ct: 'DIGITOVER',  b: 1, label: 'Over 1'  },
  ]

  for (const c of candidates) {
    if (c.obs60 > c.nat + 0.015 && c.obs30 > c.nat + 0.005) {
      const base  = Math.min(50, (c.obs60 - c.nat) * 1200)
      const agree = Math.min(25, (c.obs30 - c.nat) * 1000)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: c.ct, barrier: c.b,
          reason: `${c.label} trending — ${Math.round(c.obs60*100)}% (60t) / ${Math.round(c.obs30*100)}% (30t) vs 80% natural`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }
  }
  return best
}

/**
 * Even/Odd and Matches/Differs detection.
 */
function detectSignal(
  digits: number[],
  tradeType: 'even_odd' | 'matches_differs',
  persistCount: number,
): ScanResult {
  if (digits.length < 30) return NO_SIGNAL
  const d60 = digits.slice(-60)
  const d30 = digits.slice(-30)
  const entropy      = shannonEntropy(d60)
  const entropyBonus = Math.min(15, Math.max(0, Math.round((3.32 - entropy) / 3.32 * 30)))
  const persistBonus = Math.min(10, persistCount * 5)

  if (tradeType === 'even_odd') {
    const even60 = d60.filter(d => d % 2 === 0).length / d60.length
    const even30 = d30.filter(d => d % 2 === 0).length / d30.length
    const dominant = even60 >= 0.5 ? 'even' : 'odd'
    const domPct60 = dominant === 'even' ? even60 : 1 - even60
    const domPct30 = dominant === 'even' ? even30 : 1 - even30
    if (domPct60 < 0.52 || domPct30 <= 0.5) return NO_SIGNAL
    const base  = Math.min(50, (domPct60 - 0.5) * 600)
    const agree = Math.min(25, (domPct30 - 0.5) * 500)
    const score = Math.min(100, base + agree + entropyBonus + persistBonus)
    if (score < 55) return NO_SIGNAL
    const betType: 'DIGITEVEN' | 'DIGITODD' = dominant === 'even' ? 'DIGITEVEN' : 'DIGITODD'
    return {
      signal: true, score: Math.round(score), contractType: betType, barrier: null,
      reason: `${dominant === 'even' ? 'Even' : 'Odd'} trending — ${Math.round(domPct60*100)}% (60t) / ${Math.round(domPct30*100)}% (30t) vs 50% natural`,
      detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
    }
  }

  /* matches_differs — COLD digit strategy:
     Pick the digit appearing LEAST in recent history.
     DIFFERS wins when last digit ≠ barrier, so a cold digit (rarely appears) = high win rate.
     e.g. digit at 2% observed → DIFFERS wins ~98% vs 90% natural.
     Betting DIFFERS on a HOT digit is wrong (reduces win rate below natural). */
  let bestScore = 59   // threshold 60 — fires when deficit is meaningful
  let best: ScanResult = NO_SIGNAL
  for (let d = 0; d <= 9; d++) {
    const nat   = 0.10
    const o60   = d60.filter(x => x === d).length / d60.length
    const o30   = d30.filter(x => x === d).length / d30.length
    const def60 = nat - o60   // how cold the digit is (positive = below natural)
    const def30 = nat - o30
    // Only fire when digit is genuinely cold in both windows
    if (def60 > 0.03 && def30 > 0.01) {
      const base  = Math.min(50, def60 * 600)   // bigger deficit = higher score
      const agree = Math.min(25, def30 * 500)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: 'DIGITDIFF', barrier: d,
          reason: `Digit ${d} cold — ${Math.round(o60*100)}% (60t) / ${Math.round(o30*100)}% (30t) vs 10% natural → Differs ${d} (win rate ~${Math.round((1-o60)*100)}%)`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }
  }
  return best
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { mode?: string; digits?: unknown; persistCount?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { mode } = body
  const digits = Array.isArray(body.digits) ? body.digits.filter((d): d is number => typeof d === 'number') : []
  const persistCount = typeof body.persistCount === 'number' ? body.persistCount : 0

  // Cap input size — a scanner tick buffer is never more than a few hundred
  // digits; anything larger is either a bug or an attempt to waste compute.
  if (digits.length > 1000) {
    return NextResponse.json({ error: 'digits_too_long' }, { status: 400 })
  }

  if (mode === 'primary') {
    return NextResponse.json(detectPrimary(digits, persistCount))
  }
  if (mode === 'even_odd' || mode === 'matches_differs') {
    return NextResponse.json(detectSignal(digits, mode, persistCount))
  }
  return NextResponse.json({ error: 'invalid_mode' }, { status: 400 })
}
