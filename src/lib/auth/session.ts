import { getIronSession, IronSession } from 'iron-session'
import { cookies } from 'next/headers'

/** One Deriv trading account (new API format) */
export interface AccountInfo {
  accountId:  string   // New format: "DOT90004580" (new API) or "CR123456" (legacy)
  isDemo:     boolean  // true = demo account
  currency:   string   // e.g. "USD"
  balance?:   number   // populated when fetched from accounts endpoint
  type?:      string   // "demo" | "real"
}

export interface SessionData {
  /** Bearer token from OAuth (format: "ory_at_...") */
  accessToken?:      string
  /** ID of the currently active account */
  activeAccountId?:  string
  /** All accounts returned from the accounts endpoint */
  accounts?:         AccountInfo[]
  isLoggedIn:        boolean

  // ── Temporary PKCE state (stored during OAuth flow, cleared after token exchange) ──
  /** code_verifier for PKCE — stored server-side, never sent to browser */
  pkceVerifier?:     string
  /** state for CSRF protection */
  oauthState?:       string
}

/* Validate SESSION_SECRET at import time so errors surface immediately in logs */
if (!process.env.SESSION_SECRET) {
  throw new Error(
    '[Lima Trade] SESSION_SECRET is not set. ' +
    'Generate one at https://generate-secret.vercel.app/32 and add it to your environment variables.'
  )
}
if (process.env.SESSION_SECRET.length < 32) {
  throw new Error('[Lima Trade] SESSION_SECRET must be at least 32 characters long.')
}

const sessionOptions = {
  password:   process.env.SESSION_SECRET,
  cookieName: 'lt_session',
  cookieOptions: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge:   60 * 60 * 8, // 8 hours
    path:     '/',
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}
