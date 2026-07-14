import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { DERIV_LEGACY_WS_URL } from '@/lib/auth/constants'

/**
 * GET /api/user/ws-url
 *
 * Returns the legacy Deriv WebSocket URL and the session token.
 *
 * The client:
 *   1. Connects to wsUrl
 *   2. On open → sends { authorize: token }
 *   3. On msg.authorize → starts trading (balance, proposals, etc.)
 *
 * Public market data (ticks) can use the same WS URL without authorization.
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn || !session.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const appId = process.env.DERIV_CLIENT_ID?.trim() ?? ''
  const wsUrl = `${DERIV_LEGACY_WS_URL}?app_id=${appId}`

  return NextResponse.json({
    wsUrl,
    token: session.accessToken,
  })
}
