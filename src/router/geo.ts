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
  ['tw', 'taiwan'],
  ['pt', 'portugal'],
  ['tr', 'turkey', 'turkiye'],
  ['ke', 'kenya'],
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
    const k = aliasKey.get(w) ?? CITY_COUNTRY[w] ?? CITIES[w]?.[2];
    if (k) briefCountries.add(k);
  }
  if (country && briefCountries.has(country)) return 'match';
  if (briefCountries.size > 0 && country && !briefCountries.has(country)) return 'elsewhere';
  return 'unknown';
}

// ------------------------------------------------------------ coordinates
// A small gazetteer: likely demo cities (Singapore and the region first) plus country centroids.
// Each entry: [lat, lng, country code, IANA zone].

type Coord = [number, number, string, string];

const CITIES: Record<string, Coord> = {
  // Singapore and its districts (on-site demo tasks)
  singapore: [1.3521, 103.8198, 'sg', 'Asia/Singapore'],
  'marina bay': [1.2834, 103.8607, 'sg', 'Asia/Singapore'],
  'raffles place': [1.284, 103.8514, 'sg', 'Asia/Singapore'],
  orchard: [1.3048, 103.8318, 'sg', 'Asia/Singapore'],
  sentosa: [1.2494, 103.8303, 'sg', 'Asia/Singapore'],
  jurong: [1.3329, 103.7436, 'sg', 'Asia/Singapore'],
  changi: [1.3644, 103.9915, 'sg', 'Asia/Singapore'],
  tampines: [1.3496, 103.9568, 'sg', 'Asia/Singapore'],
  woodlands: [1.4382, 103.789, 'sg', 'Asia/Singapore'],
  bugis: [1.3008, 103.8559, 'sg', 'Asia/Singapore'],
  chinatown: [1.2836, 103.8443, 'sg', 'Asia/Singapore'],
  'johor bahru': [1.4927, 103.7414, 'my', 'Asia/Kuala_Lumpur'],
  'kuala lumpur': [3.139, 101.6869, 'my', 'Asia/Kuala_Lumpur'],
  penang: [5.4164, 100.3327, 'my', 'Asia/Kuala_Lumpur'],
  batam: [1.0456, 104.0305, 'id', 'Asia/Jakarta'],
  jakarta: [-6.2088, 106.8456, 'id', 'Asia/Jakarta'],
  bali: [-8.4095, 115.1889, 'id', 'Asia/Makassar'],
  bangkok: [13.7563, 100.5018, 'th', 'Asia/Bangkok'],
  manila: [14.5995, 120.9842, 'ph', 'Asia/Manila'],
  'quezon city': [14.676, 121.0437, 'ph', 'Asia/Manila'],
  cebu: [10.3157, 123.8854, 'ph', 'Asia/Manila'],
  'ho chi minh city': [10.8231, 106.6297, 'vn', 'Asia/Ho_Chi_Minh'],
  hanoi: [21.0278, 105.8342, 'vn', 'Asia/Ho_Chi_Minh'],
  'hong kong': [22.3193, 114.1694, 'hk', 'Asia/Hong_Kong'],
  taipei: [25.033, 121.5654, 'tw', 'Asia/Taipei'],
  shenzhen: [22.5431, 114.0579, 'cn', 'Asia/Shanghai'],
  shanghai: [31.2304, 121.4737, 'cn', 'Asia/Shanghai'],
  beijing: [39.9042, 116.4074, 'cn', 'Asia/Shanghai'],
  tokyo: [35.6762, 139.6503, 'jp', 'Asia/Tokyo'],
  seoul: [37.5665, 126.978, 'kr', 'Asia/Seoul'],
  mumbai: [19.076, 72.8777, 'in', 'Asia/Kolkata'],
  bangalore: [12.9716, 77.5946, 'in', 'Asia/Kolkata'],
  bengaluru: [12.9716, 77.5946, 'in', 'Asia/Kolkata'],
  delhi: [28.7041, 77.1025, 'in', 'Asia/Kolkata'],
  pune: [18.5204, 73.8567, 'in', 'Asia/Kolkata'],
  kochi: [9.9312, 76.2673, 'in', 'Asia/Kolkata'],
  chennai: [13.0827, 80.2707, 'in', 'Asia/Kolkata'],
  hyderabad: [17.385, 78.4867, 'in', 'Asia/Kolkata'],
  dubai: [25.2048, 55.2708, 'ae', 'Asia/Dubai'],
  istanbul: [41.0082, 28.9784, 'tr', 'Europe/Istanbul'],
  london: [51.5074, -0.1278, 'gb', 'Europe/London'],
  bristol: [51.4545, -2.5879, 'gb', 'Europe/London'],
  manchester: [53.4808, -2.2426, 'gb', 'Europe/London'],
  berlin: [52.52, 13.405, 'de', 'Europe/Berlin'],
  hamburg: [53.5511, 9.9937, 'de', 'Europe/Berlin'],
  munich: [48.1351, 11.582, 'de', 'Europe/Berlin'],
  paris: [48.8566, 2.3522, 'fr', 'Europe/Paris'],
  lyon: [45.764, 4.8357, 'fr', 'Europe/Paris'],
  madrid: [40.4168, -3.7038, 'es', 'Europe/Madrid'],
  valencia: [39.4699, -0.3763, 'es', 'Europe/Madrid'],
  lisbon: [38.7223, -9.1393, 'pt', 'Europe/Lisbon'],
  milan: [45.4642, 9.19, 'it', 'Europe/Rome'],
  rome: [41.9028, 12.4964, 'it', 'Europe/Rome'],
  zurich: [47.3769, 8.5417, 'ch', 'Europe/Zurich'],
  amsterdam: [52.3676, 4.9041, 'nl', 'Europe/Amsterdam'],
  warsaw: [52.2297, 21.0122, 'pl', 'Europe/Warsaw'],
  krakow: [50.0647, 19.945, 'pl', 'Europe/Warsaw'],
  prague: [50.0755, 14.4378, 'cz', 'Europe/Prague'],
  brno: [49.1951, 16.6068, 'cz', 'Europe/Prague'],
  stockholm: [59.3293, 18.0686, 'se', 'Europe/Stockholm'],
  malmo: [55.605, 13.0038, 'se', 'Europe/Stockholm'],
  kyiv: [50.4501, 30.5234, 'ua', 'Europe/Kyiv'],
  lviv: [49.8397, 24.0297, 'ua', 'Europe/Kyiv'],
  'new york': [40.7128, -74.006, 'us', 'America/New_York'],
  'san francisco': [37.7749, -122.4194, 'us', 'America/Los_Angeles'],
  'los angeles': [34.0522, -118.2437, 'us', 'America/Los_Angeles'],
  austin: [30.2672, -97.7431, 'us', 'America/Chicago'],
  chicago: [41.8781, -87.6298, 'us', 'America/Chicago'],
  denver: [39.7392, -104.9903, 'us', 'America/Denver'],
  toronto: [43.6532, -79.3832, 'ca', 'America/Toronto'],
  vancouver: [49.2827, -123.1207, 'ca', 'America/Vancouver'],
  'mexico city': [19.4326, -99.1332, 'mx', 'America/Mexico_City'],
  guadalajara: [20.6597, -103.3496, 'mx', 'America/Mexico_City'],
  'sao paulo': [-23.5505, -46.6333, 'br', 'America/Sao_Paulo'],
  sydney: [-33.8688, 151.2093, 'au', 'Australia/Sydney'],
  melbourne: [-37.8136, 144.9631, 'au', 'Australia/Melbourne'],
  accra: [5.6037, -0.187, 'gh', 'Africa/Accra'],
  lagos: [6.5244, 3.3792, 'ng', 'Africa/Lagos'],
  nairobi: [-1.2921, 36.8219, 'ke', 'Africa/Nairobi'],
  'cape town': [-33.9249, 18.4241, 'za', 'Africa/Johannesburg'],
};

