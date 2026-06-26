import Navbar          from '@/components/landing/Navbar'
import Ticker          from '@/components/landing/Ticker'
import Hero            from '@/components/landing/Hero'
import RiskDisclaimer  from '@/components/landing/RiskDisclaimer'

export default function HomePage() {
  return (
    <main>
      <Navbar />
      <Ticker />
      <Hero />
      <RiskDisclaimer />
    </main>
  )
}
