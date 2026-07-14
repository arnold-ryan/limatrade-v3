'use client'
export default function RiskCalc() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg0)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, system-ui, sans-serif', gap: 12 }}>
      <div style={{ fontSize: 36 }}>⚖</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt0)' }}>Risk Calculator</div>
      <div style={{ fontSize: 13, color: 'var(--txt1)', textAlign: 'center', maxWidth: 320 }}>Calculate optimal position sizes and risk-to-reward ratios before you trade.</div>
      <div style={{ marginTop: 8, padding: '6px 16px', fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 20, color: 'var(--clr-amber)', letterSpacing: '0.06em' }}>COMING SOON</div>
    </div>
  )
}
