import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { DERIV_TOKEN_URL, DERIV_API_URL } from '@/lib/auth/constants'
import type { AccountInfo } from '@/lib/auth/session'

/**
 * POST /api/auth/token
 *
 * Exchanges the OAuth authorization code for a Bearer access token,
 * then fetches the user's accounts and saves everything to the session.
 *
 * Body: { code: string, state: string }
 *
 * Steps:
 *   1. Verify the state matches what we stored in the session (CSRF protection)
 *   2. POST to https://auth.deriv.com/oauth2/token with code + code_verifier
 *   3. GET  https://api.derivws.com/trading/v1/options/accounts → get account list
 *   4. Save Bearer token + accounts to session
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { code?: string; state?: string }
    const { code, state } = body

    if (!code) {
      return NextResponse.json({ ok: false, error: 'missing_code' }, { status: 400 })
    }

    const clientId = process.env.DERIV_CLIENT_ID?.trim()
    if (!clientId) {
      return NextResponse.json({ ok: false, error: 'server_config' }, { status: 500 })
    }

    // ── Read PKCE verifier + state from session ───────────────────────────
    const session = await getSession()

    if (!session.pkceVerifier || !session.oauthState) {
      console.error('[Lima Trade] No PKCE verifier in session — login flow may have restarted')
      return NextResponse.json({ ok: false, error: 'invalid_session' }, { status: 400 })
    }

    // ── Verify state (CSRF protection) ────────────────────────────────────
    if (state && state !== session.oauthState) {
      console.error('[Lima Trade] State mismatch — possible CSRF attack')
      return NextResponse.json({ ok: false, error: 'state_mismatch' }, { status: 400 })
    }

    // ── Resolve redirect URI (must match exactly what was used in login) ──
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

    // ── Exchange authorization code for Bearer token ───────────────────────
    const tokenRes = await fetch(DERIV_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        code,
        code_verifier: session.pkceVerifier,
        redirect_uri:  redirectUri,
      }).toString(),
    })

    if (!tokenRes.ok) {
      const errText = await tokenRes.text()
      console.error('[Lima Trade] Token exchange failed:', tokenRes.status, errText)
      return NextResponse.json({ ok: false, error: 'token_exchange_failed' }, { status: 401 })
    }

    const tokenData = await tokenRes.json() as {
      access_token:  string
      expires_in:    number
      token_type:    string
    }

    const accessToken = tokenData.access_token
    if (!accessToken) {
      console.error('[Lima Trade] No access_token in token response')
      return NextResponse.json({ ok: false, error: 'no_access_token' }, { status: 401 })
    }

    // ── Fetch user's accounts ─────────────────────────────────────────────
    let accounts: AccountInfo[] = []
    try {
      const accountsRes = await fetch(`${DERIV_API_URL}/trading/v1/options/accounts`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Deriv-App-ID':  clientId,
        },
      })

      if (accountsRes.ok) {
        const accountsData = await accountsRes.json()
        // Handle both { data: [...] } and direct array responses
        const raw: unknown[] = Array.isArray(accountsData)
          ? accountsData
          : (accountsData.data ?? accountsData.accounts ?? [])

        accounts = raw.map((a: any) => ({
          accountId: a.account_id ?? a.accountId ?? a.id ?? '',
          isDemo:    a.account_type === 'demo' || a.is_demo === true || a.type === 'demo',
          currency:  a.currency ?? 'USD',
          balance:   a.balance ?? undefined,
          type:      a.account_type ?? a.type,
        })).filter(a => a.accountId)
      } else {
        console.warn('[Lima Trade] Accounts fetch returned', accountsRes.status)
      }
    } catch (e) {
      console.warn('[Lima Trade] Could not fetch accounts after token exchange:', e)
    }

    // Default to demo account so charts/trading pages start on demo balance
    const primary = accounts.find(a => a.isDemo) ?? accounts[0]

    // ── Save to session ───────────────────────────────────────────────────
    session.accessToken     = accessToken
    session.activeAccountId = primary?.accountId
    session.accounts        = accounts
    session.isLoggedIn      = true
    // Clear PKCE state — no longer needed
    session.pkceVerifier    = undefined
    session.oauthState      = undefined
    await session.save()

    return NextResponse.json({ ok: true })

  } catch (e) {
    console.error('[Lima Trade] Auth token error:', e)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
