'use client'

/**
 * Lima Trade — Free Bots Page v112
 *
 * Uses a curated built-in strategy list instead of auto_list_strategies
 * (that endpoint is DBot-specific and not available on the new trading WS).
 * Clicking a bot saves config to localStorage and navigates to Bot Builder.
 */

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { bg0, bg1, bg2, bdr, txt0, txt1, txt2, amber } from '@/lib/colors'

const LS_KEY = 'lima_trade_pending_bot'

interface DerivStrategy {
  strategy_id:   string
  display_name:  string
  description:   string
  contract_type: string[]
  parameters:    { name: string; display_name: string; default: string }[]
}

/* ─── Curated built-in strategies ─────────────────────────────────────────── */
const BUILTIN_STRATEGIES: DerivStrategy[] = [
  {
    strategy_id:   'martingale_ou',
    display_name:  'Martingale – Over / Under',
    description:   'Doubles the stake after each loss, resets to initial after a win. Choose a digit barrier and trade Over or Under.',
    contract_type: ['DIGITOVER', 'DIGITUNDER'],
    parameters: [
      { name: 'multiplier', display_name: 'Loss Multiplier',      default: '2'     },
      { name: 'max_stake',  display_name: 'Max Stake',            default: '50.00' },
      { name: 'barrier',    display_name: 'Digit Barrier (0–9)',  default: '5'     },
    ],
  },
  {
    strategy_id:   'dalembert_ou',
    display_name:  "D'Alembert – Over / Under",
    description:   'Increases stake by one unit after a loss, decreases by one unit after a win — slower and steadier than Martingale.',
    contract_type: ['DIGITOVER', 'DIGITUNDER'],
    parameters: [
      { name: 'unit',    display_name: 'Unit Size',           default: '0.50' },
      { name: 'barrier', display_name: 'Digit Barrier (0–9)', default: '4'    },
    ],
  },
  {
    strategy_id:   'fibonacci_ou',
    display_name:  'Fibonacci – Over / Under',
    description:   'Stake follows the Fibonacci sequence (1, 1, 2, 3, 5, 8…) after losses, stepping back two positions after each win.',
    contract_type: ['DIGITOVER', 'DIGITUNDER'],
    parameters: [
      { name: 'barrier', display_name: 'Digit Barrier (0–9)', default: '6' },
    ],
  },
  {
    strategy_id:   'martingale_md',
    display_name:  'Martingale – Match / Differ',
    description:   'Doubles stake after each loss on a selected target digit. Trade whether the last digit Matches or Differs from your chosen number.',
    contract_type: ['DIGITMATCH', 'DIGITDIFF'],
    parameters: [
      { name: 'multiplier', display_name: 'Loss Multiplier',      default: '2' },
      { name: 'digit',      display_name: 'Target Digit (0–9)',   default: '5' },
    ],
  },
  {
    strategy_id:   'martingale_eo',
    display_name:  'Martingale – Even / Odd',
    description:   'Classic martingale on Even/Odd. Near 50/50 win rate; stake doubles each loss and resets on a win.',
    contract_type: ['DIGITEVEN', 'DIGITODD'],
    parameters: [
      { name: 'multiplier', display_name: 'Loss Multiplier', default: '2'     },
      { name: 'max_stake',  display_name: 'Max Stake',       default: '50.00' },
    ],
  },
  {
    strategy_id:   'dalembert_eo',
    display_name:  "D'Alembert – Even / Odd",
    description:   "Conservative staking on Even/Odd. Gradually increases during a losing streak, reduces after wins — lower variance.",
    contract_type: ['DIGITEVEN', 'DIGITODD'],
    parameters: [
      { name: 'unit', display_name: 'Unit Size', default: '0.50' },
    ],
  },
  {
    strategy_id:   'martingale_rf',
    display_name:  'Martingale – Rise / Fall',
    description:   'Doubles stake after each loss predicting whether the next tick will rise or fall from the current price.',
    contract_type: ['CALL', 'PUT'],
    parameters: [
      { name: 'multiplier', display_name: 'Loss Multiplier', default: '2' },
    ],
  },
  {
    strategy_id:   'streak_eo',
    display_name:  'Anti-Streak – Even / Odd',
    description:   'Detects a consecutive run of the same result and trades the opposite, betting on mean-reversion.',
    contract_type: ['DIGITEVEN', 'DIGITODD'],
    parameters: [
      { name: 'streak_length', display_name: 'Streak Length', default: '3' },
    ],
  },
]

