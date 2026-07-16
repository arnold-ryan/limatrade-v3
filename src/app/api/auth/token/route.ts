import { NextRequest, NextResponse } from 'next/server'
import { unsealData } from 'iron-session'
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
 * The PKCE code_verifier is recovered by unsealing the `state` parameter
 * (which the login route sealed with SESSION_SECRET). This avoids any
 * dependency on cookies surviving the OAuth redirect.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { code?: string; state?: string }
    const { code, state } = body

    if (!code) {
      return NextResponse.json({ ok: false, error: 'missing_code' }, { status: 400 })
    }
    if (!state) {
      return NextResponse.json({ ok: false, error: 'missing_state' }, { status: 400 })
    }

    const clientId = process.env.DERIV_CLIENT_ID?.trim()
    if (!clientId) {
      return NextResponse.json({ ok: false, error: 'server_config' }, { status: 500 })
    }

    // ── Recover PKCE verifier from sealed state ───────────────────────────
    let pkceVerifier: string
    try {
      const sealed = await unsealData<{ verifier: string }>(state, {
        password: process.env.SESSION_SECRET!,
      })
      pkceVerifier = sealed.verifier
      if (!pkceVerifier) throw new Error('no verifier in state')
    } catch (e) {
      console.error('[Lima Trade] Failed to unseal state:', e)
      return NextResponse.json({ ok: false, error: 'invalid_session' }, { status: 400 })
    }

    // ── Resolve redirect URI (must match exactly what was used in login) ──
    let redirectUri: string
    if (process.env.NEXT_PUBLIC_REDIRECT_URI?.trim()) {
      redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI.trim()
    } else if (process.env.NEXT_PUBLIC_APP_URL?.trim()) {
      redirectUri = `${process.env.NEXT_PUBLIC_APP_URL.trim()}/callback`
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
        code_verifier: pkceVerifier,
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
    const session = await getSession()
    session.accessToken     = accessToken
    session.activeAccountId = primary?.accountId
    session.accounts        = accounts
    session.isLoggedIn      = true
    session.pkceVerifier    = undefined
    session.oauthState      = undefined
    await session.save()

    return NextResponse.json({ ok: true })

  } catch (e) {
    console.error('[Lima Trade] Auth token error:', e)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
