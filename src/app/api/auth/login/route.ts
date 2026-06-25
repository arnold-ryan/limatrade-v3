import { NextRequest, NextResponse } from 'next/server'

// Placeholder — full OAuth implementation coming next step
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') ?? 'login'
  return NextResponse.json({
    message: `Auth (${mode}) route — will be wired up to Deriv OAuth next step.`,
  })
}
