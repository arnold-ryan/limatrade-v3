import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/auth/debug
 * Shows the exact OAuth config Lima Trade will use. Visit this first when debugging login.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.DERIV_CLIENT_ID?.trim() ?? '(not set)'

  let redirectUri: string
  let redirectSource: string

  if (process.env.NEXT_PUBLIC_REDIRECT_URI?.trim()) {
    redirectUri    = process.env.NEXT_PUBLIC_REDIRECT_URI.trim()
    redirectSource = 'env:NEXT_PUBLIC_REDIRECT_URI'
  } else if (process.env.VERCEL_URL) {
    redirectUri    = `https://${process.env.VERCEL_URL}/callback`
    redirectSource = 'env:VERCEL_URL'
  } else {
    const proto    = (req.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
    const host     = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim()
    const origin   = host ? `${proto}://${host}` : new URL(req.url).origin
    redirectUri    = `${origin}/callback`
    redirectSource = host ? 'x-forwarded-host header' : 'req.url origin'
  }

  return NextResponse.json({
    api_version:   'NEW (auth.deriv.com — PKCE flow)',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    redirect_source: redirectSource,

    login_url_preview: `https://auth.deriv.com/oauth2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trade+account_manage&state=RANDOM&code_challenge=CHALLENGE&code_challenge_method=S256`,

    raw: {
      NEXT_PUBLIC_REDIRECT_URI: process.env.NEXT_PUBLIC_REDIRECT_URI ?? '(not set)',
      VERCEL_URL:               process.env.VERCEL_URL               ?? '(not set)',
      'x-forwarded-proto':      req.headers.get('x-forwarded-proto') ?? '(not set)',
      'x-forwarded-host':       req.headers.get('x-forwarded-host')  ?? '(not set)',
    },

    instructions: [
      '1. Go to https://developers.deriv.com → your app → Edit',
      `2. Set "OAuth Redirect URL" to exactly: ${redirectUri}`,
      '3. Save the app',
      '4. The client_id above must match your app\'s App ID on developers.deriv.com',
      '5. Try logging in — you should now be redirected back after Deriv login',
    ],
  })
}
