// Worker wallet simulator for the HTTP onboarding flow, for when no phone with the Veridian wallet
// is at hand. It speaks to KERIA exactly as the wallet's cloud agent does: connects to HAAS via the
// session's OOBI, hands over its own OOBI, admits the granted credential, then presents it back to
// HAAS over IPEX (which marks the worker credential-verified with proof of holder).
//
//   pnpm veridian:wallet http://localhost:8787/veridian/onboarding/<sessionId>
//
// Env: VERIDIAN_KERIA_URL / VERIDIAN_KERIA_BOOT_URL (the wallet's KERIA; default the local one),
// VERIDIAN_WALLET_PASSCODE (reuse a wallet; random when unset).

import { Serder } from 'signify-ts';
import { connectSignify, newPasscode, waitOp, type SignifyPort } from '../src/identity/veridian/client';

const sessionUrl = process.argv[2];
if (!sessionUrl) {
  console.error('usage: pnpm veridian:wallet <HAAS>/veridian/onboarding/<sessionId>');
  process.exit(2);
}
const url = process.env.VERIDIAN_KERIA_URL ?? 'http://127.0.0.1:3901';
const bootUrl = process.env.VERIDIAN_KERIA_BOOT_URL ?? 'http://127.0.0.1:3903';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dt = () => new Date().toISOString().replace('Z', '000+00:00');
const NAME = 'worker';

async function nextNote(w: SignifyPort, route: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const note = (await w.notifications().list(0, 99)).notes.find((n) => !n.r && n.a.r === route);
    if (note) {
      await w.notifications().mark(note.i);
      return note;
    }
    await sleep(500);
  }
  throw new Error(`no ${route} within ${timeoutMs} ms`);
}

async function main() {
  const session = (await (await fetch(sessionUrl!)).json()) as { id: string; issuerOobi: string; workerId: string; status: string };
  console.log(`session ${session.id} for ${session.workerId}: ${session.status}`);

  const passcode = process.env.VERIDIAN_WALLET_PASSCODE ?? (await newPasscode());
  const w = await connectSignify({ url, bootUrl, passcode });
  let aid: string;
  try {
    aid = (await w.identifiers().get(NAME)).prefix;
  } catch {
    await waitOp(w, await (await w.identifiers().create(NAME)).op(), 30_000);
    await waitOp(w, await (await w.identifiers().addEndRole(NAME, 'agent', w.agent?.pre)).op(), 30_000);
    aid = (await w.identifiers().get(NAME)).prefix;
  }
  const myOobi = (await w.oobis().get(NAME, 'agent')).oobis[0]!;
  console.log(`wallet AID ${aid}\nwallet OOBI ${myOobi}`);

  // 1. "Scan" the HAAS QR.
  const issuerAid = new URL(session.issuerOobi).pathname.split('/')[2]!;
  await waitOp(w, await w.oobis().resolve(session.issuerOobi, 'HAAS'), 30_000);
  // The real wallet finds the schema through HAAS's indexer end role; resolve it directly here.
  const schemaUrl = `${new URL(sessionUrl!).origin}/veridian`;
  const info = (await (await fetch(schemaUrl)).json()) as { schemaOobi: string };
  await waitOp(w, await w.oobis().resolve(info.schemaOobi, 'haas-schema'), 30_000);

  // 2. Give HAAS our OOBI (the paste box on the connect page).
  const res = await fetch(`${sessionUrl}/wallet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobi: myOobi }) });
  const granted = (await res.json()) as { status: string; credentialSaid?: string; error?: string };
  console.log(`HAAS: ${granted.status} ${granted.credentialSaid ?? granted.error ?? ''}`);
  if (!granted.credentialSaid) process.exit(1);

  // 3. Accept the credential offer.
  const grant = await nextNote(w, '/exn/ipex/grant');
  const grantExn = await w.exchanges().get(grant.a.d);
  console.log(`grant from ${grantExn.exn.i}; schema base for the Veridian wallet (a.oobiUrl): ${grantExn.exn.a?.oobiUrl ?? 'none'}`);
  const [admit, sigs, end] = await (w as any).ipex().admit({ senderName: NAME, recipient: issuerAid, grantSaid: grant.a.d, message: '', datetime: dt() });
  await waitOp(w, await (w as any).ipex().submitAdmit(NAME, admit, sigs, end, [issuerAid]), 30_000);
  let cred: any;
  for (let i = 0; i < 60 && !cred; i++) cred = await w.credentials().get(granted.credentialSaid).catch(() => sleep(500).then(() => undefined));
  console.log('holding credential', cred.sad.d, cred.sad.a);

  // 4. Present it back to HAAS (holder-signed IPEX grant).
  const [g, gs, ge] = await w.ipex().grant({ senderName: NAME, recipient: issuerAid, acdc: new Serder(cred.sad), anc: new Serder(cred.anc), iss: new Serder(cred.iss), datetime: dt() });
  await waitOp(w, await w.ipex().submitGrant(NAME, g, gs, ge, [issuerAid]), 30_000);
  console.log('presented to HAAS over IPEX');
  console.log(`wallet passcode (VERIDIAN_WALLET_PASSCODE): ${passcode}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
