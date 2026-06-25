import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { DERIV_TOKEN_URL, DERIV_API_BASE } from '@/lib/auth/constants'

export async function POST(req: NextRequest) {
  try {
    const { code, state } = await req.json()

    // 1. Read + validate the PKCE cookie
    const pkce = req.cookies.get('lt_pkce')?.value
    if (!pkce) return NextResponse.json({ ok: false, error: 'pkce_missing' }, { status: 400 })

    const { verifier, state: savedState } = JSON.parse(pkce)

    if (!state || state !== savedState) {
      return NextResponse.json({ ok: false, error: 'state_mismatch' }, { status: 400 })
    }

    // 2. Exchange code for access token — happens server-side only
    const tokenRes = await fetch(DERIV_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.DERIV_CLIENT_ID!,
        code,
        code_verifier: verifier,
        redirect_uri:  process.env.NEXT_PUBLIC_REDIRECT_URI!,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      console.error('Token exchange failed:', err)
      return NextResponse.json({ ok: false, error: 'token_exchange_failed' }, { status: 400 })
    }

    const { access_token } = await tokenRes.json()

    // 3. Fetch the user's account ID
    const accountsRes = await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Deriv-App-ID':  process.env.DERIV_CLIENT_ID!,
      },
    })

    let accountId = ''
    if (accountsRes.ok) {
      const data = await accountsRes.json()
      // Use demo account by default, fall back to first account
      const accounts = data?.data ?? []
      const demo = accounts.find((a: { account_type: string }) => a.account_type === 'demo')
      accountId = (demo ?? accounts[0])?.account_id ?? ''
    }

    // 4. Save to encrypted session cookie
    const session = await getSession()
    session.accessToken = access_token
    session.accountId   = accountId
    session.isLoggedIn  = true
    await session.save()

    // 5. Clear the PKCE cookie — single use
    const res = NextResponse.json({ ok: true })
    res.cookies.delete('lt_pkce')
    return res

  } catch (e) {
    console.error('Auth token error:', e)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
