import type { Metadata } from 'next';
import Link from 'next/link';
import { Mascot } from '@/components/mascot';

export const metadata: Metadata = {
  title: 'HaaS · Agents think. We give them hands.',
  description: 'Human-as-a-Service: when an AI agent hits something only a person can do, it texts us.',
};

const nav = [
  { href: '/#how', label: 'How it works' },
  { href: '/#router', label: 'Router' },
  { href: '/#try', label: 'Try it' },
];

const footerNav = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/for-agents', label: 'For agents' },
  { href: '/for-workers', label: 'For workers' },
  { href: '/trust', label: 'Trust and safety' },
  { href: '/try', label: 'Try the agent' },
  { href: '/dashboard', label: 'Dashboard' },
];

/** Translucent spheres drifting behind everything, like the mock. */
const BUBBLES: { top: string; left: string; size: number; blur?: number; opacity: number; delay: number }[] = [
  { top: '4%', left: '12%', size: 56, opacity: 0.8, delay: 0 },
  { top: '10%', left: '30%', size: 110, opacity: 0.5, delay: 2, blur: 2 },
  { top: '3%', left: '68%', size: 150, blur: 4, opacity: 0.45, delay: 5 },
  { top: '18%', left: '88%', size: 90, opacity: 0.7, delay: 1 },
  { top: '30%', left: '4%', size: 40, opacity: 0.6, delay: 4 },
  { top: '38%', left: '46%', size: 70, blur: 1, opacity: 0.4, delay: 7 },
  { top: '46%', left: '93%', size: 120, blur: 5, opacity: 0.4, delay: 3 },
  { top: '58%', left: '10%', size: 130, blur: 3, opacity: 0.4, delay: 6 },
  { top: '64%', left: '55%', size: 48, opacity: 0.55, delay: 2 },
  { top: '74%', left: '80%', size: 160, blur: 2, opacity: 0.5, delay: 0 },
  { top: '84%', left: '28%', size: 90, blur: 1, opacity: 0.45, delay: 5 },
  { top: '90%', left: '64%', size: 60, opacity: 0.6, delay: 8 },
];

function Bubbles() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {BUBBLES.map((b, i) => (
        <span
          key={i}
          className="bubble"
          style={{
            top: b.top,
            left: b.left,
            width: b.size,
            height: b.size,
            opacity: b.opacity,
            filter: b.blur ? `blur(${b.blur}px)` : undefined,
            animationDelay: `${b.delay}s`,
            animationDuration: `${14 + (i % 5) * 3}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-night text-creamtext">
      <Bubbles />
      <header className="sticky top-4 z-20 px-4">
        <div className="glass mx-auto flex max-w-5xl items-center gap-6 rounded-full px-5 py-2.5 backdrop-blur-md">
          <Link href="/" className="flex items-center gap-2.5">
            <Mascot size={30} />
            <span className="font-display text-xl font-bold tracking-tight text-creamtext">HaaS</span>
          </Link>
          <nav className="mx-auto hidden gap-1 text-sm font-semibold text-lavmute md:flex">
            {nav.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-full px-3.5 py-1.5 hover:bg-white/10 hover:text-creamtext">
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/#try"
            className="ml-auto rounded-full bg-gradient-to-r from-pinkish to-creamtext px-5 py-2 text-sm font-bold text-night hover:brightness-105 md:ml-0"
          >
            Try the agent
          </Link>
        </div>
      </header>
      <div className="relative z-10">{children}</div>
      <footer className="relative z-10 mt-24 border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-8 text-sm font-semibold text-lavmute">
          <span className="flex items-center gap-2">
            <Mascot size={24} />
            <span className="font-display font-bold text-creamtext">HaaS, Human-as-a-Service.</span>
            <span className="hidden sm:inline">Built for the agent economy.</span>
          </span>
          <span className="ml-auto flex flex-wrap gap-x-5 gap-y-2">
            {footerNav.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-creamtext">
                {item.label}
              </Link>
            ))}
          </span>
        </div>
      </footer>
    </div>
  );
}
