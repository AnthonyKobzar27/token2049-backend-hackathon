// Placeholder for the RentAHuman API source. Reports itself disabled until the
// client is written, so the registry skips it.

import type { Config } from '../config';
import type { FreelancerSource } from '../domain/ports';

export function createRentAHumanSource(config: Config): FreelancerSource {
  if (config.RENTAHUMAN_API_KEY) {
    console.warn('[rentahuman] API key is set but the source is not implemented yet');
  }
  return {
    name: 'rentahuman',
    platform: 'rentahuman',
    kind: 'api',
    isEnabled: () => false,
    async search() {
      return [];
    },
  };
}
