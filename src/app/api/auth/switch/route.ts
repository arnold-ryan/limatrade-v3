import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * POST /api/auth/switch
 * Switches the currently active Deriv account (real ↔ demo).
 *
 * Body: { loginid: "VRTC123456" }
 *
 * Finds the matching account from session.accounts, updates session.accessToken
 * and session.accountId. The client re-fetches balance after calling this.
 */
export async function POST(req: NextRequest) {
  try {
    const { loginid } = await req.json() as { loginid?: string }
    if (!loginid) {
      return NextResponse.json({ ok: false, error: 'missing_loginid' }, { status: 400 })
    }

    const session = await getSession()
    if (!session.isLoggedIn || !session.accounts?.length) {
      return NextResponse.json({ ok: false, error: 'not_logged_in' }, { status: 401 })
    }

    const target = session.accounts.find(a => a.loginid === loginid)
    if (!target) {
      return NextResponse.json({ ok: false, error: 'account_not_found' }, { status: 404 })
    }

    session.accessToken = target.token
    session.accountId   = target.loginid
    await session.save()

    return NextResponse.json({ ok: true, loginid: target.loginid, currency: target.currency })

  } catch (e) {
    console.error('Switch account error:', e)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
