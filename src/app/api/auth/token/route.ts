import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import type { AccountInfo } from '@/lib/auth/session'

/**
 * POST /api/auth/token
 * Saves Deriv OAuth tokens to the encrypted iron-session cookie.
 *
 * Body: { accounts: [{ token, loginid, currency }] }
 *
 * Deriv returns one token per account:
 *   - Real accounts:  loginid starts with "CR" (e.g. "CR123456")
 *   - Demo accounts:  loginid starts with "VRTC" (e.g. "VRTC123456")
 *
 * We default the active account to the first REAL account found.
 * The user can switch to demo via AppHeader (calls /api/auth/switch).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      accounts?: Array<{ token: string; loginid: string; currency: string }>
    }

    const raw = body?.accounts ?? []
    if (raw.length === 0) {
      return NextResponse.json({ ok: false, error: 'no_accounts' }, { status: 400 })
    }

    const accounts: AccountInfo[] = raw.map(a => ({
      token:    a.token,
      loginid:  a.loginid,
      currency: a.currency ?? 'USD',
      // Demo accounts have loginids that start with "VRTC"
      isDemo:   a.loginid.startsWith('VRTC'),
    }))

    // Prefer the first real (non-demo) account as the default
    const primary = accounts.find(a => !a.isDemo) ?? accounts[0]

    const session = await getSession()
    session.accessToken = primary.token
    session.accountId   = primary.loginid
    session.accounts    = accounts
    session.isLoggedIn  = true
    await session.save()

    return NextResponse.json({ ok: true })

  } catch (e) {
    console.error('Auth token error:', e)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
