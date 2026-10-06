// Suitability without a language model: TF-IDF over each profile's title, skills, category and
// bio, with the brief's terms expanded through a small synonym and category map. Deterministic,
// fast (well under a millisecond per profile) and good enough to rank a demo shortlist.

import type { Brief, FreelancerProfile, SuitabilityScore } from '../domain/types';

const STOP = new Set(
  'the and for with need needs want who that this can will has have from into about some our your you are any per job work someone looking hire help get make done please would like also just very more than then them they their there what when where which while within without across around after before over under onto upon near'.split(' '),
);

/** Crude English stemmer: enough to join design/designer/designing and translate/translation/translator. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 4) return w;
  // -ation/-ator keep "at" so translation, translator and translate all meet at "translat".
  const at = /(ations?|ators?)$/.exec(w);
  if (at && w.length - at[0].length >= 4) return `${w.slice(0, -at[0].length)}at`;
  for (const suffix of ['ings', 'ing', 'ers', 'er', 'ies', 'ied', 'ed', 'es', 's']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  // translat(e), creat(e), automat(e): drop a trailing e so the verb meets its nouns.
  if (w.length > 5 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}+#]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    if (raw.length < 3 && !/^(ui|ux|3d|2d|ai|ml|qa|go|c#|r)$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

// Groups of words that mean the same kind of work. Matching any member counts, at a discount.
const SYNONYM_GROUPS: string[][] = [
  ['logo', 'brand', 'branding', 'identity', 'illustrator', 'vector'],
  ['design', 'designer', 'graphic', 'figma', 'ui', 'ux', 'prototyping'],
  ['video', 'editing', 'premiere', 'final cut', 'after effects', 'youtube', 'footage', 'reel'],
  ['subtitle', 'caption', 'transcription', 'subtitles'],
  ['animation', 'motion', 'blender', '3d', 'render', 'rendering'],
  ['photo', 'photography', 'photographer', 'shoot', 'headshot', 'camera'],
  ['translation', 'translate', 'translator', 'localization', 'interpreting', 'interpreter'],
  ['copywriting', 'copy', 'writer', 'writing', 'content', 'blog', 'article', 'seo'],
  ['voice', 'voice-over', 'voiceover', 'narration', 'narrator', 'audio'],
  ['podcast', 'audio', 'mixing', 'sound'],
  ['bookkeeping', 'accounting', 'accountant', 'xero', 'quickbooks', 'invoice', 'invoicing', 'tax', 'cpa'],
  ['react', 'frontend', 'front-end', 'next.js', 'javascript', 'typescript', 'web'],
  ['website', 'web', 'wordpress', 'landing', 'frontend', 'html', 'css'],
  ['backend', 'api', 'node', 'database', 'server'],
  ['python', 'scraping', 'scraper', 'automation', 'pandas', 'script'],
  ['data', 'pipeline', 'etl', 'analytics', 'analysis', 'dashboard'],
  ['mobile', 'app', 'ios', 'android', 'flutter', 'swift', 'kotlin', 'react native'],
  ['smart contract', 'solidity', 'ethereum', 'web3', 'blockchain', 'rust', 'audit', 'crypto', 'defi', 'cardano', 'solana'],
  ['labeling', 'labelling', 'annotation', 'annotate', 'tagging', 'classification', 'bounding'],
  ['data entry', 'virtual assistant', 'assistant', 'admin', 'research', 'scheduling', 'inbox', 'email'],
  ['errand', 'errands', 'pickup', 'pick up', 'collect', 'delivery', 'deliver', 'courier', 'run', 'queue', 'queueing', 'on-site', 'onsite', 'in person', 'helper'],
  ['event', 'staffing', 'booth', 'conference', 'usher', 'promoter', 'hostess'],
  ['moving', 'mover', 'furniture', 'assembly', 'handyman', 'repair', 'install'],
  ['cleaning', 'cleaner', 'housekeeping'],
  ['tutor', 'tutoring', 'teacher', 'lesson', 'coaching'],
];

// Coarse category per term, to give a small boost when the profile's category agrees.
const CATEGORY_HINTS: Record<string, string[]> = {
  design: ['logo', 'brand', 'design', 'figma', 'ui', 'ux', 'graphic', 'illustrat'],
  programming: ['react', 'python', 'develop', 'code', 'typescript', 'javascript', 'app', 'website', 'api', 'flutter', 'backend', 'frontend'],
  writing: ['copywrit', 'writ', 'blog', 'article', 'content', 'seo'],
  translation: ['translat', 'locali', 'interpret'],
  video: ['video', 'edit', 'youtube', 'subtitl', 'reel'],
  audio: ['voice', 'podcast', 'audio', 'narrat'],
  finance: ['bookkeep', 'account', 'tax', 'invoic', 'xero', 'quickbook'],
  data: ['label', 'annotat', 'transcri', 'data entry'],
  errands: ['errand', 'pickup', 'deliver', 'courier', 'queue', 'on-site', 'onsite', 'event staff'],
  photo: ['photo'],
  blockchain: ['solidity', 'smart contract', 'web3', 'blockchain', 'ethereum'],
  admin: ['assistant', 'admin', 'data entry', 'scheduling'],
  animation: ['animat', 'blender', '3d'],
};

const synonymIndex = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const stems = group.flatMap((g) => terms(g));
  for (const s of stems) {
    let set = synonymIndex.get(s);
    if (!set) synonymIndex.set(s, (set = new Set()));
    for (const o of stems) if (o !== s) set.add(o);
  }
}

/** Synonym stems for one stem (not including itself). */
export const synonymsOf = (s: string): string[] => [...(synonymIndex.get(s) ?? [])];