const CT_LABEL: Record<string, string> = {
  DIGITOVER:  'Over',
  DIGITUNDER: 'Under',
  DIGITMATCH: 'Match',
  DIGITDIFF:  'Differ',
  DIGITEVEN:  'Even',
  DIGITODD:   'Odd',
  CALL:       'Rise',
  PUT:        'Fall',
}

function defaultParams(params: DerivStrategy['parameters']) {
  const out: Record<string, string> = {}
  for (const p of params) out[p.name] = p.default
  return out
}

export default function FreeBotsPage() {
  const router = useRouter()
  const [justLoaded, setJustLoaded] = useState<string | null>(null)

  const loadBot = useCallback((strategy: DerivStrategy, ct: string) => {
    const key = `${strategy.strategy_id}:${ct}`
    const config = {
      strategy_id:   strategy.strategy_id,
      display_name:  strategy.display_name,
      description:   strategy.description,
      contract_type: ct,
      parameters:    strategy.parameters,
      market:        'R_100',
      stake:         '1.00',
      params:        defaultParams(strategy.parameters),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(config))
    setJustLoaded(key)
    setTimeout(() => router.push('/dashboard/bot-builder'), 300)
  }, [router])

  return (
    <div style={{ minHeight: '100vh', background: bg0, fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: txt0, margin: '0 0 6px' }}>Free Bots</h1>
        <p style={{ fontSize: 13, color: txt1, margin: 0 }}>
          Click any strategy to load it in the Bot Builder — all bots run live on the Deriv trading API.
        </p>
      </div>

      {/* Strategy grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {BUILTIN_STRATEGIES.map(s => (
          <div key={s.strategy_id} style={{
            background: bg1, border: `1px solid ${bdr}`, borderRadius: 12, overflow: 'hidden',
          }}>
            <div style={{ height: 4, background: amber }} />
            <div style={{ padding: '16px 16px 14px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: txt0, marginBottom: 6 }}>{s.display_name}</div>
              <div style={{ fontSize: 12, color: txt1, marginBottom: 14, lineHeight: 1.55 }}>{s.description}</div>

              {/* Parameters preview */}
              {s.parameters.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {s.parameters.map(p => (
                    <span key={p.name} style={{
                      fontSize: 10, padding: '2px 7px', borderRadius: 4,
                      background: bg2, border: `1px solid ${bdr}`, color: txt2,
                    }}>
                      {p.display_name}: <span style={{ color: txt1 }}>{p.default}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* Contract type buttons */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.contract_type.map(ct => {
                  const key    = `${s.strategy_id}:${ct}`
                  const loaded = justLoaded === key
                  return (
                    <button key={ct} onClick={() => loadBot(s, ct)} style={{
                      padding: '5px 12px', fontSize: 11, fontWeight: 700,
                      background: loaded ? amber : bg2,
                      border: `1px solid ${loaded ? amber : bdr}`,
                      borderRadius: 6, cursor: 'pointer',
                      color: loaded ? '#000' : txt0,
                      transition: 'all 0.15s',
                    }}>
                      {loaded ? '✓ Loaded' : (CT_LABEL[ct] ?? ct)}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tip */}
      <div style={{
        marginTop: 32, background: bg1, border: `1px solid ${bdr}`,
        borderRadius: 12, padding: '18px 20px', maxWidth: 560,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: txt0, marginBottom: 8 }}>Tips</div>
        <p style={{ fontSize: 12, color: txt1, lineHeight: 1.6, margin: 0 }}>
          Start with a small stake (e.g. 1 USD) to test a strategy. Use the{' '}
          <span style={{ color: amber }}>Charts tab</span> to study digit frequency before choosing a barrier.
          All bots trade real (or demo) contracts via your connected Deriv account.
        </p>
      </div>
    </div>
  )
}
