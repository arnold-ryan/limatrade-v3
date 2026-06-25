import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import Sidebar from '@/components/dashboard/Sidebar'
import TopBar from '@/components/dashboard/TopBar'

export const metadata = { title: 'Dashboard — Lima Trade' }

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()
  if (!session.isLoggedIn) redirect('/?auth_error=session_expired')

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      <Sidebar />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        <TopBar />
        <main
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            minHeight: 0,
          }}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
