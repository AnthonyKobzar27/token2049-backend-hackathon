// Fixture source for demos and tests: varied profiles, deliberately incomplete in places.

import type { FreelancerSource } from '../domain/ports';
import type { Availability, FreelancerProfile, Pricing } from '../domain/types';

const FETCHED_AT = 1_760_000_000_000;

type Extra = Partial<Omit<FreelancerProfile, 'id' | 'platform' | 'platformId' | 'url' | 'name' | 'headline' | 'skills' | 'pricing' | 'fetchedAt'>>;

function p(platformId: string, name: string, headline: string, skills: string[], pricing: Pricing[], extra: Extra = {}): FreelancerProfile {
  return { id: `fake:${platformId}`, platform: 'fake', platformId, url: `https://fixtures.haas.test/${platformId}`, name, headline, skills, pricing, fetchedAt: FETCHED_AT, ...extra };
}
const fixed = (amountUsd: number, deliveryDays?: number, label?: string, revisions?: number | 'unlimited'): Pricing => ({ kind: 'fixed', amountUsd, ...(deliveryDays !== undefined && { deliveryDays }), ...(label && { label }), ...(revisions !== undefined && { revisions }) });
const hourly = (amountUsd: number, original?: Pricing['original']): Pricing => ({ kind: 'hourly', amountUsd, ...(original && { original }) });
const av = (a: Availability): Availability => a;

