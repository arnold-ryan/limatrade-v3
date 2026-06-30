import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { DERIV_API_URL } from '@/lib/auth/constants'

/**
 * GET /api/user/ws-url
 *
 * Gets a one-time WebSocket URL from the Deriv REST API.
 * The URL includes an OTP token so the WS connection is authenticated.
 *
 * Flow:
 *   1. Read Bearer token + active accountId from session
 *   2. POST {DERIV_API_URL}/trading/v1/options/accounts/{accountId}/otp
 *   3. Return the WS URL to the client
 *
 * The client then connects to the returned WS URL for real-time trading.
 * OTP URLs are short-lived — call this endpoint fresh for each new connection.
 *
 * Public market data (ticks, candles) can use the public WS without an OTP:
 *   wss://api.derivws.com/trading/v1/options/ws/public
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn || !session.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = session.activeAccountId
  const clientId  = process.env.DERIV_CLIENT_ID?.trim() ?? ''

  if (!accountId) {
    return NextResponse.json({ error: 'no_active_account' }, { status: 400 })
  }

  try {
    const otpRes = await fetch(
      `${DERIV_API_URL}/trading/v1/options/accounts/${accountId}/otp`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.accessToken}`,
          'Deriv-App-ID':  clientId,
          'Content-Type':  'application/json',
        },
      }
    )

    if (!otpRes.ok) {
      const errBody = await otpRes.text()
      console.error('[Lima Trade] OTP fetch failed:', otpRes.status, errBody)
      return NextResponse.json(
        { error: 'otp_failed', status: otpRes.status },
        { status: otpRes.status }
      )
    }

    const otpData = await otpRes.json()
    // Response: { data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=..." } }
    const wsUrl = otpData?.data?.url ?? otpData?.url

    if (!wsUrl) {
      console.error('[Lima Trade] No WS URL in OTP response:', JSON.stringify(otpData))
      return NextResponse.json({ error: 'no_ws_url' }, { status: 500 })
    }

    return NextResponse.json({ wsUrl })
  } catch (e) {
    console.error('[Lima Trade] WS URL error:', e)
    return NextResponse.json({ error: 'server_error' }, { status: 500 })
  }
}
