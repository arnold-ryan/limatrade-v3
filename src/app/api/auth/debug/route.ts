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
  const appId = process.env.DERIV_CLIENT_ID?.trim() ?? '(not set)'

  // ── Mirror the EXACT same logic as /api/auth/login ──────────────────────
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
    // ── What to register in Deriv ──────────────────────────────────────────
    step1_register_this_in_deriv: redirectUri,
    redirect_uri_source:          redirectSource,

    // ── Verify these look right ────────────────────────────────────────────
    app_id:    appId,
    login_url: `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&l=en&brand=deriv&redirect_uri=${encodeURIComponent(redirectUri)}`,

    // ── Raw env / header values (for diagnosing mismatches) ───────────────
    raw: {
      NEXT_PUBLIC_REDIRECT_URI: process.env.NEXT_PUBLIC_REDIRECT_URI ?? '(not set)',
      VERCEL_URL:               process.env.VERCEL_URL               ?? '(not set)',
      'x-forwarded-proto':      req.headers.get('x-forwarded-proto') ?? '(not set)',
      'x-forwarded-host':       req.headers.get('x-forwarded-host')  ?? '(not set)',
      'x-forwarded-for':        req.headers.get('x-forwarded-for')   ?? '(not set)',
      req_url:                  req.url,
    },

    instructions: [
      '1. Go to https://developers.deriv.com',
      '2. Click your app → Edit',
      `3. Set "OAuth Redirect URL" to exactly: ${redirectUri}`,
      '   (copy-paste — even a trailing slash difference will break it)',
      '4. Save the app',
      '5. Try logging in again',
    ],
  })
}