export function inferCategory(text: string): string | undefined {
  const t = text.toLowerCase();
  let best: string | undefined;
  let hits = 0;
  for (const [cat, hints] of Object.entries(CATEGORY_HINTS)) {
    const n = hints.filter((h) => t.includes(h)).length;
    if (n > hits) {
      best = cat;
      hits = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------- corpus

interface Doc {
  /** Stem -> weighted term frequency. Skills count most, then the title, then the bio. */
  tf: Map<string, number>;
  /** Multi-word skills as phrases, for exact phrase hits like "logo design". */
  phrases: Set<string>;
}

function docOf(p: FreelancerProfile): Doc {
  const tf = new Map<string, number>();
  const add = (text: string | undefined, w: number): void => {
    for (const t of terms(text ?? '')) tf.set(t, (tf.get(t) ?? 0) + w);
  };
  add(p.skills.join(' '), 3);
  add(p.headline, 2);
  add(p.category, 2);
  add(p.description?.slice(0, 2000), 1);
  return { tf, phrases: new Set(p.skills.map((s) => s.toLowerCase().trim())) };
}

interface QueryTerm {
  stem: string;
  /** How much the brief cares: skills > task words. */
  weight: number;
  /** Shown in the reason. */
  label: string;
}

function queryOf(brief: Brief): QueryTerm[] {
  const q = new Map<string, QueryTerm>();
  const put = (text: string, weight: number): void => {
    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}+#-]+/u)) {
      const [t] = terms(raw);
      if (!t) continue;
      const cur = q.get(t);
      if (!cur || cur.weight < weight) q.set(t, { stem: t, weight, label: cur?.label ?? raw });
    }
  };
  put(brief.task, 1);
  put(brief.skills.join(' '), 2);
  return [...q.values()];
}

/** A soft hit on a term: 1 for the word itself (saturating with frequency), 0.6 via a synonym. */
function termHit(doc: Doc, stem: string): { hit: number; via?: string } {
  const f = doc.tf.get(stem);
  if (f) return { hit: Math.min(1, 0.6 + 0.15 * f) };
  for (const s of synonymsOf(stem)) if (doc.tf.has(s)) return { hit: 0.5, via: s };
  return { hit: 0 };
}

/**
 * Scores every profile in one pass, so IDF reflects the set being ranked: a word every candidate
 * has (e.g. "english") counts little, a rare one that matches counts a lot.
 */
export function relevanceScores(brief: Brief, profiles: FreelancerProfile[]): Map<string, SuitabilityScore> {
  const out = new Map<string, SuitabilityScore>();
  const query = queryOf(brief);
  if (query.length === 0) {
    for (const p of profiles) out.set(p.id, { score: 0, reason: 'brief has no searchable terms' });
    return out;
  }
  const docs = profiles.map(docOf);
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const t of query) {
    const df = docs.filter((d) => termHit(d, t.stem).hit > 0).length;
    // Smoothed IDF; terms nobody has still count a little in the denominator so a profile
    // matching one word of a long brief is not called a perfect fit.
    idf.set(t.stem, df === 0 ? 0.3 : 1 + Math.log((n + 1) / (df + 0.5)));
  }
  const total = query.reduce((s, t) => s + t.weight * idf.get(t.stem)!, 0);
  const briefCat = inferCategory(`${brief.task} ${brief.skills.join(' ')}`);
  const skillPhrases = brief.skills.map((s) => s.toLowerCase().trim()).filter((s) => s.includes(' '));

  profiles.forEach((p, i) => {
    const doc = docs[i]!;
    let got = 0;
    const matched: string[] = [];
    const related: string[] = [];
    for (const t of query) {
      const { hit, via } = termHit(doc, t.stem);
      if (hit === 0) continue;
      got += hit * t.weight * idf.get(t.stem)!;
      if (via) related.push(t.label);
      else matched.push(t.label);
    }
    let score = total > 0 ? Math.min(1, (got / total) * 1.25) : 0;
    if (skillPhrases.some((ph) => doc.phrases.has(ph))) score = Math.min(1, score + 0.1);
    const cat = p.category?.toLowerCase();
    if (score > 0 && briefCat && cat && (cat === briefCat || inferCategory(cat) === briefCat)) score = Math.min(1, score + 0.1);
    score = Math.round(score * 100) / 100;

    let reason: string;
    if (matched.length > 0) reason = `matches ${[...new Set(matched)].slice(0, 3).join(', ')}`;
    else if (related.length > 0) reason = `related to ${[...new Set(related)].slice(0, 3).join(', ')}`;
    else reason = 'little overlap with the brief';
    out.set(p.id, { score, reason });
  });
  return out;
}
