import Link from 'next/link';

/** Building blocks for the dark HaaS marketing pages in app/(site). */

export function Section({ children, className = '', id }: { children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`mx-auto max-w-6xl scroll-mt-28 px-6 ${className}`}>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 inline-block rounded-full bg-lav px-3.5 py-1 text-xs font-bold text-night">{children}</p>
  );
}

export function Headline({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={`font-display text-4xl font-bold leading-tight tracking-tight text-creamtext ${className}`}>
      {children}
    </h2>
  );
}

export function Lead({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`mt-4 max-w-xl text-base font-medium text-lavmute ${className}`}>{children}</p>;
}

export function Cta({ href, children, ghost = false }: { href: string; children: React.ReactNode; ghost?: boolean }) {
  const style = ghost
    ? 'border border-white/20 bg-white/5 text-creamtext hover:border-white/45'
    : 'bg-gradient-to-r from-pinkish to-creamtext text-night hover:brightness-105';
  return (
    <Link href={href} className={`inline-block rounded-full px-6 py-3 text-sm font-bold transition ${style}`}>
      {children}
    </Link>
  );
}

export function Chip({ children }: { children: React.ReactNode }) {
  return <span className="glass rounded-full px-4 py-1.5 text-sm font-semibold text-lavmute">{children}</span>;
}

export function StepCard({ n, title, children }: { n?: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="glass rounded-3xl p-6">
      {n !== undefined && (
        <span className="mb-4 inline-flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-pinkish to-lav font-display text-sm font-bold text-night">
          {n}
        </span>
      )}
      <h3 className="font-display text-lg font-bold text-creamtext">{title}</h3>
      {children && <p className="mt-1.5 text-sm font-medium leading-relaxed text-lavmute">{children}</p>}
    </div>
  );
}
