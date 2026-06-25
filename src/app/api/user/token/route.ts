import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * GET /api/user/token
 *
 * Returns the Bearer access token for the current session.
 * Used by client components to get a WS OTP URL from the Deriv REST API.
 *
 * The token is a Bearer format (ory_at_...) from the new Deriv OAuth system.
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn || !session.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    token:           session.accessToken,
    activeAccountId: session.activeAccountId,
    accounts:        session.accounts ?? [],
  })
}
