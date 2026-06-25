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
 * Visit /api/auth/debug to see the exact value this server will use.
 */
export async function GET(req: NextRequest) {
  const appId = process.env.DERIV_CLIENT_ID?.trim()

  if (!appId) {
    console.error('[Lima Trade] DERIV_CLIENT_ID is not set.')
    return NextResponse.redirect(new URL('/?auth_error=server_config', req.url))
  }

  /*
   * Resolve the redirect URI — priority order:
   *
   * 1. NEXT_PUBLIC_REDIRECT_URI env var  — explicit override, always wins when set
   * 2. VERCEL_URL system env             — auto-set by Vercel, reliable for most cases
   * 3. x-forwarded headers               — self-hosted / other platforms
   *    NOTE: Vercel (and some proxies) can send comma-separated values like
   *    "https,https" in x-forwarded-proto, so we always take the first segment.
   * 4. req.url origin                    — local dev / last resort
   *
   * Whatever value this produces MUST match the OAuth Redirect URL registered
   * at https://developers.deriv.com → Your App → OAuth Redirect URL.
   * Use /api/auth/debug to see the exact URL this server computes.
   */
  let redirectUri: string

  if (process.env.NEXT_PUBLIC_REDIRECT_URI?.trim()) {
    // Explicit override — use exactly as configured
    redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI.trim()
  } else if (process.env.VERCEL_URL) {
    // Vercel sets VERCEL_URL automatically (no protocol prefix)
    redirectUri = `https://${process.env.VERCEL_URL}/callback`
  } else {
    // Parse reverse-proxy headers; split on comma to handle "https,https" values
    const proto  = (req.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
    const host   = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim()
    const origin = host ? `${proto}://${host}` : new URL(req.url).origin
    redirectUri  = `${origin}/callback`
  }

  console.log(`[Lima Trade] OAuth login → app_id=${appId} redirect_uri=${redirectUri}`)

  const params = new URLSearchParams({
    app_id:       appId,
    l:            'en',
    brand:        'deriv',
    redirect_uri: redirectUri,
  })

  return NextResponse.redirect(`${DERIV_OAUTH_URL}?${params.toString()}`)
}
