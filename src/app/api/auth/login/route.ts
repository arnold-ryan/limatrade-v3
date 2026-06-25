import { NextRequest, NextResponse } from 'next/server'
import { DERIV_OAUTH_URL } from '@/lib/auth/constants'

/**
 * GET /api/auth/login
 * Redirects the user to Deriv's OAuth2 authorization page.
 *
 * Deriv OAuth flow:
 *   → https://oauth.deriv.com/oauth2/authorize?app_id={APP_ID}&l=en&brand=deriv&redirect_uri={REDIRECT_URI}
 *
 * After login, Deriv redirects back to REDIRECT_URI with:
 *   ?token1=TOKEN&acct1=LOGINID&cur1=USD[&token2=...&acct2=...&cur2=...]
 *
 * REDIRECT_URI MUST match exactly what's registered in your Deriv app at developers.deriv.com.
 * We auto-compute it from the incoming request origin so it always matches the current domain.
 */
export async function GET(req: NextRequest) {
  const appId = process.env.DERIV_CLIENT_ID

  if (!appId) {
    console.error('[Lima Trade] DERIV_CLIENT_ID is not set.')
    return NextResponse.redirect(new URL('/?auth_error=server_config', req.url))
  }

  /*
   * Compute redirect URI from the live request origin.
   * This automatically resolves to the correct URL in every environment:
   *   - Local dev:   http://localhost:3000/callback
   *   - Vercel:      https://your-app.vercel.app/callback
   *   - Custom:      https://limatrade.com/callback
   *
   * IMPORTANT: whatever URL this produces, it must be registered in your
   * Deriv app at https://developers.deriv.com → Your App → OAuth Redirect URL.
   * Copy the URL from the /api/auth/debug endpoint to see exactly what it is.
   */
  const origin = req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') ?? 'https'}://${req.headers.get('x-forwarded-host')}`
    : new URL(req.url).origin

  // Allow env var override if explicitly set (e.g., for custom domains)
  const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI || `${origin}/callback`

  console.log(`[Lima Trade] OAuth redirect_uri = ${redirectUri}`)

  const params = new URLSearchParams({
    app_id:       appId,
    l:            'en',
    brand:        'deriv',
    redirect_uri: redirectUri,
  })

  return NextResponse.redirect(`${DERIV_OAUTH_URL}?${params.toString()}`)
}
