import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import AppHeader from '@/components/dashboard/AppHeader'
import TabNav    from '@/components/dashboard/TabNav'
import AppFooter from '@/components/dashboard/AppFooter'

export const metadata = { title: 'Dashboard — Lima Trade' }

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()
  if (!session.isLoggedIn) redirect('/')

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        overflow: 'hidden',
        background: 'var(--bg0)',
        color: 'var(--txt0)',
      }}
    >
      <AppHeader />
      <TabNav />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {children}
      </main>

      <AppFooter />
    </div>
  )
}
