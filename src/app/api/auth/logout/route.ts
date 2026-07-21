import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

/**
 * The client (AppHeader's logout button) calls this with POST and doesn't
 * redirect on the response — it just does router.push('/') regardless. GET is
 * kept too in case anything links to it directly, but POST is what's actually
 * used; previously only GET was exported here, so the client's POST call hit
 * a 405 and session.destroy() never ran — the session cookie silently
 * survived logout for its full 30-day lifetime.
 */
async function doLogout() {
  const session = await getSession()
  session.destroy()
}

export async function POST() {
  await doLogout()
  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  await doLogout()
  return NextResponse.redirect(new URL('/', req.url))
}