export const fixtures: FreelancerProfile[] = [
  p('logo-mara', 'Mara Lindqvist', 'Brand identity and logo design for startups', ['logo design', 'branding', 'illustrator', 'vector'], [fixed(50, 3, 'Basic', 2), fixed(120, 5, 'Standard', 5), fixed(250, 7, 'Premium', 'unlimited')], { category: 'design', country: 'SE', city: 'Malmo', timezone: 'Europe/Stockholm', languages: ['en', 'sv'], availability: av({ online: true, responseHours: 2 }), rating: 4.9, reviewCount: 412, level: 'Top Rated', verified: true }),
  p('react-arjun', 'Arjun Mehta', 'Senior React and TypeScript developer', ['react', 'typescript', 'next.js', 'frontend', 'web development'], [hourly(28, { amount: 2330, currency: 'INR' })], { category: 'programming', country: 'IN', city: 'Pune', timezone: 'Asia/Kolkata', languages: ['en', 'hi'], availability: av({ online: true, responseHours: 1, hoursPerWeek: 30 }), rating: 4.8, reviewCount: 156, level: 'Level 2' }),
  p('react-krakow', 'Dev Studio Krakow', 'React dashboards and admin panels, fixed price', ['react', 'dashboard', 'data visualization', 'typescript', 'frontend'], [fixed(180, 3, 'Dashboard', 2), fixed(520, 8, 'Dashboard plus API', 3)], { category: 'programming', country: 'PL', city: 'Krakow', timezone: 'Europe/Warsaw', languages: ['en', 'pl'], availability: av({ responseHours: 1 }), rating: 4.9, reviewCount: 312, level: 'Top Rated Plus', verified: true }),
  p('copy-chloe', 'Chloe Bennett', 'Conversion copywriter for SaaS landing pages', ['copywriting', 'landing page', 'saas', 'email copy', 'content'], [hourly(55)], { category: 'writing', country: 'GB', city: 'Bristol', timezone: 'Europe/London', languages: ['en'], rating: 5.0, reviewCount: 3 }),
  p('trans-lucia', 'Lucia Fernandez', 'Spanish and English translator, marketing and tech', ['translation', 'spanish', 'english', 'localization', 'proofreading'], [fixed(90, 2, '1000 words')], { category: 'translation', country: 'ES', city: 'Valencia', timezone: 'Europe/Madrid', languages: ['es', 'en'], availability: av({ online: false, responseHours: 6 }), rating: 4.7, reviewCount: 88 }),
  p('trans-kenji', 'Kenji Watanabe', 'Japanese to English translation and interpreting', ['translation', 'japanese', 'english', 'interpreting', 'localization'], [hourly(40, { amount: 6000, currency: 'JPY' })], { category: 'translation', country: 'JP', city: 'Tokyo', timezone: 'Asia/Tokyo', languages: ['ja', 'en'], availability: av({ responseHours: 8, hoursPerWeek: 15 }), rating: 4.95, reviewCount: 41 }),
  p('video-tomas', 'Tomas Rojas', 'YouTube and social video editor, fast turnaround', ['video editing', 'premiere pro', 'after effects', 'youtube', 'motion graphics'], [fixed(150, 4, 'Up to 5 min', 2), fixed(300, 7, 'Up to 12 min', 3)], { category: 'video', country: 'MX', city: 'Guadalajara', timezone: 'America/Mexico_City', languages: ['es', 'en'], availability: av({ online: true, responseHours: 3 }), rating: 4.6, reviewCount: 230, level: 'Level 2' }),
  p('video-aiko', 'Aiko Tan', 'Video editor and subtitler based in Singapore', ['video editing', 'final cut', 'subtitles', 'color grading'], [hourly(35)], { category: 'video', country: 'SG', city: 'Singapore', timezone: 'Asia/Singapore', languages: ['en', 'zh'], availability: av({ hoursPerWeek: 20 }) }),
  p('books-priya', 'Priya Nair', 'Bookkeeper for small businesses, Xero and QuickBooks', ['bookkeeping', 'xero', 'quickbooks', 'accounting', 'invoicing'], [hourly(18, { amount: 1500, currency: 'INR' })], { category: 'finance', country: 'IN', city: 'Kochi', timezone: 'Asia/Kolkata', languages: ['en', 'ml', 'hi'], availability: av({ online: true, responseHours: 5, hoursPerWeek: 20 }), rating: 4.8, reviewCount: 95 }),
  p('books-daniel', 'Daniel Ortiz', 'CPA: US bookkeeping, tax prep and cleanup', ['bookkeeping', 'accounting', 'tax', 'quickbooks', 'cpa'], [hourly(85)], { category: 'finance', country: 'US', city: 'Austin', timezone: 'America/Chicago', languages: ['en', 'es'], availability: av({ responseHours: 24, hoursPerWeek: 10 }), rating: 4.9, reviewCount: 60, level: 'Top Rated', verified: true }),
  p('vo-hannah', 'Hannah Weiss', 'German voice-over, warm and clear, studio quality', ['voice-over', 'german', 'narration', 'audio', 'explainer video'], [fixed(120, 2, 'Up to 60 seconds', 1)], { category: 'audio', country: 'DE', city: 'Hamburg', timezone: 'Europe/Berlin', languages: ['de', 'en'], availability: av({ online: true, responseHours: 2 }), rating: 4.9, reviewCount: 187, level: 'Top Rated' }),
  p('vo-marcus', 'Marcus Hill', 'American male voice-over for ads and e-learning', ['voice-over', 'english', 'commercial', 'e-learning', 'audio'], [fixed(200, 3, 'Up to 90 seconds', 2)], { category: 'audio', country: 'US', city: 'Denver', timezone: 'America/Denver', languages: ['en'], rating: 4.5, reviewCount: 12 }),
  p('label-collective', 'Labelers Collective', 'Managed team for image and text data labelling', ['data labeling', 'annotation', 'image classification', 'bounding boxes', 'data entry'], [hourly(6, { amount: 340, currency: 'PHP' })], { category: 'data', country: 'PH', city: 'Cebu', timezone: 'Asia/Manila', languages: ['en', 'tl'], availability: av({ online: true, responseHours: 2, hoursPerWeek: 40 }), rating: 4.4, reviewCount: 540 }),
  p('label-anh', 'Nguyen Anh', 'Data annotation and transcription, Vietnamese and English', ['data labeling', 'transcription', 'vietnamese', 'annotation'], [], { category: 'data', country: 'VN', languages: ['vi', 'en'] }),
  p('errand-weijie', 'Wei Jie Tan', 'On-site helper in Singapore: errands, pickups, queueing, event staffing', ['errands', 'on-site', 'pickup', 'event staffing', 'queueing', 'singapore'], [hourly(22, { amount: 30, currency: 'SGD' })], { category: 'errands', country: 'SG', city: 'Singapore', timezone: 'Asia/Singapore', languages: ['en', 'zh'], availability: av({ online: true, responseHours: 0.5, hoursPerWeek: 25 }), rating: 4.8, reviewCount: 64 }),
  p('errand-siti', 'Siti Rahmah', 'Same-day delivery and document runs across Singapore', ['errands', 'delivery', 'document courier', 'on-site', 'singapore'], [fixed(30, 1, 'Single run')], { category: 'errands', country: 'SG', city: 'Singapore', timezone: 'Asia/Singapore', languages: ['en', 'ms'], availability: av({ responseHours: 1 }), rating: 4.9, reviewCount: 210 }),
  p('errand-somchai', 'Somchai Prasert', 'Errands and on-site assistance in Bangkok', ['errands', 'on-site', 'translation', 'thai', 'bangkok'], [hourly(12)], { category: 'errands', country: 'TH', city: 'Bangkok', timezone: 'Asia/Bangkok', languages: ['th', 'en'], availability: av({ online: true }), rating: 4.6, reviewCount: 19 }),
  p('photo-olivia', 'Olivia Grant', 'Event and conference photographer in London', ['photography', 'event photography', 'on-site', 'editing', 'conference'], [fixed(400, 5, 'Half day plus edits', 1)], { category: 'photo', country: 'GB', city: 'London', timezone: 'Europe/London', languages: ['en'], availability: av({ responseHours: 12 }), rating: 4.9, reviewCount: 77 }),
  p('py-ivan', 'Ivan Petrov', 'Python developer: scrapers, data pipelines, automation', ['python', 'web scraping', 'automation', 'pandas', 'data engineering'], [hourly(32)], { category: 'programming', country: 'UA', city: 'Lviv', timezone: 'Europe/Kyiv', languages: ['en', 'uk', 'ru'], availability: av({ online: true, responseHours: 2, hoursPerWeek: 35 }), rating: 4.7, reviewCount: 140, level: 'Level 2' }),
  p('sol-chen', 'Chen Hao', 'Solidity and Rust smart contract engineer, audits', ['solidity', 'smart contracts', 'ethereum', 'rust', 'security audit', 'web3'], [hourly(90)], { category: 'blockchain', country: 'SG', city: 'Singapore', timezone: 'Asia/Singapore', languages: ['en', 'zh'], availability: av({ responseHours: 6, hoursPerWeek: 15 }), rating: 4.9, reviewCount: 33, verified: true }),
  p('ux-sofia', 'Sofia Rossi', 'UX/UI designer: Figma prototypes and design systems', ['ux design', 'ui design', 'figma', 'prototyping', 'design system'], [fixed(350, 10, 'Landing plus 3 screens', 3), hourly(45)], { category: 'design', country: 'IT', city: 'Milan', timezone: 'Europe/Rome', languages: ['it', 'en'], availability: av({ online: true, responseHours: 4 }), rating: 4.8, reviewCount: 102, level: 'Level 2' }),
  p('seo-kwame', 'Kwame Mensah', 'SEO blog writer, 1000-word articles', ['seo', 'copywriting', 'blog writing', 'content marketing'], [fixed(60, 2, '1000-word article', 1)], { category: 'writing', country: 'GH', timezone: 'Africa/Accra', languages: ['en'], availability: av({ responseHours: 10 }), rating: 4.3, reviewCount: 28 }),
  p('va-maria', 'Maria Santos', 'Virtual assistant: inbox, calendar, research, data entry', ['virtual assistant', 'data entry', 'research', 'email management', 'scheduling'], [hourly(9)], { category: 'admin', country: 'PH', city: 'Manila', timezone: 'Asia/Manila', languages: ['en', 'tl'], availability: av({ online: true, responseHours: 1, hoursPerWeek: 40 }), rating: 4.8, reviewCount: 320, level: 'Top Rated' }),
  p('flutter-rahul', 'Rahul Verma', 'Flutter mobile developer, iOS and Android', ['flutter', 'dart', 'mobile app', 'ios', 'android', 'firebase'], [fixed(900, 21, 'MVP app'), hourly(25)], { category: 'programming', country: 'IN', city: 'Bengaluru', timezone: 'Asia/Kolkata', languages: ['en', 'hi', 'kn'], availability: av({ responseHours: 5, hoursPerWeek: 30 }), rating: 4.6, reviewCount: 77 }),
  p('blender-lukas', 'Lukas Novak', '3D product animation in Blender', ['3d animation', 'blender', 'product visualization', 'rendering'], [fixed(500, 14, '15 second animation', 2)], { category: 'animation', country: 'CZ', city: 'Brno', timezone: 'Europe/Prague', languages: ['cs', 'en'], rating: 4.9 }),
  p('legal-camille', 'Camille Dubois', 'French legal translator, contracts and filings', ['translation', 'french', 'legal translation', 'english', 'contracts'], [hourly(60)], { category: 'translation', country: 'FR', city: 'Lyon', timezone: 'Europe/Paris', languages: ['fr', 'en'], availability: av({ responseHours: 3, hoursPerWeek: 12 }), rating: 4.9, reviewCount: 19 }),
  p('pod-jordan', 'Jordan Lee', 'Podcast editor: cleanup, mixing, show notes', ['podcast editing', 'audio editing', 'mixing', 'show notes'], [fixed(80, 2, 'Per episode', 1), hourly(30)], { category: 'audio', country: 'CA', city: 'Vancouver', timezone: 'America/Vancouver', languages: ['en'], availability: av({ online: true, responseHours: 3 }), rating: 4.8, reviewCount: 140 }),
];

const STOP = new Set(['the', 'and', 'for', 'with', 'need', 'needs', 'want', 'who', 'that', 'this', 'can', 'will', 'from', 'about', 'some', 'our', 'your', 'you', 'are', 'someone', 'looking', 'hire', 'work', 'job']);

export function createFakeSource(): FreelancerSource {
  return {
    name: 'fake',
    platform: 'fake',
    kind: 'fixture',
    isEnabled: () => true,
    async search(brief, opts) {
      const words = [...new Set(`${brief.task} ${brief.skills.join(' ')}`.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
      if (words.length === 0) return fixtures.slice(0, opts.limit);
      return fixtures
        .map((f) => {
          const hay = `${f.skills.join(' ')} ${f.headline} ${f.category ?? ''}`.toLowerCase();
          return { f, hits: words.filter((w) => hay.includes(w)).length };
        })
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, opts.limit)
        .map((x) => x.f);
    },
  };
}
