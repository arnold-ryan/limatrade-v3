'use client'

import { useState } from 'react'
import TradingChart from '@/components/dashboard/TradingChart'
import TradePanel from '@/components/dashboard/TradePanel'

export default function DashboardPage() {
  const [market, setMarket] = useState('R_10')

  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Chart — fills remaining space */}
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <TradingChart onMarketChange={setMarket} />
      </div>

      {/* Trade panel — fixed width */}
      <div style={{ width: '300px', flexShrink: 0, overflowY: 'auto' }}>
        <TradePanel market={market} />
      </div>
    </div>
  )
}
