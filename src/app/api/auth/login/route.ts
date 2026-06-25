import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { DERIV_OAUTH_URL, DERIV_SCOPE } from '@/lib/auth/constants'
import { getSession } from '@/lib/auth/session'

/**
 * GET /api/auth/login
 *
 * Starts the Deriv OAuth 2.0 + PKCE authorization flow.
 *
 * New Deriv API (developers.deriv.com) uses:
 *   - Auth endpoint: https://auth.deriv.com/oauth2/auth
 *   - Client ID: alphanumeric string (e.g. "33EsxEGxJdpnIFRvtiSpY")
 *   - Flow: Authorization Code + PKCE (no client_secret)
 *   - Response: ?code=AUTH_CODE&state=STATE (NOT ?token1=...)
 *
 * PKCE prevents code interception attacks — even if the auth code is
 * intercepted, it cannot be exchanged without the code_verifier stored here.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.DERIV_CLIENT_ID?.trim()

  if (!clientId) {
    console.error('[Lima Trade] DERIV_CLIENT_ID is not set.')
    return NextResponse.redirect(new URL('/?auth_error=server_config', req.url))
  }

  // ── Resolve redirect URI (same priority logic as debug endpoint) ──────────
  let redirectUri: string
  if (process.env.NEXT_PUBLIC_REDIRECT_URI?.trim()) {
    redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI.trim()
  } else if (process.env.VERCEL_URL) {
    redirectUri = `https://${process.env.VERCEL_URL}/callback`
  } else {
    const proto  = (req.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
    const host   = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim()
    const origin = host ? `${proto}://${host}` : new URL(req.url).origin
    redirectUri  = `${origin}/callback`
  }

  // ── Generate PKCE ─────────────────────────────────────────────────────────
  // code_verifier: cryptographically random string (43-128 chars, base64url)
  const codeVerifier  = crypto.randomBytes(32).toString('base64url')
  // code_challenge: BASE64URL(SHA256(code_verifier))
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  // state: random value for CSRF protection
  const state         = crypto.randomBytes(16).toString('hex')

  // ── Store verifier + state in session (server-side only) ──────────────────
  // These are read back in /api/auth/token during the code exchange step.
  const session = await getSession()
  session.pkceVerifier = codeVerifier
  session.oauthState   = state
  // Clear any previous login data so the session is clean
  session.isLoggedIn   = false
  session.accessToken  = undefined
  session.accounts     = undefined
  await session.save()

  console.log(`[Lima Trade] OAuth login → client_id=${clientId} redirect_uri=${redirectUri}`)

  // ── Build authorization URL ───────────────────────────────────────────────
  const params = new URLSearchParams({
    response_type:          'code',
    client_id:              clientId,
    redirect_uri:           redirectUri,
    scope:                  DERIV_SCOPE,
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  'S256',
  })

  return NextResponse.redirect(`${DERIV_OAUTH_URL}?${params.toString()}`)
}
