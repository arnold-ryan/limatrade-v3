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

const sessionOptions = {
  password:   process.env.SESSION_SECRET as string,
  cookieName: 'lt_session',
  cookieOptions: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge:   60 * 60 * 8, // 8 hours
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}
