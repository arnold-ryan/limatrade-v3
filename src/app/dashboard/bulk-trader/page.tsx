'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public'
const ACCENT = '#00e5cc'

const MARKETS = [
  { symbol: '1HZ100V', label: 'Volatility 100 (1s)' },
  { symbol: '1HZ75V',  label: 'Volatility 75 (1s)'  },
  { symbol: '1HZ50V',  label: 'Volatility 50 (1s)'  },
  { symbol: '1HZ25V',  label: 'Volatility 25 (1s)'  },
  { symbol: '1HZ10V',  label: 'Volatility 10 (1s)'  },
  { symbol: 'R_100',   label: 'Volatility 100'       },
  { symbol: 'R_75',    label: 'Volatility 75'        },
  { symbol: 'R_50',    label: 'Volatility 50'        },
  { symbol: 'R_25',    label: 'Volatility 25'        },
  { symbol: 'R_10',    label: 'Volatility 10'        },
]

const SCAN_SYMBOLS = ['1HZ100V', '1HZ75V', '1HZ50V', 'R_100', 'R_75']

const DIGIT_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#14b8a6',
  '#3b82f6','#8b5cf6','#ec4899','#06b6d4','#FCA311',
]

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function lastDigit(price, pipSize = 2) {
  const s = price.toFixed(pipSize)
  return parseInt(s[s.length - 1], 10)
}
function fmt2(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function shannonEntropy(digits) {
  if (!digits.length) return 0
  const freq = Array(10).fill(0)
  digits.forEach(d => freq[d]++)
  return freq.reduce((H, c) => {
    if (!c) return H
    const p = c / digits.length
    return H - p * Math.log2(p)
  }, 0)
}

/* ─── Signal detection ───────────────────────────────────────────────────── */
function detectSignal(digits, tradeType, persistCount) {
  const none = { signal: false, score: 0, contractType: null, barrier: null, reason: '', detail: '' }
  if (digits.length < 30) return none

  const d60 = digits.slice(-60)
  const d30 = digits.slice(-30)
  const entropy      = shannonEntropy(d60)
  const entropyBonus = Math.min(15, Math.max(0, Math.round((3.32 - entropy) / 3.32 * 30)))
  const persistBonus = Math.min(10, persistCount * 5)

  if (tradeType === 'even_odd') {
    const even60 = d60.filter(d => d % 2 === 0).length / d60.length
    const odd60  = 1 - even60
    const even30 = d30.filter(d => d % 2 === 0).length / d30.length
    const odd30  = 1 - even30
    const dominant = even60 >= odd60 ? 'even' : 'odd'
    const domPct60 = Math.max(even60, odd60)
    const domPct30 = dominant === 'even' ? even30 : odd30
    const agree30  = dominant === 'even' ? even30 > 0.5 : odd30 > 0.5
    if (domPct60 < 0.52 || !agree30) return none
    const base  = Math.min(50, (domPct60 - 0.5) * 600)
    const agree = Math.min(25, (domPct30 - 0.5) * 500)
    const score = Math.min(100, base + agree + entropyBonus + persistBonus)
    if (score < 55) return none
    const betType = dominant === 'even' ? 'DIGITEVEN' : 'DIGITODD'
    return {
      signal: true, score: Math.round(score), contractType: betType, barrier: null,
      reason: `${dominant === 'even' ? 'Even' : 'Odd'} trending — ${Math.round(domPct60*100)}% (60t) / ${Math.round(domPct30*100)}% (30t) vs 50% natural`,
      detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
    }
  }

  /* Over/Under — scan all barriers 1-8 */
  let bestScore = 54
  let best = none

  for (let b = 1; b <= 8; b++) {
    const uNat = b / 10
    const oNat = (9 - b) / 10
    const u60  = d60.filter(d => d < b).length / d60.length
    const o60  = d60.filter(d => d > b).length / d60.length
    const u30  = d30.filter(d => d < b).length / d30.length
    const o30  = d30.filter(d => d > b).length / d30.length

    if (u60 > uNat + 0.03 && u30 > uNat + 0.01) {
      const base  = Math.min(50, (u60 - uNat) * 600)
      const agree = Math.min(25, (u30 - uNat) * 500)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: 'DIGITUNDER', barrier: b,
          reason: `Under ${b} trending — ${Math.round(u60*100)}% (60t) / ${Math.round(u30*100)}% (30t) vs ${Math.round(uNat*100)}% natural`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }

    if (o60 > oNat + 0.03 && o30 > oNat + 0.01) {
      const base  = Math.min(50, (o60 - oNat) * 600)
      const agree = Math.min(25, (o30 - oNat) * 500)
      const score = Math.min(100, base + agree + entropyBonus + persistBonus)
      if (score > bestScore) {
        bestScore = score
        best = {
          signal: true, score: Math.round(score), contractType: 'DIGITOVER', barrier: b,
          reason: `Over ${b} trending — ${Math.round(o60*100)}% (60t) / ${Math.round(o30*100)}% (30t) vs ${Math.round(oNat*100)}% natural`,
          detail: `base=${Math.round(base)} agree=${Math.round(agree)} entropy=${entropyBonus} persist=${persistBonus}`,
        }
      }
    }
  }

  return best
}

/* ─── Digit Gauge ────────────────────────────────────────────────────────── */
function DigitGauge({ digit, count, total, liveDigit }) {
  const pct  = total > 0 ? (count / total) * 100 : 0
  const r    = 17, circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const live = liveDigit === digit
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
      <svg width="42" height="42" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="3.5"/>
        <circle cx="21" cy="21" r={r} fill="none"
          stroke={live ? '#fff' : DIGIT_COLORS[digit]}
          strokeWidth={live ? 5 : 3.5}
          strokeDasharray={`${dash} ${circ-dash}`} strokeDashoffset={circ/4}
          strokeLinecap="round"
          style={{ transition:'stroke-dasharray .3s', filter:live?`drop-shadow(0 0 5px ${DIGIT_COLORS[digit]})`:'none' }}/>
        <text x="21" y="25" textAnchor="middle" fontSize="11" fontWeight="800"
          fill={live?'#fff':DIGIT_COLORS[digit]}>{digit}</text>
      </svg>
      <span style={{ fontSize:'.6rem', color:'rgba(229,229,229,.4)' }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export default function BulkTraderPage() {
  const [symbol,    setSymbol]    = useState('1HZ100V')
  const [tradeType, setTradeType] = useState('even_odd')
  const [digit,     setDigit]     = useState(5)
  const [stake,     setStake]     = useState('1.00')
  const [bulkCount, setBulkCount] = useState('3')
  const [ticks,     setTicks]     = useState(60)

  const [livePrice,    setLivePrice]    = useState(null)
  const [recentDigits, setRecentDigits] = useState([])
  const [digitCounts,  setDigitCounts]  = useState(Array(10).fill(0))
  const pipSizeRef = useRef(2)

  const [isTrading,  setIsTrading]  = useState(false)
  const [tradeError, setTradeError] = useState(null)
  const [currency,   setCurrency]   = useState('USD')
  const reqIdRef         = useRef(0)
  const intentionalClose = useRef(false)

  const [trades, setTrades] = useState([])
  const tradeIdRef = useRef(0)

  const [scannerActive, setScannerActive] = useState(false)
  const [scannerStatus, setScannerStatus] = useState('idle')
  const [logLines,      setLogLines]      = useState([])
  const logIdRef      = useRef(0)
  const logEndRef     = useRef(null)
  const scannerWsRefs = useRef(new Map())
  const scannerDigits = useRef(new Map())
  const cooldowns     = useRef(new Map())
  const persistCounts = useRef(new Map())
  const scannerBotWsRef = useRef(null)

  const scanTradeTypeRef = useRef('even_odd')
  const scanStakeRef     = useRef('1.00')
  const scanCountRef     = useRef(3)
  const scanCurrencyRef  = useRef('USD')

  useEffect(() => {
    const counts = Array(10).fill(0)
    recentDigits.slice(-ticks).forEach(d => counts[d]++)
    setDigitCounts(counts)
  }, [recentDigits, ticks])

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior:'smooth' }) }, [logLines])

  const settled  = trades.filter(t => t.won !== null)
  const wins     = settled.filter(t => t.won)
  const totalPnl = settled.reduce((s, t) => s + (t.profit ?? 0), 0)
  const winRate  = settled.length > 0 ? (wins.length / settled.length) * 100 : 0

  useEffect(() => {
    const ws = new WebSocket(PUBLIC_WS_URL)
    ws.onopen = () => ws.send(JSON.stringify({ ticks_history:symbol, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'history') {
        if (msg.pip_size != null) pipSizeRef.current = msg.pip_size
        const prices = msg.history?.prices ?? []
        setRecentDigits(prices.map(p => lastDigit(Number(p), pipSizeRef.current)).slice(-100))
        setLivePrice(prices.at(-1) ?? null)
      }
      if (msg.msg_type === 'tick') {
        if (msg.tick?.pip_size != null) pipSizeRef.current = msg.tick.pip_size
        const q = msg.tick?.quote
        if (q != null) { setLivePrice(q); setRecentDigits(prev => [...prev.slice(-99), lastDigit(Number(q), pipSizeRef.current)]) }
      }
    }
    ws.onerror = () => {}; ws.onclose = () => {}
    return () => { try { ws.send(JSON.stringify({ forget_all:'ticks', req_id:9999 })) } catch {} ws.close(); setLivePrice(null); setRecentDigits([]) }
  }, [symbol])

  const log = useCallback((text, color = 'white') => {
    setLogLines(prev => [...prev.slice(-400), { id:++logIdRef.current, text, color, ts:Date.now() }])
  }, [])

  const addTrade = useCallback((contractType, sym, stakeVal, source) => {
    const id = ++tradeIdRef.current
    setTrades(prev => [{ id, ts:Date.now(), contractType, symbol:sym, stake:stakeVal, payout:0, won:null, profit:null, source }, ...prev.slice(0,199)])
    return id
  }, [])

  const settleTrade = useCallback((rowId, payout, stakeVal) => {
    const profit = payout - stakeVal
    setTrades(prev => prev.map(t => t.id === rowId ? { ...t, payout, profit, won:profit>0 } : t))
  }, [])

  const connectBotWs = useCallback(async () => {
    try {
      const r = await fetch('/api/user/ws-url')
      if (!r.ok) { if (r.status === 401) window.location.href = '/'; return null }
      const { wsUrl } = await r.json()
      const ws = new WebSocket(wsUrl)
      await new Promise((res, rej) => {
        ws.onopen = () => res()
        ws.onerror = () => rej(new Error('connect failed'))
        setTimeout(() => rej(new Error('timeout')), 10_000)
      })
      ws.send(JSON.stringify({ balance:1, subscribe:1, req_id:51 }))
      try {
        const br = await fetch('/api/user/balance')
        if (br.ok) {
          const { accounts, activeAccountId } = await br.json()
          const acc = accounts?.find(a => a.accountId === activeAccountId) ?? accounts?.[0]
          if (acc?.currency) setCurrency(acc.currency)
        }
      } catch {}
      return ws
    } catch { return null }
  }, [])

  const fireTrades = useCallback((ws, contractType, barrierVal, stakeVal, count, sym, cur, source, reqToRow, pending) => {
    for (let i = 0; i < count; i++) {
      const reqId = ++reqIdRef.current
      const rowId = addTrade(contractType, sym, stakeVal, source)
      pending.set(reqId, { rowId, stake:stakeVal })
      ws.send(JSON.stringify({
        buy:'1', price:1000, req_id:reqId,
        parameters: {
          contract_type:contractType, underlying_symbol:sym,
          duration:5, duration_unit:'t', amount:stakeVal, basis:'stake', currency:cur,
          ...(barrierVal !== null ? { barrier:String(barrierVal) } : {}),
        },
      }))
    }
  }, [addTrade])

  const handleManualTrade = useCallback(async (contractType) => {
    if (isTrading) return
    setIsTrading(true); setTradeError(null)
    const stakeVal = parseFloat(stake) || 1
    const n        = parseInt(bulkCount) || 1
    const ws = await connectBotWs()
    if (!ws) { setTradeError('Connection failed'); setIsTrading(false); return }
    intentionalClose.current = false
    const pending = new Map(), reqToRow = new Map()
    let settled = 0
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:msg.balance?.balance, currency:msg.balance?.currency } }))
      if (msg.msg_type === 'buy') { const ri = pending.get(msg.req_id); if (ri && msg.buy?.contract_id) reqToRow.set(msg.buy.contract_id, ri.rowId) }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const cid = msg.transaction.contract_id, payout = Math.abs(msg.transaction.amount ?? 0)
        const rowId = reqToRow.get(cid)
        let stk = stakeVal; for (const [, v] of pending) { stk = v.stake; break }
        if (rowId != null) settleTrade(rowId, payout, stk)
        settled++
        if (settled >= n) { intentionalClose.current = true; ws.close(); setIsTrading(false) }
      }
      if (msg.error) { setTradeError(msg.error.message ?? 'Trade error'); intentionalClose.current = true; ws.close(); setIsTrading(false) }
    }
    ws.onclose = () => { if (!intentionalClose.current) setIsTrading(false) }
    ws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))
    fireTrades(ws, contractType, tradeType === 'over_under' ? digit : null, stakeVal, n, symbol, currency, 'manual', reqToRow, pending)
  }, [isTrading, stake, bulkCount, tradeType, digit, symbol, currency, connectBotWs, fireTrades, settleTrade])

  const startScanner = useCallback(async () => {
    setScannerActive(true); setScannerStatus('scanning'); setLogLines([])
    scanTradeTypeRef.current = tradeType
    scanStakeRef.current     = stake
    scanCountRef.current     = parseInt(bulkCount) || 1
    scanCurrencyRef.current  = currency

    log('━━━ AI BULK SCANNER V2 ━━━', 'cyan')
    log(`Mode: ${tradeType === 'even_odd' ? 'Even / Odd' : 'Over / Under (barriers 1–8, auto-select)'}`, 'white')
    log(`Markets: ${SCAN_SYMBOLS.join('  ·  ')}`, 'white')
    log('Threshold ≥ 55  ·  20s cooldown  ·  1-check persist', 'white')
    log('Multi-barrier trend + entropy scoring active.', 'green')

    const bws = await connectBotWs()
    if (!bws) { log('ERROR: trading WS failed', 'red'); setScannerActive(false); setScannerStatus('idle'); return }
    scannerBotWsRef.current = bws
    const scanPending = new Map(), scanReqToRow = new Map()

    bws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.msg_type === 'balance') window.dispatchEvent(new CustomEvent('deriv-balance', { detail:{ balance:msg.balance?.balance, currency:msg.balance?.currency } }))
      if (msg.msg_type === 'buy') {
        const ri = scanPending.get(msg.req_id)
        if (ri && msg.buy?.contract_id) { scanReqToRow.set(msg.buy.contract_id, ri.rowId); log(`  ✓ Contract #${msg.buy.contract_id} placed`, 'green') }
      }
      if (msg.msg_type === 'transaction' && msg.transaction?.action === 'sell') {
        const cid = msg.transaction.contract_id, payout = Math.abs(msg.transaction.amount ?? 0)
        const rowId = scanReqToRow.get(cid)
        let stk = parseFloat(scanStakeRef.current) || 1; for (const [, v] of scanPending) { stk = v.stake; break }
        if (rowId != null) {
          settleTrade(rowId, payout, stk)
          log(`  ${payout > stk ? '✓ WIN' : '✗ LOSS'} ${payout > stk ? '+' : ''}${fmt2(payout-stk)} ${scanCurrencyRef.current}`, payout > stk ? 'green' : 'red')
        }
      }
      if (msg.error) log(`  ERROR: ${msg.error.message}`, 'red')
    }
    bws.send(JSON.stringify({ transaction:1, subscribe:1, req_id:100 }))

    SCAN_SYMBOLS.forEach(sym => {
      scannerDigits.current.set(sym, [])
      persistCounts.current.set(sym, 0)
      let localPipSize = 2, tickCount = 0
      const ws = new WebSocket(PUBLIC_WS_URL)
      scannerWsRefs.current.set(sym, ws)
      ws.onopen = () => ws.send(JSON.stringify({ ticks_history:sym, end:'latest', count:100, style:'ticks', subscribe:1, req_id:1 }))
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.msg_type === 'history') {
          if (msg.pip_size != null) localPipSize = msg.pip_size
          scannerDigits.current.set(sym, (msg.history?.prices ?? []).map(p => lastDigit(Number(p), localPipSize)))
        }
        if (msg.msg_type === 'tick') {
          if (msg.tick?.pip_size != null) localPipSize = msg.tick.pip_size
          const q = msg.tick?.quote; if (q == null) return
          const digits = scannerDigits.current.get(sym) ?? []
          digits.push(lastDigit(Number(q), localPipSize))
          if (digits.length > 300) digits.shift()
          scannerDigits.current.set(sym, digits)
          tickCount++
          if (tickCount % 3 !== 0) return
          const lastFired = cooldowns.current.get(sym) ?? 0
          if (Date.now() - lastFired < 20_000) return
          const tt = scanTradeTypeRef.current
          const persist = persistCounts.current.get(sym) ?? 0
          const result = detectSignal(digits, tt, persist)
          if (result.signal && result.contractType) {
            persistCounts.current.set(sym, persist + 1)
            if (persist < 1) { log(`  ${sym} pattern building (${persist+1}/2, score=${result.score})`, 'white'); return }
            const short = MARKETS.find(m => m.symbol === sym)?.label ?? sym
            const dir   = result.contractType.replace('DIGIT','')
            const bStr  = result.barrier !== null ? ` ${result.barrier}` : ''
            log(`━━ ${short} ━━`, 'cyan')
            log(`  ${result.reason}`, 'amber')
            log(`  Score: ${result.score}/100  [${result.detail}]`, 'white')
            log(`  → ${scanCountRef.current}× ${dir}${bStr} @ ${scanStakeRef.current} ${scanCurrencyRef.current}`, 'green')
            cooldowns.current.set(sym, Date.now())
            persistCounts.current.set(sym, 0)
            setScannerStatus('fired')
            setTimeout(() => setScannerStatus('scanning'), 3000)
            if (scannerBotWsRef.current?.readyState === WebSocket.OPEN) {
              fireTrades(scannerBotWsRef.current, result.contractType, result.barrier,
                parseFloat(scanStakeRef.current)||1, scanCountRef.current, sym, scanCurrencyRef.current, 'scanner', scanReqToRow, scanPending)
            }
          } else {
            if (persist > 0) persistCounts.current.set(sym, 0)
          }
        }
      }
      ws.onerror = () => log(`WS error: ${sym}`, 'red')
    })
  }, [tradeType, stake, bulkCount, currency, connectBotWs, fireTrades, settleTrade, log])

  const stopScanner = useCallback(() => {
    setScannerActive(false); setScannerStatus('idle')
    log('━━━ SCANNER STOPPED ━━━', 'amber')
    scannerWsRefs.current.forEach(ws => { try { ws.close() } catch {} })
    scannerWsRefs.current.clear(); scannerDigits.current.clear()
    cooldowns.current.clear(); persistCounts.current.clear()
    if (scannerBotWsRef.current) { try { scannerBotWsRef.current.close() } catch {} }
    scannerBotWsRef.current = null
  }, [log])

  useEffect(() => () => stopScanner(), [stopScanner])

  const liveDigit  = livePrice != null ? lastDigit(livePrice, pipSizeRef.current) : null
  const totalTicks = recentDigits.slice(-ticks).length

  return (
    <>
      <style>{`
        .bt-card { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08); border-radius:10px; padding:.72rem .82rem; }
        .bt-lbl  { font-size:.6rem; font-weight:700; letter-spacing:.08em; color:rgba(229,229,229,.35); text-transform:uppercase; margin-bottom:.32rem; }
        .bt-sel  { width:100%; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:7px; color:#e5e5e5; padding:.4rem .58rem; font-size:.78rem; outline:none; cursor:pointer; }
        .bt-inp  { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:7px; color:#e5e5e5; padding:.4rem .58rem; font-size:.84rem; outline:none; box-sizing:border-box; width:100%; }
        .bt-inp:focus { border-color:#00e5cc; }
        .bt-btn  { border:none; border-radius:8px; font-weight:800; cursor:pointer; transition:opacity .15s; }
        .bt-btn:disabled { opacity:.4; cursor:not-allowed; }
        .tt-chip { padding:.36rem 0; border-radius:7px; font-size:.73rem; font-weight:700; cursor:pointer; border:1px solid transparent; transition:all .15s; text-align:center; flex:1; }
        .tw-chip { padding:.3rem 0; border-radius:6px; font-size:.72rem; font-weight:700; cursor:pointer; border:1px solid transparent; transition:all .15s; flex:1; text-align:center; }
        .dot-cell { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:4px; font-size:.64rem; font-weight:800; flex-shrink:0; }
        .hr-row { display:grid; grid-template-columns:1fr 52px 28px 52px; gap:2px; align-items:center; padding:.26rem .38rem; border-radius:5px; font-size:.68rem; }
        .hr-row:hover { background:rgba(255,255,255,.04); }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-2px)} to{opacity:1;transform:none} }
        @keyframes scanPulse { 0%,100%{opacity:1} 50%{opacity:.2} }
      `}</style>

      <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

        {/* ══ LEFT: Scanner ══════════════════════════════════════════════════ */}
        <div style={{ width:248, flexShrink:0, borderRight:'1px solid rgba(255,255,255,.07)', display:'flex', flexDirection:'column', background:'rgba(0,0,0,.2)' }}>

          <div style={{ padding:'.58rem .72rem', borderBottom:'1px solid rgba(255,255,255,.06)', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'.38rem' }}>
              <span style={{ fontSize:'.8rem', fontWeight:800, color:'#e5e5e5' }}>AI Scanner V2</span>
              <span style={{
                padding:'.18rem .5rem', borderRadius:20, fontSize:'.61rem', fontWeight:700,
                background: scannerStatus==='idle' ? 'rgba(255,255,255,.05)' : scannerStatus==='scanning' ? '#00e5cc18' : 'rgba(252,163,17,.15)',
                color:      scannerStatus==='idle' ? 'rgba(229,229,229,.3)' : scannerStatus==='scanning' ? '#00e5cc' : '#FCA311',
                border:`1px solid ${scannerStatus==='idle'?'rgba(255,255,255,.07)':scannerStatus==='scanning'?'#00e5cc44':'rgba(252,163,17,.3)'}`,
              }}>
                {scannerActive && <span style={{ width:5,height:5,borderRadius:'50%',background:scannerStatus==='fired'?'#FCA311':'#22c55e',display:'inline-block',marginRight:4,animation:'scanPulse 1.2s ease infinite' }} />}
                {scannerStatus==='idle'?'IDLE':scannerStatus==='scanning'?'SCANNING':'FIRED'}
              </span>
            </div>
            <button className="bt-btn" onClick={scannerActive ? stopScanner : startScanner}
              style={{ width:'100%', padding:'.38rem', fontSize:'.77rem', background:scannerActive?'rgba(239,68,68,.12)':'#00e5cc18', color:scannerActive?'#ef4444':'#00e5cc', border:`1px solid ${scannerActive?'rgba(239,68,68,.3)':'#00e5cc44'}` }}>
              {scannerActive ? '■  Stop Scanner' : '▶  Start Scanner'}
            </button>
          </div>

          {/* Stats strip */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, padding:'.48rem .58rem', borderBottom:'1px solid rgba(255,255,255,.06)', flexShrink:0 }}>
            {[
              { label:'P&L', value:`${totalPnl>=0?'+':''}${fmt2(totalPnl)}`, color:totalPnl>0?'#22c55e':totalPnl<0?'#ef4444':'rgba(229,229,229,.4)' },
              { label:'Win Rate', value:settled.length>0?`${winRate.toFixed(0)}%`:'—', color:winRate>=50?'#22c55e':winRate>0?'#ef4444':'rgba(229,229,229,.4)' },
              { label:'Settled', value:String(settled.length), color:'rgba(229,229,229,.7)' },
              { label:'Pending', value:String(trades.filter(t=>t.won===null).length), color:'#FCA311' },
            ].map(s => (
              <div key={s.label} style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:6, padding:'.28rem .38rem' }}>
                <div style={{ fontSize:'.54rem', color:'rgba(229,229,229,.28)', textTransform:'uppercase', letterSpacing:'.05em' }}>{s.label}</div>
                <div style={{ fontSize:'.8rem', fontWeight:800, color:s.color, fontVariantNumeric:'tabular-nums' }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Log */}
          <div style={{ flex:1, overflowY:'auto', padding:'.48rem .65rem', fontFamily:"'SF Mono','Fira Code','Consolas',monospace", fontSize:'.68rem', lineHeight:1.82, background:'#040b0a' }}>
            {logLines.length === 0
              ? <p style={{ color:'rgba(229,229,229,.15)', margin:0 }}>{scannerActive?'Monitoring markets…':'Start the scanner to begin.'}</p>
              : logLines.map(l => (
                <div key={l.id} style={{ color:l.color==='green'?'#22c55e':l.color==='amber'?'#FCA311':l.color==='red'?'#ef4444':l.color==='cyan'?'#00e5cc':'rgba(229,229,229,.67)' }}>
                  <span style={{ color:'rgba(229,229,229,.14)', marginRight:'.3rem', fontSize:'.59rem' }}>{fmtTime(l.ts)}</span>{l.text}
                </div>
              ))}
            <div ref={logEndRef} />
          </div>

          <div style={{ padding:'.32rem .58rem', borderTop:'1px solid #00e5cc14', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
            <span style={{ fontSize:'.57rem', color:'rgba(229,229,229,.18)' }}>score≥55 · auto digit · 20s cd</span>
            <button onClick={() => setLogLines([])} style={{ background:'transparent', border:'none', color:'rgba(229,229,229,.2)', cursor:'pointer', fontSize:'.61rem' }}>Clear</button>
          </div>

        </div>

        {/* ══ CENTER: Main content ════════════════════════════════════════════ */}
        <div style={{ flex:1, minWidth:0, overflowY:'auto', padding:'.82rem .95rem', display:'flex', flexDirection:'column', gap:'.65rem' }}>

          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <h1 style={{ margin:0, fontSize:'1.08rem', fontWeight:900, color:'#fff' }}>⣿ Bulk Trader</h1>
              <p style={{ margin:'1px 0 0', fontSize:'.67rem', color:'rgba(229,229,229,.28)' }}>Fire multiple contracts simultaneously on pattern signals</p>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:'1.22rem', fontWeight:900, color:'#00e5cc', fontVariantNumeric:'tabular-nums' }}>
                {livePrice != null ? livePrice.toFixed(pipSizeRef.current) : '—'}
              </div>
              <div style={{ fontSize:'.6rem', color:'rgba(229,229,229,.27)' }}>
                {liveDigit != null
                  ? <span>LIVE · <span style={{ color:DIGIT_COLORS[liveDigit], fontWeight:800 }}>digit {liveDigit}</span></span>
                  : 'LIVE PRICE'}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(128px,1fr))', gap:'.52rem' }}>

            <div className="bt-card">
              <div className="bt-lbl">Market</div>
              <select className="bt-sel" value={symbol} onChange={e => setSymbol(e.target.value)}>
                {MARKETS.map(m => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
              </select>
            </div>

            <div className="bt-card">
              <div className="bt-lbl">Trade Type</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {['even_odd','over_under'].map(t => (
                  <button key={t} className="tt-chip" onClick={() => setTradeType(t)} style={{
                    background: tradeType===t ? '#00e5cc20' : 'rgba(255,255,255,.04)',
                    border:     `1px solid ${tradeType===t ? '#00e5cc' : 'rgba(255,255,255,.1)'}`,
                    color:      tradeType===t ? '#00e5cc' : 'rgba(229,229,229,.44)',
                  }}>{t==='even_odd'?'Even / Odd':'Over / Under'}</button>
                ))}
              </div>
            </div>

            {tradeType === 'over_under' && (
              <div className="bt-card">
                <div className="bt-lbl">Digit <span style={{ color:'#00e5cc', fontSize:'.55rem' }}>(manual)</span></div>
                <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                  {Array.from({length:10},(_,d) => (
                    <button key={d} onClick={() => setDigit(d)} style={{
                      width:23, height:23, borderRadius:5, cursor:'pointer',
                      border:`1px solid ${digit===d?DIGIT_COLORS[d]:'rgba(255,255,255,.1)'}`,
                      background:digit===d?`${DIGIT_COLORS[d]}22`:'transparent',
                      color:digit===d?DIGIT_COLORS[d]:'rgba(229,229,229,.36)',
                      fontWeight:800, fontSize:'.68rem',
                    }}>{d}</button>
                  ))}
                </div>
                <p style={{ margin:'4px 0 0', fontSize:'.57rem', color:'rgba(229,229,229,.26)' }}>Scanner picks digit auto</p>
              </div>
            )}

            <div className="bt-card">
              <div className="bt-lbl">Stake ({currency})</div>
              <input className="bt-inp" type="number" min="0.35" step="0.01" value={stake} onChange={e => setStake(e.target.value)} />
            </div>

            <div className="bt-card">
              <div className="bt-lbl">No. of Bulk Trades</div>
              <input className="bt-inp" type="number" min="1" max="50" step="1" value={bulkCount} onChange={e => setBulkCount(e.target.value)} />
              <p style={{ margin:'4px 0 0', fontSize:'.57rem', color:'rgba(229,229,229,.26)' }}>Contracts per signal</p>
            </div>

            <div className="bt-card">
              <div className="bt-lbl">Ticks</div>
              <div style={{ display:'flex', gap:4 }}>
                {[30,60,100].map(n => (
                  <button key={n} className="tw-chip" onClick={() => setTicks(n)} style={{
                    background:ticks===n?'rgba(252,163,17,.12)':'rgba(255,255,255,.04)',
                    border:`1px solid ${ticks===n?'rgba(252,163,17,.5)':'rgba(255,255,255,.1)'}`,
                    color:ticks===n?'#FCA311':'rgba(229,229,229,.44)',
                  }}>{n}</button>
                ))}
              </div>
            </div>

          </div>

          {/* Digit gauges */}
          <div className="bt-card">
            <div className="bt-lbl">Distribution — last {ticks} ticks</div>
            <div style={{ display:'flex', gap:'.28rem', justifyContent:'space-around', flexWrap:'wrap', paddingTop:4 }}>
              {Array.from({length:10},(_,d) => <DigitGauge key={d} digit={d} count={digitCounts[d]} total={totalTicks} liveDigit={liveDigit} />)}
            </div>
          </div>

          {/* Last 60 digits */}
          <div className="bt-card">
            <div className="bt-lbl">Last 60 Digits</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'3px', paddingTop:4 }}>
              {recentDigits.slice(-60).map((d,i,arr) => (
                <span key={i} className="dot-cell" style={{
                  background:i===arr.length-1?DIGIT_COLORS[d]:`${DIGIT_COLORS[d]}18`,
                  color:i===arr.length-1?'#000':DIGIT_COLORS[d],
                  border:`1px solid ${DIGIT_COLORS[d]}44`,
                  transform:i===arr.length-1?'scale(1.25)':'none',
                  transition:'transform .15s',
                }}>{d}</span>
              ))}
            </div>
          </div>

          {/* Manual trade */}
          <div className="bt-card">
            <div className="bt-lbl">Manual — fires {bulkCount||1} contracts now</div>
            <div style={{ display:'flex', gap:'.52rem' }}>
              {tradeType === 'even_odd' ? <>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITEVEN')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#22c55e', color:'#000' }}>
                  {isTrading ? 'Trading…' : `▲ Even ×${bulkCount||1}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITODD')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading ? 'Trading…' : `▼ Odd ×${bulkCount||1}`}
                </button>
              </> : <>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITOVER')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#22c55e', color:'#000' }}>
                  {isTrading ? 'Trading…' : `▲ Over ${digit} ×${bulkCount||1}`}
                </button>
                <button className="bt-btn" disabled={isTrading} onClick={() => handleManualTrade('DIGITUNDER')}
                  style={{ flex:1, padding:'.56rem', fontSize:'.85rem', background:'#ef4444', color:'#fff' }}>
                  {isTrading ? 'Trading…' : `▼ Under ${digit} ×${bulkCount||1}`}
                </button>
              </>}
            </div>
            {tradeError && <p style={{ margin:'.38rem 0 0', fontSize:'.73rem', color:'#ef4444' }}>{tradeError}</p>}
          </div>

        </div>

        {/* ══ RIGHT: Trade history ════════════════════════════════════════════ */}
        <div style={{ width:212, flexShrink:0, borderLeft:'1px solid rgba(255,255,255,.07)', display:'flex', flexDirection:'column', background:'rgba(0,0,0,.18)' }}>

          <div style={{ padding:'.52rem .62rem', borderBottom:'1px solid rgba(255,255,255,.06)', flexShrink:0, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:'.78rem', fontWeight:800, color:'#e5e5e5' }}>Trade History</span>
            <span style={{ fontSize:'.6rem', color:'rgba(229,229,229,.28)' }}>{trades.length > 0 ? `${trades.length}` : ''}</span>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 52px 28px 52px', gap:2, padding:'.23rem .38rem', borderBottom:'1px solid rgba(255,255,255,.04)', flexShrink:0 }}>
            {['Type','Stake','','P&L'].map((h,i) => (
              <span key={i} style={{ fontSize:'.55rem', color:'rgba(229,229,229,.23)', fontWeight:700, textTransform:'uppercase', textAlign:i>=2?'center':i===1?'right':'left' }}>{h}</span>
            ))}
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'.12rem' }}>
            {trades.length === 0
              ? <div style={{ padding:'2rem .8rem', textAlign:'center', color:'rgba(229,229,229,.13)', fontSize:'.7rem' }}>No trades yet.</div>
              : trades.map(t => {
                  const short  = t.contractType.replace('DIGIT','')
                  const mkt    = MARKETS.find(m=>m.symbol===t.symbol)?.label.replace('Volatility ','V') ?? t.symbol
                  const pnlClr = t.won===null?'#FCA311':t.won?'#22c55e':'#ef4444'
                  const pnlTxt = t.won===null?'…':`${(t.profit??0)>=0?'+':''}${fmt2(t.profit??0)}`
                  return (
                    <div key={t.id} className="hr-row" style={{ animation:'fadeIn .18s ease' }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:'.68rem', fontWeight:700, color:t.source==='scanner'?'#00e5cc':'rgba(229,229,229,.8)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{short}</div>
                        <div style={{ fontSize:'.55rem', color:'rgba(229,229,229,.23)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{mkt}</div>
                      </div>
                      <div style={{ textAlign:'right', fontSize:'.67rem', color:'rgba(229,229,229,.43)', fontVariantNumeric:'tabular-nums' }}>{fmt2(t.stake)}</div>
                      <div style={{ textAlign:'center' }}>
                        {t.won===null?<span style={{ color:'#FCA311', fontSize:'.58rem' }}>●</span>:t.won?<span style={{ color:'#22c55e', fontSize:'.58rem' }}>✓</span>:<span style={{ color:'#ef4444', fontSize:'.58rem' }}>✗</span>}
                      </div>
                      <div style={{ textAlign:'right', fontSize:'.68rem', fontWeight:700, color:pnlClr, fontVariantNumeric:'tabular-nums' }}>{pnlTxt}</div>
                    </div>
                  )
                })}
          </div>

          {trades.length > 0 && (
            <div style={{ padding:'.38rem', borderTop:'1px solid rgba(255,255,255,.05)', flexShrink:0 }}>
              <button onClick={() => setTrades([])} style={{ width:'100%', padding:'.28rem', borderRadius:6, cursor:'pointer', background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.07)', color:'rgba(229,229,229,.28)', fontSize:'.67rem' }}>
                Clear history
              </button>
            </div>
          )}

        </div>

      </div>
    </>
  )
}
