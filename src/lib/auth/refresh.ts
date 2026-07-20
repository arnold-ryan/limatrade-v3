import { DERIV_TOKEN_URL, DERIV_API_URL } from '@/lib/auth/constants'
import type { IronSession } from 'iron-session'
import type { SessionData } from '@/lib/auth/session'

/**
 * Silently refreshes the Deriv access token using the stored refresh token.
 * Call this before any server route that uses the access token.
 *
 * Returns true if the token is valid (was refreshed or hadn't expired yet).
 * Returns false if the refresh failed — the caller should return 401 so the
 * client redirects to login.
 *
 * This is the key fix for the overnight login failure: instead of sending the
 * user through the consent screen again, we silently get a new access token.
 */
export async function ensureValidToken(
  session: IronSession<SessionData>
): Promise<boolean> {
  // Token still valid — nothing to do
  const now = Date.now()
  if (!session.tokenExpiresAt || now < session.tokenExpiresAt) {
    return true
  }

  // Token expired. Try to refresh.
  if (!session.refreshToken) {
    console.warn('[Lima Trade] Token expired and no refresh token — user must re-login')
    return false
  }

  const clientId = process.env.DERIV_CLIENT_ID?.trim()
  if (!clientId) return false

  try {
    console.log('[Lima Trade] Access token expired — refreshing silently')
    const res = await fetch(DERIV_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        refresh_token: session.refreshToken,
      }).toString(),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('[Lima Trade] Token refresh failed:', res.status, text)
      // Refresh token is invalid/expired — clear session, force re-login
      session.isLoggedIn      = false
      session.accessToken     = undefined
      session.refreshToken    = undefined
      session.tokenExpiresAt  = undefined
      await session.save()
      return false
    }

    const data = await res.json() as {
      access_token:  string
      refresh_token?: string
      expires_in:    number
    }

    // Update session with new tokens
    session.accessToken    = data.access_token
    session.refreshToken   = data.refresh_token ?? session.refreshToken
    session.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000

    // Also refresh account list with new token
    try {
      const accountsRes = await fetch(`${DERIV_API_URL}/trading/v1/options/accounts`, {
        headers: {
          'Authorization': `Bearer ${data.access_token}`,
          'Deriv-App-ID':  clientId,
        },
      })
      if (accountsRes.ok) {
        const accountsData = await accountsRes.json()
        const raw: any[] = Array.isArray(accountsData)
          ? accountsData
          : (accountsData.data ?? accountsData.accounts ?? [])
        if (raw.length > 0) {
          session.accounts = raw.map((a: any) => ({
            accountId: a.account_id ?? a.accountId ?? a.id ?? '',
            isDemo:    a.account_type === 'demo' || a.is_demo === true || a.type === 'demo',
            currency:  a.currency ?? 'USD',
            balance:   a.balance ?? undefined,
            type:      a.account_type ?? a.type,
          })).filter((a: any) => a.accountId)
          session.accountsError = false
        } else {
          session.accountsError = true
        }
      } else {
        console.error('[Lima Trade] Silent-refresh accounts fetch failed:', accountsRes.status)
        session.accountsError = true
      }
    } catch (e) {
      console.warn('[Lima Trade] Silent-refresh accounts fetch error:', e)
      session.accountsError = true
    }

    await session.save()
    console.log('[Lima Trade] Token refreshed successfully')
    return true

  } catch (e) {
    console.error('[Lima Trade] Token refresh error:', e)
    return false
  }
}
