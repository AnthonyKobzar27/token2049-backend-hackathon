// A small gazetteer for placing tasks and workers, and great-circle distance.
// Coarse on purpose: it only decides who is "nearby".

import type { GeoPoint } from './types';

/** Lower-case place name -> point. Singapore first (the demo), then a few hubs. */
export const PLACES: Record<string, GeoPoint> = {
  'tanjong pagar': { lat: 1.2764, lng: 103.8458 },
  'tanjong pagar polyclinic': { lat: 1.2779, lng: 103.8434 },
  'outram': { lat: 1.2803, lng: 103.8395 },
  'chinatown': { lat: 1.2836, lng: 103.8443 },
  'raffles place': { lat: 1.2840, lng: 103.8515 },
  'marina bay': { lat: 1.2834, lng: 103.8607 },
  'marina bay sands': { lat: 1.2834, lng: 103.8607 },
  'bugis': { lat: 1.3009, lng: 103.8559 },
  'orchard': { lat: 1.3048, lng: 103.8318 },
  'novena': { lat: 1.3204, lng: 103.8438 },
  'toa payoh': { lat: 1.3343, lng: 103.8563 },
  'bishan': { lat: 1.3508, lng: 103.8485 },
  'queenstown': { lat: 1.2942, lng: 103.7861 },
  'buona vista': { lat: 1.3072, lng: 103.7900 },
  'one-north': { lat: 1.2995, lng: 103.7872 },
  'clementi': { lat: 1.3151, lng: 103.7652 },
  'jurong east': { lat: 1.3331, lng: 103.7422 },
  'woodlands': { lat: 1.4360, lng: 103.7865 },
  'yishun': { lat: 1.4294, lng: 103.8354 },
  'ang mo kio': { lat: 1.3691, lng: 103.8454 },
  'serangoon': { lat: 1.3496, lng: 103.8735 },
  'paya lebar': { lat: 1.3177, lng: 103.8926 },
  'geylang': { lat: 1.3201, lng: 103.8918 },
  'tampines': { lat: 1.3496, lng: 103.9568 },
  'bedok': { lat: 1.3236, lng: 103.9273 },
  'changi': { lat: 1.3644, lng: 103.9915 },
  'sentosa': { lat: 1.2494, lng: 103.8303 },
  'singapore': { lat: 1.2903, lng: 103.8520 },
  'kuala lumpur': { lat: 3.139, lng: 101.6869 },
  'bangkok': { lat: 13.7563, lng: 100.5018 },
  'hong kong': { lat: 22.3193, lng: 114.1694 },
  'london': { lat: 51.5072, lng: -0.1276 },
  'new york': { lat: 40.7128, lng: -74.006 },
};

/** Finds the most specific known place mentioned in the text (longest name wins). */
export function findPlace(text: string | undefined): { name: string; point: GeoPoint } | undefined {
  if (!text) return undefined;
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
  let best: string | undefined;
  for (const name of Object.keys(PLACES)) {
    if (hay.includes(` ${name} `) && (!best || name.length > best.length)) best = name;
  }
  return best ? { name: best, point: PLACES[best]! } : undefined;
}

/** Great-circle distance in km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
