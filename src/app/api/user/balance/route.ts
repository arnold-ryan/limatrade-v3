import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * GET /api/user/balance
 *
 * Returns account info from the session.
 * Real-time balance is pushed via the WS balance subscription in each trading page.
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn || !session.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    accounts:        session.accounts ?? [],
    activeAccountId: session.activeAccountId,
  })
}
