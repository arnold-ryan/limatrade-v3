import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Lima Trade — Trade Smarter, Not Harder',
  description: 'Access free premium trading bots, real-time market analysis, and copy top performers — all powered by Deriv.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Lima Trade',
    description: 'Trade smarter, not harder.',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Flash-prevention: apply saved theme before first paint */}
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('lima-theme');
            if (t === 'light') document.documentElement.classList.add('light');
          } catch(e) {}
        ` }} />
      </head>
      <body className={inter.className}>
        {children}
      </body>
    </html>
  )
}
