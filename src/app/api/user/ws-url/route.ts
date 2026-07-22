import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { ensureValidToken } from '@/lib/auth/refresh'
import { DERIV_API_URL } from '@/lib/auth/constants'

/**
 * GET /api/user/ws-url
 *
 * Returns a one-time authenticated WebSocket URL (OTP) for the active account.
 * Silently refreshes the access token if it has expired.
 *
 * Client flow:
 *   1. Call this endpoint to get { wsUrl }
 *   2. Connect: new WebSocket(wsUrl)
 *   3. Subscribe to transactions, balance, etc.
 *   4. Buy contracts with: { buy: '1', price: ..., parameters: { ... } }
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Silently refresh the access token if expired
  const valid = await ensureValidToken(session)
  if (!valid) {
    return NextResponse.json({ error: 'session_expired' }, { status: 401 })
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
      // Include a truncated version of Deriv's actual error text in the
      // response (not just our own generic 'otp_failed' code) — without it,
      // diagnosing a persistent connection failure means digging through
      // Vercel function logs, which isn't always practical in the moment.
      return NextResponse.json(
        { error: 'otp_failed', status: otpRes.status, detail: errBody.slice(0, 200) },
        { status: otpRes.status }
      )
    }

    const otpData = await otpRes.json()
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
