import { NextRequest, NextResponse } from 'next/server'
import { DERIV_OAUTH_URL } from '@/lib/auth/constants'

/**
 * GET /api/auth/login
 * Redirects the user to Deriv's OAuth2 authorization page.
 *
 * Deriv OAuth flow for third-party apps:
 *   → https://oauth.deriv.com/oauth2/authorize?app_id={APP_ID}&l=en&brand=deriv&redirect_uri={REDIRECT_URI}
 *
 * After login Deriv sends the user back to REDIRECT_URI with tokens in the query string:
 *   ?token1=TOKEN&acct1=LOGINID&cur1=USD[&token2=...&acct2=...&cur2=...]
 *
 * No PKCE, no client_secret, no code exchange — tokens arrive directly.
 * The callback page (/auth/callback) reads those tokens and saves them to the session.
 */
export async function GET(req: NextRequest) {
  const appId       = process.env.DERIV_CLIENT_ID
  const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI

  if (!appId || !redirectUri) {
    console.error('Missing DERIV_CLIENT_ID or NEXT_PUBLIC_REDIRECT_URI env vars')
    return NextResponse.redirect(
      new URL('/?auth_error=server_config', req.url)
    )
  }

  const params = new URLSearchParams({
    app_id:       appId,
    l:            'en',
    brand:        'deriv',
    redirect_uri: redirectUri,
  })

  return NextResponse.redirect(`${DERIV_OAUTH_URL}?${params.toString()}`)
}
