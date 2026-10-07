// End-to-end Veridian demo against a live KERIA: HAAS issues a "HAAS Verified Worker" ACDC to a
// worker and verifies it. The worker side is a second Signify client standing in for the Veridian
// wallet (same KERIA protocol the wallet's cloud agent speaks), so the whole flow runs headless.
//
//   pnpm veridian:demo                     # KERIA at localhost:3901/3903 (infra/veridian)
//   VERIDIAN_DEMO_REVOKE=1 pnpm veridian:demo   # also revoke and show verification failing
//
// Env: VERIDIAN_KERIA_URL, VERIDIAN_KERIA_BOOT_URL, VERIDIAN_PASSCODE (issuer; random when unset),
// VERIDIAN_SCHEMA_OOBI_URL (else this script serves the schema itself on VERIDIAN_DEMO_SCHEMA_PORT).

import { createServer } from 'node:http';
import { connectSignify, newPasscode, waitOp, type SignifyPort } from '../src/identity/veridian/client';
import { createVeridianCredentialIssuer } from '../src/identity/veridian/issuer';
import { HAAS_WORKER_SCHEMA, HAAS_WORKER_SCHEMA_SAID } from '../src/identity/veridian/schema';

const url = process.env.VERIDIAN_KERIA_URL ?? 'http://127.0.0.1:3901';
const bootUrl = process.env.VERIDIAN_KERIA_BOOT_URL ?? 'http://127.0.0.1:3903';
const port = Number(process.env.VERIDIAN_DEMO_SCHEMA_PORT ?? 7723);
const schemaHost = process.env.VERIDIAN_DEMO_SCHEMA_HOST ?? '127.0.0.1';
const step = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitNote(client: SignifyPort, route: string, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { notes } = await client.notifications().list(0, 99);
    const note = notes.find((n) => !n.r && n.a.r === route);
    if (note) {
      await client.notifications().mark(note.i);
      return note;
    }
    await sleep(500);
  }
  throw new Error(`no ${route} notification within ${timeoutMs} ms`);
}

