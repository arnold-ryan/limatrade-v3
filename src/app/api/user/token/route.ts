import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * GET /api/user/token
 * Returns the Deriv OAuth access token + appId from the encrypted iron-session cookie.
 * Used by client-side components that need to open an authorized Deriv WebSocket.
 *
 * The token is scoped to the app_id registered with Deriv, so we return both
 * together so the client can open: wss://ws.binaryws.com/websockets/v3?app_id={appId}
 * then immediately authorize: { authorize: token }
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

  return NextResponse.json({
    token: session.accessToken,
    appId,
  })
}
