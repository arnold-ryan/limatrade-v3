import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * POST /api/signals/charts
 *
 * The Charts page's "AI Analysis" signal panel — moved server-side so the
 * scoring (z-score thresholds, window sizes, the EMA/RSI/streak/channel
 * consensus weights for Rise/Fall) never ships in client JS. Two actions:
 *
 *  - "scan": background recommendation for all four trade-type families,
 *    computed every tick on the client's cadence. Returns the same shape the
 *    client used to compute locally (MD/EO/OU/RF + the Rise/Fall vote detail).
 *  - "revalidate": after a losing trade, checks whether the specific signal
 *    that was traded still holds (used to decide whether to keep showing it
 *    or fall back to "analyzing"). This is intentionally a narrower check
 *    than "scan" — it re-tests the one instrument that was actually traded,
 *    not "is there now a better one" — so it must stay a separate code path,
 *    not a re-use of "scan"'s best-of picking.
 */

type OUType = 'OVER' | 'UNDER'
type EOType = 'EVEN' | 'ODD'
type BgRec  = { type: 'OVER'|'UNDER'|'EVEN'|'ODD'|'DIFFER'; barrier?: number; edge: number; z: number } | null
type RFRec  = { type: 'RISE'|'FALL'; score: number; rsi: number; channelPos: number; emaVote: number; streakVote: number; channelVote: number } | null

function computeRF(rfPrices: number[]): { rec: RFRec; sigData: Record<string, unknown> | null } {
  if (rfPrices.length < 25) return { rec: null, sigData: null }
  const last25 = rfPrices.slice(-25)
  const calcEMA = (prices: number[], n: number) => {
    const k = 2 / (n + 1); let ema = prices[0]
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k)
    return ema
  }
  const emaFast  = calcEMA(last25.slice(-10), 5)
  const emaSlow  = calcEMA(last25, 20)
  const emaVote  = emaFast > emaSlow ? 1 : emaFast < emaSlow ? -1 : 0
  const rsiPrices = last25.slice(-15); let gains = 0, losses = 0
  for (let i = 1; i < rsiPrices.length; i++) {
    const diff = rsiPrices[i] - rsiPrices[i - 1]
    if (diff > 0) gains += diff; else losses -= diff
  }
  const avgGain = gains / 14; const avgLoss = losses / 14
  const rsi      = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss))
  const rsiVote  = rsi < 35 ? 1 : rsi > 65 ? -1 : 0
  const recent   = last25.slice(-8); let streak = 1
  const lastDir  = recent[recent.length - 1] > recent[recent.length - 2]
  for (let i = recent.length - 2; i > 0; i--) {
    if ((recent[i] > recent[i - 1]) === lastDir) streak++; else break
  }
  const streakVote  = streak >= 4 ? (lastDir ? -1 : 1) : 0
  const win20       = last25.slice(-20)
  const hiW = Math.max(...win20); const loW = Math.min(...win20)
  const channelPos  = (hiW - loW) === 0 ? 0.5 : (win20[win20.length - 1] - loW) / (hiW - loW)
  const channelVote = channelPos < 0.25 ? 1 : channelPos > 0.75 ? -1 : 0
  const totalScore  = emaVote + rsiVote + streakVote + channelVote
  const rfDir: 'RISE'|'FALL'|null = Math.abs(totalScore) >= 3 ? (totalScore > 0 ? 'RISE' : 'FALL') : null
  const sigData = { emaVote, rsi, rsiVote, streak, streakVote, channelPos, channelVote, score: Math.abs(totalScore), dir: rfDir }
  const rec: RFRec = rfDir ? { type: rfDir, score: Math.abs(totalScore), rsi, channelPos, emaVote, streakVote, channelVote } : null
  return { rec, sigData }
}