/** Rough centroids (population-weighted where a country is large) and a representative zone. */
const COUNTRIES: Record<string, Coord> = {
  sg: [1.3521, 103.8198, 'sg', 'Asia/Singapore'],
  my: [3.139, 101.6869, 'my', 'Asia/Kuala_Lumpur'],
  id: [-6.2088, 106.8456, 'id', 'Asia/Jakarta'],
  th: [13.7563, 100.5018, 'th', 'Asia/Bangkok'],
  ph: [14.5995, 120.9842, 'ph', 'Asia/Manila'],
  vn: [16.0, 106.0, 'vn', 'Asia/Ho_Chi_Minh'],
  hk: [22.3193, 114.1694, 'hk', 'Asia/Hong_Kong'],
  tw: [25.033, 121.5654, 'tw', 'Asia/Taipei'],
  cn: [32.0, 114.0, 'cn', 'Asia/Shanghai'],
  jp: [35.6762, 139.6503, 'jp', 'Asia/Tokyo'],
  kr: [37.5665, 126.978, 'kr', 'Asia/Seoul'],
  in: [21.0, 78.0, 'in', 'Asia/Kolkata'],
  pk: [30.0, 70.0, 'pk', 'Asia/Karachi'],
  ae: [25.2048, 55.2708, 'ae', 'Asia/Dubai'],
  tr: [39.0, 35.0, 'tr', 'Europe/Istanbul'],
  gb: [52.5, -1.5, 'gb', 'Europe/London'],
  de: [51.0, 10.0, 'de', 'Europe/Berlin'],
  fr: [46.5, 2.5, 'fr', 'Europe/Paris'],
  es: [40.4, -3.7, 'es', 'Europe/Madrid'],
  pt: [39.5, -8.0, 'pt', 'Europe/Lisbon'],
  it: [42.8, 12.5, 'it', 'Europe/Rome'],
  ch: [46.8, 8.2, 'ch', 'Europe/Zurich'],
  nl: [52.2, 5.3, 'nl', 'Europe/Amsterdam'],
  pl: [52.0, 19.5, 'pl', 'Europe/Warsaw'],
  cz: [49.8, 15.5, 'cz', 'Europe/Prague'],
  se: [59.3, 18.0, 'se', 'Europe/Stockholm'],
  ua: [49.0, 31.0, 'ua', 'Europe/Kyiv'],
  us: [39.8, -95.6, 'us', 'America/Chicago'],
  ca: [45.0, -79.0, 'ca', 'America/Toronto'],
  mx: [20.0, -100.0, 'mx', 'America/Mexico_City'],
  br: [-15.0, -47.0, 'br', 'America/Sao_Paulo'],
  au: [-33.0, 147.0, 'au', 'Australia/Sydney'],
  gh: [6.5, -1.0, 'gh', 'Africa/Accra'],
  ng: [8.0, 6.0, 'ng', 'Africa/Lagos'],
  ke: [-1.2921, 36.8219, 'ke', 'Africa/Nairobi'],
  za: [-28.0, 26.0, 'za', 'Africa/Johannesburg'],
};

