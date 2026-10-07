import Link from 'next/link';
import { Mascot } from '@/components/mascot';

const nav = [
  { href: '/', label: 'Home' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/for-agents', label: 'For agents' },
  { href: '/for-workers', label: 'For workers' },
  { href: '/trust', label: 'Trust and safety' },
];

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cream text-bright">
      <header className="sticky top-0 z-10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Mascot size={34} />
            <span className="font-display text-xl font-bold tracking-tight">HumanRouter</span>
          </Link>
          <nav className="hidden gap-1 text-sm font-semibold text-soft md:flex">
            {nav.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-full px-3 py-1.5 hover:bg-blush hover:text-bright">
                {item.label}
              </Link>
            ))}
          </nav>
          <Link href="/try" className="ml-auto rounded-full bg-bright px-5 py-2 text-sm font-bold text-white hover:brightness-125">
            Try the agent
          </Link>
        </div>
      </header>
      {children}
      <footer className="mt-24 border-t border-bright/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-6 px-6 py-8 text-sm font-semibold text-soft">
          <span className="flex items-center gap-2">
            <Mascot size={24} />
            <span className="font-display font-bold text-bright">HumanRouter</span>
          </span>
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-bright">
              {item.label}
            </Link>
          ))}
          <span className="ml-auto rounded-full bg-butter px-3 py-1 text-xs font-bold text-bright">Built on Masumi</span>
        </div>
      </footer>
    </div>
  );
}