async function main() {
  let schemaOobiUrl = process.env.VERIDIAN_SCHEMA_OOBI_URL;
  let server: ReturnType<typeof createServer> | undefined;
  if (!schemaOobiUrl) {
    server = createServer((req, res) => {
      if (req.url?.startsWith(`/oobi/${HAAS_WORKER_SCHEMA_SAID}`)) {
        res.writeHead(200, { 'content-type': 'application/schema+json' });
        res.end(JSON.stringify(HAAS_WORKER_SCHEMA));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server!.listen(port, '0.0.0.0', r));
    schemaOobiUrl = `http://${schemaHost}:${port}/oobi/${HAAS_WORKER_SCHEMA_SAID}`;
  }

  step('HAAS issuer: connect to KERIA, create/load AID + registry, resolve schema');
  const issuerPasscode = process.env.VERIDIAN_PASSCODE ?? (await newPasscode());
  const haas = await connectSignify({ url, bootUrl, passcode: issuerPasscode });
  const issuer = createVeridianCredentialIssuer(haas, { schemaOobiUrl, oobiBaseUrl: new URL(schemaOobiUrl).origin });
  const { issuerAid, registryId, schemaSaid } = await issuer.init();
  const issuerOobi = await issuer.issuerOobi();
  console.log({ issuerAid, registryId, schemaSaid, issuerOobi });

  step('Worker wallet (stand-in for Veridian): boot agent, create AID, publish OOBI');
  const wallet = await connectSignify({ url, bootUrl, passcode: await newPasscode() });
  await waitOp(wallet, await (await wallet.identifiers().create('worker')).op(), 30_000);
  await waitOp(wallet, await (await wallet.identifiers().addEndRole('worker', 'agent', wallet.agent?.pre)).op(), 30_000);
  const walletOobi = (await wallet.oobis().get('worker', 'agent')).oobis[0]!;
  console.log({ walletOobi });

  step('Connect: wallet scans the HAAS OOBI (QR); HAAS resolves the wallet OOBI');
  await waitOp(wallet, await wallet.oobis().resolve(issuerOobi, 'HAAS'), 30_000);
  await waitOp(wallet, await wallet.oobis().resolve(schemaOobiUrl, 'haas-schema'), 30_000);
  const holderAid = await issuer.resolveHolder(walletOobi, 'worker-demo');
  console.log({ holderAid });

  step('Issue the HAAS Verified Worker ACDC and IPEX-grant it to the worker');
  const cred = await issuer.issueToHolder(holderAid, { workerId: 'freelancer:demo-42', platformsVerified: ['freelancer', 'fiverr'], verificationMethod: 'platform-oauth' });
  console.log({ said: cred.said, grantSaid: cred.grantSaid, attributes: cred.attributes });

  step('Wallet receives the grant and admits it');
  const grantNote = await waitNote(wallet, '/exn/ipex/grant');
  const [admit, asigs, aend] = await (wallet as any).ipex().admit({ senderName: 'worker', recipient: issuerAid, grantSaid: grantNote.a.d, message: '', datetime: new Date().toISOString().replace('Z', '000+00:00') });
  await waitOp(wallet, await (wallet as any).ipex().submitAdmit('worker', admit, asigs, aend, [issuerAid]), 30_000);
  const held = await waitHeld(wallet, cred.said);
  console.log({ walletHolds: held.sad.d, attrs: held.sad.a });

  step('HAAS sees the admit');
  let admitted = false;
  for (let i = 0; i < 40 && !admitted; i++) {
    admitted = await issuer.admitted(cred.grantSaid);
    if (!admitted) await sleep(500);
  }
  console.log({ admitted });

  step('Router path: verify by SAID (cache refresh)');
  console.log(await issuer.verifySaid(cred.said, { timeoutMs: 1500 }));

  step('Worker presents the credential to HAAS over IPEX (signed by the holder AID)');
  const acdcSerder = held; // CredentialResult: { sad, anc, iss, ... }
  const [g, gsigs, gend] = await wallet.ipex().grant({ senderName: 'worker', recipient: issuerAid, acdc: new (await import('signify-ts')).Serder(acdcSerder.sad), anc: new (await import('signify-ts')).Serder(acdcSerder.anc), iss: new (await import('signify-ts')).Serder(acdcSerder.iss), datetime: new Date().toISOString().replace('Z', '000+00:00') });
  await waitOp(wallet, await wallet.ipex().submitGrant('worker', g, gsigs, gend, [issuerAid]), 30_000);
  let presentations: Awaited<ReturnType<typeof issuer.presentations>> = [];
  for (let i = 0; i < 40 && presentations.length === 0; i++) {
    presentations = await issuer.presentations({ timeoutMs: 5000 });
    if (!presentations.length) await sleep(500);
  }
  console.log(JSON.stringify(presentations, null, 2));

  step('Raw presentation via KERIA POST /credentials/verify');
  console.log(await issuer.verify({ acdc: held.sad, iss: held.iss }, { timeoutMs: 5000 }));

  step('Tampered presentation');
  console.log(await issuer.verify({ acdc: { ...held.sad, a: { ...held.sad.a, workerId: 'freelancer:someone-else' } }, iss: held.iss }, { timeoutMs: 5000 }));

  if (process.env.VERIDIAN_DEMO_REVOKE) {
    step('Revoke and verify again');
    await issuer.revoke(cred.said);
    console.log(await issuer.verifySaid(cred.said, { timeoutMs: 3000 }));
  }

  server?.close();
  console.log(`\nDone. Issuer passcode (set VERIDIAN_PASSCODE to reuse this issuer): ${issuerPasscode}`);
}

async function waitHeld(wallet: SignifyPort, said: string) {
  for (let i = 0; i < 60; i++) {
    try {
      return await wallet.credentials().get(said);
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`wallet never stored credential ${said}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
