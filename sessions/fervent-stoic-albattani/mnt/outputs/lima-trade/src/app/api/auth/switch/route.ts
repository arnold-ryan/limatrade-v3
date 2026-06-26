import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * POST /api/auth/switch
 * Switches the active account.
 *
 * Body: { accountId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession()

    if (!session.isLoggedIn) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json() as { accountId?: string; loginid?: string }
    // Support both new accountId format and legacy loginid
    const targetId = body.accountId ?? body.loginid

    if (!targetId) {
      return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    }

    const account = session.accounts?.find(
      a => a.accountId === targetId
    )

    if (!account) {
      return NextResponse.json({ error: 'account_not_found' }, { status: 404 })
    }

    session.activeAccountId = account.accountId
    await session.save()

    return NextResponse.json({ ok: true, activeAccountId: account.accountId })
  } catch (e) {
    console.error('[Lima Trade] Switch account error:', e)
    return NextResponse.json({ error: 'server_error' }, { status: 500 })
  }
}
