import { NextRequest, NextResponse } from 'next/server'
import { generateVerifier, generateChallenge, generateState } from '@/lib/auth/pkce'
import { DERIV_AUTH_URL, DERIV_SCOPES } from '@/lib/auth/constants'

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') ?? 'login'

  const verifier  = generateVerifier()
  const challenge = await generateChallenge(verifier)
  const state     = generateState()

  // Build Deriv auth URL
  const params = new URLSearchParams({
    response_type:          'code',
    client_id:              process.env.DERIV_CLIENT_ID!,
    redirect_uri:           process.env.NEXT_PUBLIC_REDIRECT_URI!,
    scope:                  DERIV_SCOPES,
    state,
    code_challenge:         challenge,
    code_challenge_method:  'S256',
    ...(mode === 'signup' && { prompt: 'registration' }),
  })

  const authUrl = `${DERIV_AUTH_URL}?${params.toString()}`

  // Store verifier + state in a short-lived httpOnly cookie
  // so we can verify them when Deriv calls back
  const res = NextResponse.redirect(authUrl)
  res.cookies.set('lt_pkce', JSON.stringify({ verifier, state }), {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   60 * 10, // 10 minutes — plenty of time to complete login
    path:     '/',
  })

  return res
}