export interface Place {
  lat: number;
  lng: number;
  /** Lower-case ISO 3166-1 alpha-2. */
  country: string;
  timezone: string;
  precision: 'city' | 'country';
  /** Normalised key the place was found under, e.g. "marina bay". */
  name: string;
}

const toPlace = (c: Coord, precision: Place['precision'], name: string): Place => ({ lat: c[0], lng: c[1], country: c[2], timezone: c[3], precision, name });

/** Names of every known city, longest first (used by intake to spot a place in free text). */
export const knownCityNames = (): string[] => Object.keys(CITIES).sort((a, b) => b.length - a.length);

/** The most specific known place named in free text ("Marina Bay, Singapore" -> Marina Bay). */
export function resolvePlace(text: string | undefined): Place | null {
  if (!text) return null;
  const whole = norm(text).replace(/[()]/g, ' ');
  const words = whole.split(/[\s,;/]+/).filter(Boolean);
  const cities: Place[] = [];
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      const c = CITIES[phrase];
      if (c) cities.push(toPlace(c, 'city', phrase));
    }
  }
  // A district beats the city it sits in ("Marina Bay, Singapore").
  if (cities.length > 0) return cities.find((c) => c.name !== 'singapore') ?? cities[0]!;
  const tokens = [whole, ...whole.split(/[,;/]/).map((t) => t.trim())];
  for (const t of tokens) {
    const k = aliasKey.get(t);
    if (k && COUNTRIES[k]) return toPlace(COUNTRIES[k], 'country', t);
  }
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (phrase.length < 4) continue; // short codes ('in', 'us') only as whole tokens
      const k = aliasKey.get(phrase);
      if (k && COUNTRIES[k]) return toPlace(COUNTRIES[k], 'country', phrase);
    }
  }
  return null;
}

/** Where a profile is: its city (when it agrees with its country), else its country. */
export function profilePlace(profile: { country?: string; city?: string }): Place | null {
  const country = profile.country ? canon(norm(profile.country)) : undefined;
  if (profile.city) {
    const c = CITIES[norm(profile.city)];
    if (c && (!country || c[2] === country)) return toPlace(c, 'city', norm(profile.city));
  }
  if (country && COUNTRIES[country]) return toPlace(COUNTRIES[country], 'country', country);
  return null;
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The profile's own zone, else one inferred from its city or country. */
export function profileTimezone(profile: { timezone?: string; country?: string; city?: string }): string | undefined {
  return profile.timezone ?? profilePlace(profile)?.timezone;
}

/** Display name for a place, e.g. "marina bay" -> "Marina Bay", "sg" -> "SG". */
export const placeLabel = (p: Place): string => (p.name.length <= 3 ? p.name.toUpperCase() : p.name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()));
