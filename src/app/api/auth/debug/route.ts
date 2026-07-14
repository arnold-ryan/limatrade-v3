import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/auth/debug
 * Shows the exact OAuth config Lima Trade will use. Visit this first when debugging login.
 */
export async function GET(req: NextRequest) {
  const appId = process.env.DERIV_CLIENT_ID?.trim() ?? '(not set)'

  const proto  = (req.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
  const host   = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim()
  const origin = host ? `${proto}://${host}` : new URL(req.url).origin
  const callbackUrl = `${origin}/callback`

  return NextResponse.json({
    api_version:   'LEGACY (oauth.deriv.com)',
    app_id:        appId,
    callback_url:  callbackUrl,

    login_url_preview: `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&l=EN&brand=deriv`,

    raw: {
      DERIV_CLIENT_ID:          process.env.DERIV_CLIENT_ID          ?? '(not set)',
      SESSION_SECRET_set:       !!process.env.SESSION_SECRET,
      'x-forwarded-proto':      req.headers.get('x-forwarded-proto')  ?? '(not set)',
      'x-forwarded-host':       req.headers.get('x-forwarded-host')   ?? '(not set)',
    },

    instructions: [
      '1. Go to https://api.deriv.com/dashboard → Applications',
      '2. Create or find your app — copy the numeric App ID',
      `3. Set "OAuth Redirect URL" in the app to exactly: ${callbackUrl}`,
      '4. Set DERIV_CLIENT_ID on Vercel to the numeric App ID (e.g. "12345")',
      '5. Try logging in',
    ],
  })
}
