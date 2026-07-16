import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * GET /api/user/token
 *
 * Returns the legacy Deriv access token (a1-...) for the current session.
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
