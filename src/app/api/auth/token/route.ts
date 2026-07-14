import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import type { AccountInfo } from '@/lib/auth/session'

/**
 * POST /api/auth/token
 *
 * Receives the legacy Deriv accounts from the /callback page and saves them to session.
 *
 * Body: { accounts: [{ accountId, token, currency, isDemo }] }
 *
 * Legacy Deriv OAuth returns tokens directly in the redirect URL — no code exchange needed.
 * This route just parses and stores them.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      accounts?: Array<{ accountId: string; token: string; currency: string; isDemo: boolean }>
    }

    const raw = body.accounts ?? []
    if (raw.length === 0) {
      return NextResponse.json({ ok: false, error: 'no_accounts' }, { status: 400 })
    }

    const accounts: AccountInfo[] = raw.map(a => ({
      accountId: a.accountId,
      isDemo:    a.isDemo,
      currency:  a.currency ?? 'USD',
      type:      a.isDemo ? 'demo' : 'real',
    }))

    // Prefer real account as primary; fall back to demo
    const primary = accounts.find(a => !a.isDemo) ?? accounts[0]
    const primaryToken = raw.find(a => a.accountId === primary.accountId)?.token ?? ''

    const session = await getSession()
    session.accessToken     = primaryToken
    session.activeAccountId = primary.accountId
    session.accounts        = accounts
    session.isLoggedIn      = true
    await session.save()

    console.log(`[Lima Trade] Login OK — account=${primary.accountId} isDemo=${primary.isDemo}`)
    return NextResponse.json({ ok: true })

  } catch (e) {
    console.error('[Lima Trade] Auth token error:', e)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
