import { getIronSession, IronSession } from 'iron-session'
import { cookies } from 'next/headers'

/** One Deriv trading account (legacy API format) */
export interface AccountInfo {
  accountId:  string   // Deriv loginid: "CR123456" (real) or "VRTC1234" (demo)
  isDemo:     boolean
  currency:   string   // e.g. "USD"
  balance?:   number
  type?:      string   // "real" | "demo"
}

export interface SessionData {
  /** Legacy Deriv token (format: "a1-...") from the OAuth redirect */
  accessToken?:      string
  /** ID of the currently active account (e.g. "CR123456") */
  activeAccountId?:  string
  /** All accounts returned from the OAuth redirect */
  accounts?:         AccountInfo[]
  isLoggedIn:        boolean
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
    maxAge:   60 * 60 * 8, // 8 hours — keeps users logged in through a trading day
    path:     '/',
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}
