import Link from 'next/link';
import { BigHand } from '@/components/mascot';
import { Cta, Eyebrow, Headline, Lead, Section, StepCard } from '@/components/site';

const TELEGRAM = process.env.NEXT_PUBLIC_TELEGRAM_URL || '#try';
const IMESSAGE = process.env.NEXT_PUBLIC_IMESSAGE_URL || '#try';

const walls = ['Phone calls', 'Queues', 'In-person checks', 'Pickups'];

const steps = [
  { title: 'Text the agent', text: 'Say the errand in plain words. It tries to handle it first.' },
  { title: 'Approve the hire', text: 'If a person is needed, you see the best match and say yes.' },
  { title: 'Escrow holds the pay', text: 'Payment locks on chain and moves only if the work checks out.' },
  { title: 'Get the result', text: 'A verified human delivers. The answer lands in the same chat.' },
];

const trusted = [
  'Escrow with automatic refund',
  'Verified worker identity',
  'Pay released only after the result is checked',
  'Settles on Cardano or Solana',
];

export default function HomePage() {
  return (
    <>
      <Section id="hero" className="pt-14 md:pt-20">
        <div className="flex flex-col items-center gap-12 md:flex-row">
          <div className="flex-1">
            <Eyebrow>Human-as-a-Service</Eyebrow>
            <h1 className="font-display text-6xl font-bold leading-[1.05] tracking-tight">
              <span className="text-creamtext">Agents think.</span>
              <br />
              <span className="text-lav">We give them hands.</span>
            </h1>
            <Lead className="text-lg">
              When an AI agent hits something only a person can do, it texts us. We find a verified human,
              hold the payment in escrow, check the work, and send the result back.
            </Lead>
            <div className="mt-8 flex flex-wrap gap-3">
              <Cta href="#try">Try the agent</Cta>
              <Cta href="#how" ghost>
                See how it works
              </Cta>
            </div>
          </div>
          <div className="animate-in flex-shrink-0">
            <BigHand size={440} />
          </div>
        </div>
        <div className="mt-14 flex items-center justify-center gap-2.5 text-sm font-semibold text-lavmute">
          <span className="h-2.5 w-2.5 animate-breathe rounded-full bg-creamtext/80" />
          Scroll
        </div>
      </Section>

      <Section className="mt-28">
        <Eyebrow>The wall</Eyebrow>
        <Headline>
          The exit from the agent world
          <br />
          into the human world
        </Headline>
        <Lead>
          Every autonomous agent eventually hits a wall only a human can clear. A phone call. A queue. A
          look at the real thing.
        </Lead>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {walls.map((w) => (
            <StepCard key={w} title={w} />
          ))}
        </div>
      </Section>

      <Section id="how" className="mt-28">
        <Eyebrow>How it works</Eyebrow>
        <Headline>Text it. Approve it. Done.</Headline>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <StepCard key={s.title} n={i + 1} title={s.title}>
              {s.text}
            </StepCard>
          ))}
        </div>
      </Section>

      <Section id="router" className="mt-28">
        <div className="grid items-start gap-10 lg:grid-cols-2">
          <div>
            <Eyebrow>Open router</Eyebrow>
            <Headline>One request, the best person</Headline>
            <Lead>We search every freelancer source at once, instead of locking you into one platform.</Lead>
          </div>
          <div className="glass rounded-3xl p-8">
            <h3 className="font-display text-xl font-bold text-creamtext">Built to be trusted</h3>
            <ul className="mt-4 space-y-3 text-sm font-medium text-lavmute">
              {trusted.map((t) => (
                <li key={t} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-pinkish to-lav text-[11px] font-bold text-night"
                  >
                    ✓
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="try" className="mt-28">
        <div className="glass rounded-3xl p-10 text-center md:p-14">
          <Eyebrow>Ready?</Eyebrow>
          <Headline>Meet the hand</Headline>
          <Lead className="mx-auto">Ask for something a computer cannot do. Try it on Telegram or iMessage.</Lead>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Cta href={TELEGRAM}>Try the agent on Telegram</Cta>
            <Cta href={IMESSAGE} ghost>
              Text us on iMessage
            </Cta>
          </div>
          <p className="mt-6 text-sm font-medium text-lavmute">
            Want to earn from errands? Open the bot, send{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-creamtext">/start</code>, then{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-creamtext">/worker</code>.
          </p>
          <p className="mt-3 text-sm font-medium text-lavmute">
            Or{' '}
            <Link href="/dashboard/new" className="text-lav underline-offset-2 hover:underline">
              start a task in the browser
            </Link>{' '}
            and{' '}
            <Link href="/dashboard" className="text-lav underline-offset-2 hover:underline">
              watch the agent live
            </Link>
            .
          </p>
        </div>
      </Section>
    </>
  );
}
