import { Chip, Cta, Eyebrow, Headline, Lead, Section } from '@/components/site';
import { Mascot } from '@/components/mascot';

const prompts = [
  'Get a logo designed for my crypto startup, under $100',
  'Find someone to hand out flyers at TOKEN2049 tomorrow',
  'Hire a translator for a day in Singapore',
  'Someone to wait for my furniture delivery on Friday',
  'Call five venues and get quotes for a 50-person dinner',
];

export default function TryPage() {
  return (
    <>
      <Section className="pt-16">
        <div className="flex flex-col items-center gap-10 rounded-3xl bg-blush p-10 md:flex-row md:p-14">
          <div className="flex-1">
            <Eyebrow>Try the agent</Eyebrow>
            <Headline>Meet the hand</Headline>
            <Lead>
              Give it an errand and watch it work: search, shortlist, escrow, booking — live, with you
              holding the veto at every step that spends money.
            </Lead>
            <div className="mt-7 flex flex-wrap gap-3">
              <Cta href="/dashboard/new">Start a task in the browser</Cta>
              <Cta href="/dashboard" ghost>
                Watch the agent live
              </Cta>
            </div>
          </div>
          <div className="animate-in">
            <Mascot size={200} />
          </div>
        </div>
      </Section>

      <Section className="mt-16">
        <h2 className="font-display text-xl font-bold">Not sure what to ask? Try one of these</h2>
        <div className="mt-5 flex flex-wrap gap-3">
          {prompts.map((p) => (
            <Chip key={p}>{p}</Chip>
          ))}
        </div>
      </Section>

      <Section className="mt-16">
        <div className="rounded-3xl bg-shell p-8 card-shadow md:p-10">
          <div className="grid items-center gap-8 md:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">Text it from your phone</h2>
              <p className="mt-3 text-sm font-medium leading-relaxed text-soft">
                The agent lives in your messages too. Text it a task and it texts back the shortlist;
                reply <b className="text-bright">HIRE 2</b> to book, <b className="text-bright">YES</b> to
                approve a payment, <b className="text-bright">STATUS</b> any time. Every notification —
                shortlists, escrow links, deliveries — lands as a message you can answer from a queue, a
                cab, or a conference floor.
              </p>
            </div>
            <div className="space-y-2 text-sm font-semibold">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-white">
                Get a logo designed for my crypto startup
              </p>
              <p className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-ink px-4 py-2.5">
                👥 2 candidates: 1. Mara (93) · $50 — logos for startups… Reply HIRE 1
              </p>
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-white">
                hire 1
              </p>
              <p className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-ink px-4 py-2.5">
                💰 Escrow funded. 🔔 Book Mara for $50 — YES or NO?
              </p>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
