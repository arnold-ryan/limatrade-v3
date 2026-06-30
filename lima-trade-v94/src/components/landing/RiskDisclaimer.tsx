export default function RiskDisclaimer() {
  return (
    <footer style={{ background: 'var(--navy)', borderTop: '1px solid var(--border)', padding: '2.4rem 3rem' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>

        {/* Title */}
        <div className="flex items-center gap-2 mb-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FCA311" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
            <path d="M12 9v4"/><path d="M12 17h.01"/>
          </svg>
          <span className="font-bold text-base" style={{ color: '#FCA311' }}>Risk Disclaimer</span>
        </div>

        {/* Body */}
        <p className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--silver)' }}>
          Deriv offers complex derivatives, such as options and contracts for difference ("CFDs"). These products may not be suitable for all clients, and trading them puts you at risk. Please make sure that you understand the following risks before trading Deriv products:
        </p>

        <ul className="flex flex-col gap-2">
          {[
            'You may lose some or all of the money you invest in the trade.',
            'If your trade involves currency conversion, exchange rates will affect your profit and loss.',
            'You should never trade with borrowed money or with money that you cannot afford to lose.',
          ].map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs" style={{ color: 'var(--silver)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FCA311" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '1px' }}>
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
                <path d="M12 9v4"/><path d="M12 17h.01"/>
              </svg>
              {item}
            </li>
          ))}
        </ul>

      </div>
    </footer>
  )
}
