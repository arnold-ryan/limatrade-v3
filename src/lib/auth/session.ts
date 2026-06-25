import { getIronSession, IronSession } from 'iron-session'
import { cookies } from 'next/headers'

export interface SessionData {
  accessToken?: string
  accountId?:   string
  isLoggedIn:   boolean
}

const sessionOptions = {
  password:   process.env.SESSION_SECRET as string,
  cookieName: 'lt_session',
  cookieOptions: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge:   60 * 60, // 1 hour — matches Deriv token expiry
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  return getIronSession<SessionData>(cookieStore, sessionOptions)
}
