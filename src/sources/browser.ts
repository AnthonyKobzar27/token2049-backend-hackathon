// Placeholder for browser-read sources (fiverr, peopleperhour via the
// operator's own Chrome over CDP). Returns no sources until written.

import type { Config } from '../config';
import type { EventBus, FreelancerSource } from '../domain/ports';

export function createBrowserSources(_deps: { config: Config; bus: EventBus }): FreelancerSource[] {
  return [];
}
