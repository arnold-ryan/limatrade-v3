import { getIronSession, IronSession } from 'iron-session'
import { cookies } from 'next/headers'

/** One Deriv trading account */
export interface AccountInfo {
  accountId:  string
  isDemo:     boolean
  currency:   string
  balance?:   number
  type?:      string
}

export interface SessionData {
  /** Bearer token from Deriv OAuth (format: "ory_at_...") */
  accessToken?:      string
  /** Refresh token for silent renewal — only present if offline_access scope was granted */
  refreshToken?:     string
  /** Unix ms timestamp when the access token expires (with 60s safety buffer) */
  tokenExpiresAt?:   number
  /** ID of the currently active account */
  activeAccountId?:  string
  /** All accounts returned from the accounts endpoint */
  accounts?:         AccountInfo[]
  /** True when the last attempt to fetch accounts from Deriv failed — the UI
   *  should show a visible error instead of trusting an empty/stale account list. */
  accountsError?:    boolean
  isLoggedIn:        boolean
  /** Temporary PKCE fields — cleared after token exchange */
  pkceVerifier?:     string
  oauthState?:       string
}

if (!process.env.SESSION_SECRET) {
  throw new Error('[Lima Trade] SESSION_SECRET is not set.')
}
if (process.env.SESSION_SECRET.length < 32) {
  throw new Error('[Lima Trade] SESSION_SECRET must be at least 32 characters.')
}

const sessionOptions = {
  password:   process.env.SESSION_SECRET,
  cookieName: 'lt_session',
  cookieOptions: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    // 30 days — the refresh token keeps the session alive; we refresh the
    // access_token silently so users never see the consent screen again.
    maxAge:   60 * 60 * 24 * 30,
    path:     '/',
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}