function scan(digits: number[], prices: number[]) {
  const arr = digits
  const empty = { MD: null as BgRec, EO: null as BgRec, OU: null as BgRec, RF: null as RFRec, rfSigData: null as Record<string, unknown> | null, edges: {} as Record<string, number> }
  if (arr.length < 60) return empty

  const slice   = arr.slice(-100); const n = slice.length
  const freq    = Array(10).fill(0); slice.forEach((d: number) => freq[d]++)
  const f       = freq.map((c: number) => c / n)

  const slice50 = arr.slice(-50)
  const freq50  = Array(10).fill(0); slice50.forEach((d: number) => freq50[d]++)
  const f50     = freq50.map((c: number) => c / slice50.length)

  const slice25 = arr.slice(-25)
  const freq25  = Array(10).fill(0); slice25.forEach((d: number) => freq25[d]++)
  const f25     = freq25.map((c: number) => c / slice25.length)

  const slice10 = arr.slice(-10)
  const freq10  = Array(10).fill(0); slice10.forEach((d: number) => freq10[d]++)
  const f10     = freq10.map((c: number) => c / slice10.length)

  // MD — Differ only (cold digit across four windows)
  let bestMD: BgRec = null
  {
    const p_exp = 0.1
    for (let d = 0; d <= 9; d++) {
      const edge = f[d] - p_exp
      const z    = edge / Math.sqrt(p_exp * (1 - p_exp) / n)
      if (z <= -1.5 && (f50[d] - p_exp) <= -0.02 && (f25[d] - p_exp) <= 0 && f10[d] <= 0.10) {
        const absZ = -z
        if (!bestMD || absZ > bestMD.z) bestMD = { type: 'DIFFER', barrier: d, edge: -edge, z: absZ }
      }
    }
  }

  // EO — Even/Odd (triple window + streak guard)
  let bestEO: BgRec = null
  {
    const EVEN = [0, 2, 4, 6, 8]; const p_exp = 0.5
    let obsEven = 0, obsEven50 = 0, obsEven25 = 0
    EVEN.forEach(d => { obsEven += f[d]; obsEven50 += f50[d]; obsEven25 += f25[d] })
    const zEven = (obsEven - p_exp) / Math.sqrt(p_exp * (1 - p_exp) / n)
    let evenCount10 = 0; slice10.forEach((d: number) => { if (d % 2 === 0) evenCount10++ })
    const evenFreq10 = evenCount10 / slice10.length
    if (zEven >= 1.45 && (obsEven50 - p_exp) > 0 && (obsEven25 - p_exp) > 0 && evenFreq10 >= 0.40) {
      bestEO = { type: 'EVEN', edge: obsEven - p_exp, z: zEven }
    } else if (-zEven >= 1.45 && ((1-obsEven50) - p_exp) > 0 && ((1-obsEven25) - p_exp) > 0 && evenFreq10 <= 0.60) {
      bestEO = { type: 'ODD', edge: (1-obsEven) - p_exp, z: -zEven }
    }
  }

  // OU — Over/Under (dual window)
  let bestOU: BgRec = null
  {
    for (let b = 1; b <= 5; b++) {
      const p_exp = (9-b)/10; let obs = 0, obs50 = 0
      for (let d = b+1; d <= 9; d++) { obs += f[d]; obs50 += f50[d] }
      const edge = obs - p_exp; const z = edge / Math.sqrt(p_exp*(1-p_exp)/n)
      if (z >= 1.28 && (obs50-p_exp) > 0) {
        if (!bestOU || z > bestOU.z) bestOU = { type: 'OVER', barrier: b, edge, z }
      }
    }
    for (let b = 6; b <= 8; b++) {
      const p_exp = b/10; let obs = 0, obs50 = 0
      for (let d = 0; d < b; d++) { obs += f[d]; obs50 += f50[d] }
      const edge = obs - p_exp; const z = edge / Math.sqrt(p_exp*(1-p_exp)/n)
      if (z >= 1.28 && (obs50-p_exp) > 0) {
        if (!bestOU || z > bestOU.z) bestOU = { type: 'UNDER', barrier: b, edge, z }
      }
    }
  }

  const { rec: bestRF, sigData: rfSigData } = computeRF(prices)

  // Tile edge colors for every type (client picks whichever tab is active)
  const edges: Record<string, number> = {}
  const p_exp_md = 0.1
  for (let d = 0; d <= 9; d++) edges[`D${d}`] = f[d] - p_exp_md
  const EVEN = [0,2,4,6,8]; let obsEven = 0
  EVEN.forEach(d => obsEven += f[d])
  edges['EV'] = obsEven - 0.5; edges['OD'] = (1-obsEven) - 0.5
  for (let b = 1; b <= 5; b++) {
    const p_exp = (9-b)/10; let obs = 0
    for (let d = b+1; d <= 9; d++) obs += f[d]
    edges[`O${b}`] = obs - p_exp
  }
  for (let b = 6; b <= 8; b++) {
    const p_exp = b/10; let obs = 0
    for (let d = 0; d < b; d++) obs += f[d]
    edges[`U${b}`] = obs - p_exp
  }

  return { MD: bestMD, EO: bestEO, OU: bestOU, RF: bestRF, rfSigData, edges }
}

