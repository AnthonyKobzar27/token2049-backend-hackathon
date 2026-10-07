import Link from 'next/link';
import { Mascot } from '@/components/mascot';

const nav = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/history', label: 'History' },
  { href: '/dashboard/people', label: 'People' },
  { href: '/dashboard/tokens', label: 'Tokens' },
  { href: '/dashboard/new', label: 'New task' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ink text-bright">
      <header className="sticky top-0 z-10 bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <Mascot size={34} />
            <span className="font-display text-xl font-bold tracking-tight">HumanRouter</span>
          </Link>
          <nav className="flex gap-1 text-sm font-semibold text-soft">
            {nav.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-full px-3 py-1.5 hover:bg-panel hover:text-bright">
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="ml-auto hidden rounded-full bg-butter px-3 py-1 text-xs font-bold text-bright sm:inline">
            Built on Masumi
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
