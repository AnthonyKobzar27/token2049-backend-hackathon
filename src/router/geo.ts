// Coarse place matching for on-site work. Unknown is never "elsewhere".

const COUNTRY_ALIASES: string[][] = [
  ['sg', 'singapore'],
  ['us', 'usa', 'united states', 'united states of america', 'america'],
  ['gb', 'uk', 'united kingdom', 'great britain', 'england'],
  ['de', 'germany', 'deutschland'],
  ['fr', 'france'],
  ['es', 'spain'],
  ['it', 'italy'],
  ['in', 'india'],
  ['pk', 'pakistan'],
  ['ph', 'philippines'],
  ['id', 'indonesia'],
  ['my', 'malaysia'],
  ['th', 'thailand'],
  ['vn', 'vietnam'],
  ['jp', 'japan'],
  ['kr', 'south korea', 'korea'],
  ['cn', 'china'],
  ['hk', 'hong kong'],
  ['au', 'australia'],
  ['ca', 'canada'],
  ['ae', 'uae', 'united arab emirates'],
  ['ch', 'switzerland'],
  ['br', 'brazil'],
  ['mx', 'mexico'],
  ['pl', 'poland'],
  ['ua', 'ukraine'],
  ['se', 'sweden'],
  ['nl', 'netherlands'],
  ['cz', 'czechia', 'czech republic'],
  ['gh', 'ghana'],
  ['ng', 'nigeria'],
  ['za', 'south africa'],
];

const CITY_COUNTRY: Record<string, string> = {
  london: 'gb',
  manchester: 'gb',
  'new york': 'us',
  'san francisco': 'us',
  'los angeles': 'us',
  berlin: 'de',
  munich: 'de',
  paris: 'fr',
  madrid: 'es',
  mumbai: 'in',
  bangalore: 'in',
  delhi: 'in',
  manila: 'ph',
  jakarta: 'id',
  'kuala lumpur': 'my',
  bangkok: 'th',
  tokyo: 'jp',
  sydney: 'au',
  toronto: 'ca',
  dubai: 'ae',
  zurich: 'ch',
};

const aliasKey = new Map<string, string>();
for (const group of COUNTRY_ALIASES) for (const a of group) aliasKey.set(a, group[0]!);

const norm = (s: string): string => s.toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
const canon = (s: string): string => aliasKey.get(s) ?? s;

export type PlaceMatch = 'match' | 'elsewhere' | 'unknown';

/** Compares the brief's free-text location with the profile's published country and city. */
export function matchPlace(briefLocation: string, profile: { country?: string; city?: string }): PlaceMatch {
  const tokens = norm(briefLocation)
    .split(/[,;/]| and /)
    .map((t) => t.trim())
    .filter(Boolean);
  const whole = norm(briefLocation);
  if (!tokens.includes(whole)) tokens.push(whole);
  const country = profile.country ? canon(norm(profile.country)) : undefined;
  const city = profile.city ? norm(profile.city) : undefined;

  const hit = (value: string, token: string): boolean => {
    if (canon(value) === canon(token)) return true;
    // Containment only for names long enough not to match inside other words.
    return value.length >= 4 && token.length >= 4 && (value.includes(token) || token.includes(value));
  };
  for (const t of tokens) {
    if (country && hit(country, t)) return 'match';
    if (city && hit(city, t)) return 'match';
  }
  // Also match the words inside a longer token ("marina bay singapore").
  const words = whole.split(/[\s,;/]+/).filter(Boolean);
  // Short codes ('in', 'us', 'it') only count as whole comma-separated tokens, never as loose words.
  const phrases = [...words, ...words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`)].filter((w) => w.length >= 4);
  for (const w of phrases) {
    if (country && aliasKey.has(w) && canon(w) === country) return 'match';
    if (city && w === city) return 'match';
  }

  const briefCountries = new Set<string>();
  for (const w of [...tokens, ...phrases]) {
    const k = aliasKey.get(w) ?? CITY_COUNTRY[w];
    if (k) briefCountries.add(k);
  }
  if (country && briefCountries.has(country)) return 'match';
  if (briefCountries.size > 0 && country && !briefCountries.has(country)) return 'elsewhere';
  return 'unknown';
}