function revalidate(
  digits: number[], prices: number[],
  rec: { type: string; barrier?: number } | null,
  consecLoss: number,
): boolean {
  if (!rec || consecLoss >= 2) return false

  if (rec.type === 'RISE' || rec.type === 'FALL') {
    if (prices.length < 25) return false
    const { rec: rfRec } = computeRF(prices)
    return !!rfRec && rfRec.type === rec.type
  }

  const arr = digits
  if (arr.length < 60) return false
  const slice = arr.slice(-100); const n = slice.length
  const freq  = Array(10).fill(0); slice.forEach((d: number) => freq[d]++)
  const f     = freq.map((c: number) => c / n)
  const slice50 = arr.slice(-50)
  const freq50  = Array(10).fill(0); slice50.forEach((d: number) => freq50[d]++)
  const f50     = freq50.map((c: number) => c / slice50.length)

  if (rec.type === 'OVER' && rec.barrier != null) {
    const b = rec.barrier
    const p_exp = (9 - b) / 10
    let obs = 0; for (let d = b + 1; d <= 9; d++) obs += f[d]
    const z = (obs - p_exp) / Math.sqrt(p_exp * (1 - p_exp) / n)
    let obs50 = 0; for (let d = b + 1; d <= 9; d++) obs50 += f50[d]
    return z >= 1.28 && (obs50 - p_exp) > 0
  }
  if (rec.type === 'UNDER' && rec.barrier != null) {
    const b = rec.barrier
    const p_exp = b / 10
    let obs = 0; for (let d = 0; d < b; d++) obs += f[d]
    const z = (obs - p_exp) / Math.sqrt(p_exp * (1 - p_exp) / n)
    let obs50 = 0; for (let d = 0; d < b; d++) obs50 += f50[d]
    return z >= 1.28 && (obs50 - p_exp) > 0
  }
  if (rec.type === 'DIFFER' && rec.barrier != null) {
    const slice25 = arr.slice(-25)
    const freq25  = Array(10).fill(0); slice25.forEach((d: number) => freq25[d]++)
    const f25 = freq25.map((c: number) => c / slice25.length)
    const slice10 = arr.slice(-10)
    const freq10  = Array(10).fill(0); slice10.forEach((d: number) => freq10[d]++)
    const f10 = freq10.map((c: number) => c / slice10.length)
    const b = rec.barrier
    const p_exp = 0.1
    const z = (f[b] - p_exp) / Math.sqrt(p_exp * (1 - p_exp) / n)
    return z <= -1.5 && (f50[b] - p_exp) <= -0.02 && (f25[b] - p_exp) <= 0 && f10[b] <= 0.10
  }
  if (rec.type === 'EVEN' || rec.type === 'ODD') {
    const slice25 = arr.slice(-25)
    const freq25  = Array(10).fill(0); slice25.forEach((d: number) => freq25[d]++)
    const f25 = freq25.map((c: number) => c / slice25.length)
    const EVEN    = [0, 2, 4, 6, 8]
    const isEven  = rec.type === 'EVEN'
    let obs = 0;   EVEN.forEach(d => obs   += f[d]);   if (!isEven) obs   = 1 - obs
    let obs50 = 0; EVEN.forEach(d => obs50 += f50[d]); if (!isEven) obs50 = 1 - obs50
    let obs25 = 0; EVEN.forEach(d => obs25 += f25[d]); if (!isEven) obs25 = 1 - obs25
    const z = (obs - 0.5) / Math.sqrt(0.25 / n)
    const sl10 = arr.slice(-10)
    let ec10 = 0; sl10.forEach((d: number) => { if (d % 2 === 0) ec10++ })
    const ef10 = ec10 / sl10.length
    const sgOk = isEven ? ef10 >= 0.40 : ef10 <= 0.60
    return z >= 1.45 && (obs50 - 0.5) > 0 && (obs25 - 0.5) > 0 && sgOk
  }
  return false
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    action?: string
    digits?: unknown
    prices?: unknown
    rec?: { type?: string; barrier?: number } | null
    consecLoss?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const digits = Array.isArray(body.digits) ? body.digits.filter((d): d is number => typeof d === 'number') : []
  const prices = Array.isArray(body.prices) ? body.prices.filter((p): p is number => typeof p === 'number') : []
  if (digits.length > 500 || prices.length > 500) {
    return NextResponse.json({ error: 'input_too_long' }, { status: 400 })
  }

  if (body.action === 'scan') {
    return NextResponse.json(scan(digits, prices))
  }

  if (body.action === 'revalidate') {
    const rec = body.rec && typeof body.rec.type === 'string' ? { type: body.rec.type, barrier: body.rec.barrier } : null
    const consecLoss = typeof body.consecLoss === 'number' ? body.consecLoss : 0
    return NextResponse.json({ stillValid: revalidate(digits, prices, rec, consecLoss) })
  }

  return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
}
