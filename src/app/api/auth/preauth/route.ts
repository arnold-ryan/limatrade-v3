import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { DERIV_OAUTH_URL, DERIV_SCOPE } from '@/lib/auth/constants'
import { getSession } from '@/lib/auth/session'

/**
 * GET /api/auth/preauth
 *
 * Pre-generates the Deriv OAuth URL and stores the PKCE verifier in the session.
 * Call this in the background on page load so the redirect URL is ready instantly
 * when the user clicks Login — removing the server round-trip from the click path.
 *
 * Returns: { url: string }
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.DERIV_CLIENT_ID?.trim()
  if (!clientId) {
    return NextResponse.json({ error: 'server_config' }, { status: 500 })
  }

  // ── Resolve redirect URI ──────────────────────────────────────────────────
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
  const codeVerifier  = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  const state         = crypto.randomBytes(16).toString('hex')

  // ── Persist verifier + state in session ───────────────────────────────────
  const session = await getSession()
  session.pkceVerifier = codeVerifier
  session.oauthState   = state
  session.isLoggedIn   = false
  session.accessToken  = undefined
  session.accounts     = undefined
  await session.save()

  // ── Build and return the OAuth URL ────────────────────────────────────────
  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    scope:                 DERIV_SCOPE,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  })

  const url = `${DERIV_OAUTH_URL}?${params.toString()}`

  return NextResponse.json({ url }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
