import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { sealData } from 'iron-session'
import { DERIV_OAUTH_URL, DERIV_SCOPE } from '@/lib/auth/constants'

/**
 * GET /api/auth/login
 *
 * Starts the Deriv OAuth 2.0 + PKCE authorization flow.
 *
 * Instead of storing the PKCE code_verifier in a session cookie (which Vercel's
 * CDN can strip from redirect responses), we seal it into the `state` parameter
 * itself. Deriv echoes `state` back untouched on the callback, so the token route
 * can unseal it to get the verifier — zero cookie dependency during the OAuth dance.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.DERIV_CLIENT_ID?.trim()

  if (!clientId) {
    console.error('[Lima Trade] DERIV_CLIENT_ID is not set.')
    return NextResponse.redirect(new URL('/?auth_error=server_config', req.url))
  }

  // ── Resolve redirect URI ───────────────────────────────────────────────────
  let redirectUri: string
  if (process.env.NEXT_PUBLIC_REDIRECT_URI?.trim()) {
    redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI.trim()
  } else if (process.env.NEXT_PUBLIC_APP_URL?.trim()) {
    redirectUri = `${process.env.NEXT_PUBLIC_APP_URL.trim()}/callback`
  } else {
    // Derive from request headers — works on Vercel & local
    const proto  = (req.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
    const host   = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim()
    const origin = host ? `${proto}://${host}` : new URL(req.url).origin
    redirectUri  = `${origin}/callback`
  }

  // ── Generate PKCE ─────────────────────────────────────────────────────────
  const codeVerifier  = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

  // ── Seal verifier into the state param (no cookie needed) ─────────────────
  // Deriv echoes `state` back verbatim on the callback. We unseal it in the
  // token route to recover the verifier — completely cookie-free.
  const sealed = await sealData(
    { verifier: codeVerifier },
    { password: process.env.SESSION_SECRET!, ttl: 60 * 60 }, // 60-min window — generous
    // enough that a slow interactive Deriv login (password + 2FA) can't
    // outrun it, since the clock starts here, not when Deriv finishes.
  )

  // iron's seal format (`Fe26.2**<hmac>*<salt>*...`) contains `*`, `+`, `/`,
  // `=` — all legal in a query string once percent-encoded, but only if
  // every hop treats the value as fully opaque. We can't verify that Deriv's
  // redirect round-trip does (some OAuth servers decode/re-encode `state`
  // instead of passing it through byte-for-byte). Re-wrapping in base64url
  // (alphabet: A-Za-z0-9-_, no padding) removes every character that could
  // be misinterpreted, so this failure mode is eliminated regardless of
  // whether it was the actual cause.
  const state = Buffer.from(sealed, 'utf8').toString('base64url')

  console.log(`[Lima Trade] OAuth login → client_id=${clientId} redirect_uri=${redirectUri}`)

  // ── Build authorization URL ───────────────────────────────────────────────
  // NOTE: affiliate_token is a legacy oauth.deriv.com param — do NOT include it
  // here. Sending it to auth.deriv.com (Hydra) causes the consent step to fail.
  // Affiliate tracking is handled separately via signup links.
  const authParams = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    scope:                 DERIV_SCOPE,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  })

  return NextResponse.redirect(`${DERIV_OAUTH_URL}?${authParams.toString()}`)
}
