import Link from 'next/link';

/** Building blocks for the light marketing pages in app/(site). */

export function Section({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`mx-auto max-w-6xl px-6 ${className}`}>{children}</section>;
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-xs font-bold uppercase tracking-widest text-accent">{children}</p>;
}

export function Headline({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`font-display text-4xl font-bold leading-tight tracking-tight ${className}`}>{children}</h2>;
}

export function Lead({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`mt-4 max-w-xl text-base font-medium text-soft ${className}`}>{children}</p>;
}

export function Cta({ href, children, ghost = false }: { href: string; children: React.ReactNode; ghost?: boolean }) {
  const style = ghost
    ? 'border-2 border-bright/15 text-bright hover:border-bright/40'
    : 'bg-bright text-white hover:brightness-125';
  return (
    <Link href={href} className={`inline-block rounded-full px-6 py-3 text-sm font-bold transition ${style}`}>
      {children}
    </Link>
  );
}

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-soft card-shadow">{children}</span>;
}

export function StepCard({ n, title, children }: { n?: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl bg-shell p-6 card-shadow">
      {n !== undefined && (
        <span className="mb-4 inline-flex h-8 w-8 items-center justify-center rounded-full bg-blush font-display text-sm font-bold">
          {n}
        </span>
      )}
      <h3 className="font-display text-lg font-bold">{title}</h3>
      <p className="mt-1.5 text-sm font-medium leading-relaxed text-soft">{children}</p>
    </div>
  );
}
