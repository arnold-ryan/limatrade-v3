import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import WebSocket from 'ws'

// Server-side only — uses the 'ws' package
export const runtime = 'nodejs'

/**
 * GET /api/user/balance
 * Returns balance for ALL accounts (real + demo) in a single call.
 *
 * Flow:
 *   1. Authorize the WS with the current session token
 *   2. Send { balance: 1, account: "all" }
 *   3. Parse the response and return structured account data
 *
 * Deriv balance response with account: "all":
 * {
 *   balance: {
 *     balance:  1234.56,          ← current account
 *     currency: "USD",
 *     loginid:  "CR123456",
 *     accounts: {
 *       "CR123456":   { balance: 1234.56, currency: "USD", demo_account: 0, type: "deriv", status: 1 },
 *       "VRTC123456": { balance: 10000,   currency: "USD", demo_account: 1, type: "deriv", status: 1 }
 *     }
 *   }
 * }
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn || !session.accessToken) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const appId = process.env.DERIV_CLIENT_ID
  if (!appId) {
    return NextResponse.json({ error: 'missing_app_id' }, { status: 500 })
  }

  return new Promise<NextResponse>((resolve) => {
    const ws = new WebSocket(
      `wss://ws.binaryws.com/websockets/v3?app_id=${appId}`
    )

    const timer = setTimeout(() => {
      ws.terminate()
      resolve(NextResponse.json({ error: 'timeout' }, { status: 408 }))
    }, 12_000)

    ws.on('open', () => {
      // Step 1: Authorize with the current account's token
      ws.send(JSON.stringify({ authorize: session.accessToken }))
    })

    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.error) {
        clearTimeout(timer)
        ws.close()
        resolve(NextResponse.json(
          { error: (msg.error as { message: string }).message },
          { status: 400 }
        ))
        return
      }

      if (msg.msg_type === 'authorize') {
        // Authorized — now request balances for ALL accounts
        // account: "all" returns a balance.accounts object keyed by loginid
        ws.send(JSON.stringify({ balance: 1, account: 'all' }))
      }

      if (msg.msg_type === 'balance') {
        clearTimeout(timer)
        ws.close()

        const b = msg.balance as {
          balance:  number
          currency: string
          loginid:  string
          accounts?: Record<string, {
            balance:      number
            currency:     string
            demo_account: number
            type:         string
            status:       number
          }>
        }

        // Build a structured accounts array from the balance.accounts map
        const allAccounts = Object.entries(b.accounts ?? {})
          .filter(([, info]) => info.status === 1)   // only active accounts
          .map(([loginid, info]) => ({
            loginid,
            balance:  info.balance,
            currency: info.currency,
            isDemo:   info.demo_account === 1,
            type:     info.type,
          }))

        // Also include any accounts stored in the session that Deriv didn't return
        // balances for (edge case: MT5 accounts or accounts with restrictions)
        const sessionAccounts = session.accounts ?? []
        for (const sa of sessionAccounts) {
          if (!allAccounts.find(a => a.loginid === sa.loginid)) {
            allAccounts.push({
              loginid:  sa.loginid,
              balance:  0,
              currency: sa.currency,
              isDemo:   sa.isDemo,
              type:     'deriv',
            })
          }
        }

        resolve(NextResponse.json({
          // Currently active account info
          balance:     b.balance,
          currency:    b.currency,
          loginid:     b.loginid,
          accountType: b.loginid.startsWith('VRTC') ? 'demo' : 'real',
          // All accounts
          accounts:    allAccounts,
        }))
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timer)
      console.error('Balance WS error:', err.message)
      resolve(NextResponse.json({ error: 'ws_error' }, { status: 500 }))
    })
  })
}
