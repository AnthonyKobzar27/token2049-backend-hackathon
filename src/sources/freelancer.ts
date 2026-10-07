// Placeholder for the Freelancer.com API source. Reports itself disabled until
// the client is written, so the registry skips it.

import type { Config } from '../config';
import type { FreelancerSource } from '../domain/ports';

export function createFreelancerSource(config: Config): FreelancerSource {
  if (config.FREELANCER_TOKEN || config.FREELANCER_SANDBOX_TOKEN) {
    console.warn('[freelancer] token is set but the source is not implemented yet');
  }
  return {
    name: 'freelancer',
    platform: 'freelancer',
    kind: 'api',
    isEnabled: () => false,
    async search() {
      return [];
    },
  };
}
