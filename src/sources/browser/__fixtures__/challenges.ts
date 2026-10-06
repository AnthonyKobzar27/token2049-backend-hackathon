// Small HTML snippets for challenge detection tests.
export const PX_HOLD = `<html><head><title>Fiverr</title></head><body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>`;
export const CF_WAIT = `<html><head><title>Just a moment...</title></head><body><div id="challenge-form"></div><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile"></iframe><p>Checking if the site connection is secure</p></body></html>`;
export const DENIED = `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1></body></html>`;
export const FORBIDDEN = `<html><head><title>Error</title></head><body>Forbidden</body></html>`;
export const NORMAL = `<html><head><title>Logo design services | Fiverr</title></head><body>${'<div>Gig card with price from $25 and many words. </div>'.repeat(40)}<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></body></html>`;
export const ARTICLE_ABOUT_CAPTCHA = `<html><head><title>How CAPTCHAs work</title></head><body>${'Articles about the phrase press and hold and human checks. '.repeat(30)}</body></html>`;

export const EXAMPLE_RAW = {
  name: 'Ana Pop',
  headline: 'I will design a modern logo',
  url: '/ana_pop/design-a-modern-logo?context_referrer=search&pos=3',
  priceAmount: 50,
  priceCurrency: '€',
  priceUnit: 'fixed' as const,
  deliveryDays: 3,
  rating: 4.9,
  reviewCount: 1200,
  level: 'Top Rated',
  country: 'Romania',
  languages: ['English', 'Romanian', 'Klingon'],
  skills: ['Logo design'],
  online: true,
};
