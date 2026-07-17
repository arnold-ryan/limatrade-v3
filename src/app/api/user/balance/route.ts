import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { ensureValidToken } from '@/lib/auth/refresh'
import { DERIV_API_URL } from '@/lib/auth/constants'

/**
 * GET /api/user/balance
 *
 * Returns all accounts with balances from the Deriv REST API.
 * Silently refreshes the access token if expired.
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const valid = await ensureValidToken(session)
  if (!valid) {
    return NextResponse.json({ error: 'session_expired' }, { status: 401 })
  }

  const clientId = process.env.DERIV_CLIENT_ID?.trim() ?? ''

  try {
    const res = await fetch(`${DERIV_API_URL}/trading/v1/options/accounts`, {
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
        'Deriv-App-ID':  clientId,
        'Cache-Control': 'no-cache',
      },
    })

    if (!res.ok) {
      return NextResponse.json({
        accounts:        session.accounts ?? [],
        activeAccountId: session.activeAccountId,
      })
    }

    const data = await res.json()
    const raw: any[] = Array.isArray(data) ? data : (data.data ?? data.accounts ?? [])
    const accounts = raw.map((a: any) => ({
      accountId: a.account_id ?? a.accountId ?? a.id ?? '',
      isDemo:    a.account_type === 'demo' || a.is_demo === true || a.type === 'demo',
      currency:  a.currency ?? 'USD',
      balance:   a.balance ?? 0,
      type:      a.account_type ?? a.type,
    })).filter((a: any) => a.accountId)

    session.accounts = accounts
    await session.save()

    return NextResponse.json({ accounts, activeAccountId: session.activeAccountId })
  } catch (e) {
    return NextResponse.json({
      accounts:        session.accounts ?? [],
      activeAccountId: session.activeAccountId,
    })
  }
}
