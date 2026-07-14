import { NextRequest, NextResponse } from 'next/server'
import { DERIV_OAUTH_URL } from '@/lib/auth/constants'

/**
 * GET /api/auth/login
 *
 * Starts the legacy Deriv OAuth flow.
 * Redirects the user to oauth.deriv.com with the app_id.
 * After login, Deriv redirects back to /callback with tokens directly in the URL:
 *   ?acct1=CR...&token1=a1-...&cur1=USD&acct2=VRTC...&token2=a1-...&cur2=USD
 *
 * No PKCE or code exchange needed — tokens arrive in the redirect URL.
 */
export async function GET(req: NextRequest) {
  const appId = process.env.DERIV_CLIENT_ID?.trim()

  if (!appId) {
    console.error('[Lima Trade] DERIV_CLIENT_ID is not set.')
    return NextResponse.redirect(new URL('/?auth_error=server_config', req.url))
  }

  console.log(`[Lima Trade] OAuth login → app_id=${appId}`)

  const params = new URLSearchParams({
    app_id:          appId,
    l:               'EN',
    brand:           'deriv',
    affiliate_token: '6D203A32-6635-4783-BB11-1296C141843C',
  })

  return NextResponse.redirect(`${DERIV_OAUTH_URL}?${params.toString()}`)
}
