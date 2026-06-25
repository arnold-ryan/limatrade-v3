import { getIronSession, IronSession } from 'iron-session'
import { cookies } from 'next/headers'

/** One Deriv trading account returned from the OAuth callback */
export interface AccountInfo {
  token:    string   // Deriv API token for this account
  loginid:  string   // e.g. "CR123456" (real) or "VRTC123456" (demo)
  currency: string   // e.g. "USD"
  isDemo:   boolean  // true when loginid starts with "VRTC"
}

export interface SessionData {
  /** Token for the currently active account */
  accessToken?: string
  /** Login ID for the currently active account */
  accountId?:   string
  /** All accounts returned by Deriv OAuth (real + demo) */
  accounts?:    AccountInfo[]
  isLoggedIn:   boolean
}

/* Validate critical env vars at import time so the error is obvious in logs */
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
    maxAge:   60 * 60 * 8, // 8 hours — users need to re-auth after this
    path:     '/',
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}
