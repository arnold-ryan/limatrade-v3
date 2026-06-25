import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import WebSocket from 'ws'

// Force Node.js runtime — ws package requires it (not available on Edge)
export const runtime = 'nodejs'

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

    // 10-second hard timeout
    const timer = setTimeout(() => {
      ws.terminate()
      resolve(NextResponse.json({ error: 'timeout' }, { status: 408 }))
    }, 10_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: session.accessToken }))
    })

    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.error) {
        clearTimeout(timer)
        ws.close()
        resolve(
          NextResponse.json(
            { error: (msg.error as { message: string }).message },
            { status: 400 }
          )
        )
        return
      }

      if (msg.msg_type === 'authorize') {
        // Authorised — now request balance
        ws.send(JSON.stringify({ balance: 1 }))
      }

      if (msg.msg_type === 'balance') {
        clearTimeout(timer)
        ws.close()

        const b = msg.balance as {
          balance:      number
          currency:     string
          loginid:      string
          account_type: string
        }

        resolve(
          NextResponse.json({
            balance:     b.balance,
            currency:    b.currency,
            loginid:     b.loginid,
            accountType: b.account_type ?? 'demo',
          })
        )
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timer)
      console.error('Balance WS error:', err.message)
      resolve(NextResponse.json({ error: 'ws_error' }, { status: 500 }))
    })
  })
}
