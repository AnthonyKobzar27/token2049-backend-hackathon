// HTTP surface for Veridian identity.
//
//   GET  /oobi/:said                          the HAAS Verified Worker schema (application/schema+json);
//                                             KERIA and the Veridian wallet resolve it as a data OOBI
//   GET  /veridian                            issuer AID, OOBI, registry, schema SAID
//   POST /veridian/onboarding                 operator: {workerId, platformsVerified[], verificationMethod,
//                                             cardanoReputationAsset?} -> session + issuer OOBI + QR
//   GET  /veridian/connect/:id                worker: page with the QR to scan and a field for the wallet OOBI
//   POST /veridian/onboarding/:id/wallet      worker: {oobi} -> HAAS resolves it, issues + grants the ACDC
//   GET  /veridian/onboarding/:id             session status (awaiting-wallet, issuing, granted, admitted, failed)
//   POST /veridian/verify                     anyone: {acdc, iss, workerId?} or {said | workerId} -> verdict
//   GET  /veridian/workers/:workerId          cached credential and last verdict
//
// Operator routes need `Authorization: Bearer $VERIDIAN_ADMIN_TOKEN`; with no token configured they
// only answer loopback requests. The session id (128 random bits) is the worker's capability.

import { timingSafeEqual } from 'node:crypto';
import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { HAAS_WORKER_SCHEMA, HAAS_WORKER_SCHEMA_SAID } from './schema';
import type { OnboardingSession, VeridianService } from './service';

export interface VeridianApiOptions {
  adminToken?: string;
  publicUrl: string;
  verifyTimeoutMs?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function mountVeridian(app: Express, veridian: VeridianService | null, opts: VeridianApiOptions): void {
  app.get('/oobi/:said', (req, res) => {
    if (req.params.said !== HAAS_WORKER_SCHEMA_SAID) return void res.status(404).json({ error: 'unknown schema' });
    res.type('application/schema+json').send(JSON.stringify(HAAS_WORKER_SCHEMA));
  });

  const r = Router();
  const off = (res: Response) =>
    res.status(503).json({ error: 'Veridian identity is not configured: set VERIDIAN_KERIA_URL, VERIDIAN_KERIA_BOOT_URL and VERIDIAN_PASSCODE', detail: 'see docs/VERIDIAN.md' });

  const admin = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.get('authorization') ?? '';
    if (opts.adminToken) {
      const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
      const want = Buffer.from(opts.adminToken);
      if (given.length === want.length && timingSafeEqual(given, want)) return next();
      return void res.status(401).json({ error: 'operator token required' });
    }
    if (LOOPBACK.has(req.socket.remoteAddress ?? '')) return next();
    res.status(403).json({ error: 'set VERIDIAN_ADMIN_TOKEN to onboard workers from outside localhost' });
  };

  const fail = (res: Response, err: unknown, status = 502) => res.status(status).json({ error: (err as Error).message });

