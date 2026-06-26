import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { DERIV_API_URL } from '@/lib/auth/constants'

/**
 * GET /api/user/balance
 *
 * Returns all accounts with their balances from the new Deriv REST API.
 * Used by AppHeader to show Real/Demo balances.
 */
export async function GET() {
  const session = await getSession()

  if (!session.isLoggedIn || !session.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      console.error('[Lima Trade] Balance fetch error:', res.status)
      // Fall back to session accounts if REST fails
      return NextResponse.json({ accounts: session.accounts ?? [] })
    }

    const data = await res.json()
    const raw: any[] = Array.isArray(data)
      ? data
      : (data.data ?? data.accounts ?? [])

    const accounts = raw.map((a: any) => ({
      accountId: a.account_id ?? a.accountId ?? a.id ?? '',
      isDemo:    a.account_type === 'demo' || a.is_demo === true || a.type === 'demo',
      currency:  a.currency ?? 'USD',
      balance:   a.balance ?? 0,
      type:      a.account_type ?? a.type,
    })).filter((a: any) => a.accountId)

    // Update session accounts with fresh balances
    session.accounts = accounts
    await session.save()

    return NextResponse.json({
      accounts,
      activeAccountId: session.activeAccountId,
    })
  } catch (e) {
    console.error('[Lima Trade] Balance error:', e)
    // Return session data as fallback
    return NextResponse.json({
      accounts: session.accounts ?? [],
      activeAccountId: session.activeAccountId,
    })
  }
}
