import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/auth/debug
 *
 * Shows the exact redirect_uri and app_id Lima Trade will use for OAuth.
 * Open this URL in your browser, then copy the redirect_uri value and paste it
 * into your Deriv app settings at https://developers.deriv.com
 *
 * This endpoint only returns config info — no secrets are exposed.
 */
export async function GET(req: NextRequest) {
  const appId = process.env.DERIV_CLIENT_ID ?? '(not set)'

  const origin = req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') ?? 'https'}://${req.headers.get('x-forwarded-host')}`
    : new URL(req.url).origin

  const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI || `${origin}/callback`

  return NextResponse.json({
    message:      'Copy the redirect_uri below and paste it into your Deriv app at developers.deriv.com → Your App → OAuth Redirect URL',
    app_id:       appId,
    redirect_uri: redirectUri,
    login_url:    `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&l=en&brand=deriv&redirect_uri=${encodeURIComponent(redirectUri)}`,
    instructions: [
      '1. Go to https://developers.deriv.com',
      '2. Click your app → Edit',
      `3. Set "OAuth Redirect URL" to exactly: ${redirectUri}`,
      '4. Save the app',
      '5. Try logging in again',
    ],
  })
}