  r.get('/veridian', async (_req, res) => {
    if (!veridian) return void off(res);
    try {
      const { issuerAid, registryId, schemaSaid } = await veridian.issuer.init();
      res.json({ issuerAid, registryId, schemaSaid, oobi: await veridian.issuer.issuerOobi(), schemaOobi: `${opts.publicUrl}/oobi/${schemaSaid}` });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post('/veridian/onboarding', admin, async (req, res) => {
    if (!veridian) return void off(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    let session: OnboardingSession;
    try {
      session = await veridian.start({
        workerId: String(b.workerId ?? ''),
        platformsVerified: (b.platformsVerified ?? []) as string[],
        verificationMethod: String(b.verificationMethod ?? ''),
        ...(typeof b.cardanoReputationAsset === 'string' && b.cardanoReputationAsset ? { cardanoReputationAsset: b.cardanoReputationAsset } : {}),
      });
    } catch (err) {
      return void fail(res, err, /required|must be/.test((err as Error).message) ? 400 : 502);
    }
    res.status(201).json({
      session,
      qr: await QRCode.toDataURL(session.issuerOobi, { margin: 1, width: 320 }),
      connectUrl: `${opts.publicUrl}/veridian/connect/${session.id}`,
      next: `POST /veridian/onboarding/${session.id}/wallet {"oobi": "<the worker's Veridian wallet OOBI>"}`,
    });
  });

  r.get('/veridian/onboarding/:id', async (req, res) => {
    if (!veridian) return void off(res);
    const s = await veridian.get(req.params.id);
    if (!s) return void res.status(404).json({ error: 'unknown onboarding session' });
    res.json(s);
  });

  r.post('/veridian/onboarding/:id/wallet', async (req, res) => {
    if (!veridian) return void off(res);
    const oobi = (req.body as { oobi?: unknown } | undefined)?.oobi;
    if (typeof oobi !== 'string' || !oobi.trim()) return void res.status(400).json({ error: 'oobi is required' });
    try {
      const s = await veridian.connect(req.params.id, oobi);
      res.status(s.status === 'failed' ? 502 : 200).json(s);
    } catch (err) {
      fail(res, err, /unknown onboarding/.test((err as Error).message) ? 404 : 502);
    }
  });

  r.get('/veridian/connect/:id', async (req, res) => {
    if (!veridian) return void off(res);
    const s = await veridian.get(req.params.id);
    if (!s) return void res.status(404).type('text/plain').send('Unknown or expired onboarding link.');
    const qr = await QRCode.toDataURL(s.issuerOobi, { margin: 1, width: 320 });
    res.type('html').send(connectPage(s, qr));
  });

  r.post('/veridian/verify', async (req, res) => {
    if (!veridian) return void off(res);
    const b = (req.body ?? {}) as Record<string, any>;
    const input = {
      ...(typeof b.workerId === 'string' ? { workerId: b.workerId } : {}),
      ...(typeof b.said === 'string' ? { said: b.said } : {}),
      ...(b.acdc && typeof b.acdc === 'object' ? { acdc: b.acdc } : {}),
      ...(b.iss && typeof b.iss === 'object' ? { iss: b.iss } : {}),
    };
    if (!input.said && !input.workerId && !(input.acdc && input.iss)) return void res.status(400).json({ error: 'send {acdc, iss} or {said} or {workerId}' });
    const result = await veridian.verify(input, opts.verifyTimeoutMs ? { timeoutMs: opts.verifyTimeoutMs } : {});
    res.status(result.valid ? 200 : 422).json(result);
  });

  r.get('/veridian/workers/:workerId', (req, res) => {
    if (!veridian) return void off(res);
    const credential = veridian.credentialOf(req.params.workerId);
    const check = veridian.checkOf(req.params.workerId);
    if (!credential && !check) return void res.status(404).json({ error: 'no Veridian credential for this worker' });
    res.json({ workerId: req.params.workerId, credential: credential ?? null, check: check ?? null, verified: veridian.signals([req.params.workerId]).get(req.params.workerId)?.verified ?? false });
  });

  app.use(r);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function connectPage(s: OnboardingSession, qr: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your Veridian wallet</title>
<style>
:root{--bg:#fff;--fg:#14171f;--muted:#5b6170;--line:#d9dce3;--accent:#0b5fff}
@media (prefers-color-scheme:dark){:root{--bg:#101318;--fg:#e8eaef;--muted:#9aa1ae;--line:#2a2f39;--accent:#6c9cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}p{color:var(--muted)}
img{display:block;width:100%;max-width:320px;background:#fff;border-radius:8px;margin:16px 0}
code,textarea{font:13px ui-monospace,monospace;word-break:break-all}
textarea{width:100%;box-sizing:border-box;min-height:84px;background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px}
button{margin-top:8px;padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600}
.status{margin-top:16px;padding:12px;border:1px solid var(--line);border-radius:6px}
</style></head><body><main>
<h1>Get your HAAS Verified Worker credential</h1>
<p>Worker <code>${esc(s.workerId)}</code>, verified on ${esc(s.platformsVerified.join(', ') || 'no platforms')} by ${esc(s.verificationMethod)}.</p>
<p><strong>1.</strong> In the Veridian wallet, open Connections and scan this code to connect to HAAS.</p>
<img src="${qr}" alt="HAAS connection QR code">
<details><summary>Show the OOBI as text</summary><code>${esc(s.issuerOobi)}</code></details>
<p><strong>2.</strong> In the wallet, open the identifier you want the credential on, choose to share its connection (OOBI), and paste it here.</p>
<textarea id="oobi" placeholder="https://…/oobi/E…/agent/E…"></textarea>
<button id="send">Request credential</button>
<p><strong>3.</strong> Accept the credential offer that appears in the wallet.</p>
<div class="status" id="status">Status: ${esc(s.status)}</div>
<script>
const id=${JSON.stringify(s.id)};const st=document.getElementById('status');
const show=(s)=>{st.textContent='Status: '+s.status+(s.credentialSaid?' · credential '+s.credentialSaid:'')+(s.error?' · '+s.error:'');};
document.getElementById('send').onclick=async()=>{st.textContent='Status: issuing…';
const r=await fetch('/veridian/onboarding/'+id+'/wallet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({oobi:document.getElementById('oobi').value})});
show(await r.json().catch(()=>({status:'failed',error:r.statusText})));};
setInterval(async()=>{const r=await fetch('/veridian/onboarding/'+id);if(r.ok)show(await r.json());},4000);
</script></main></body></html>`;
}
