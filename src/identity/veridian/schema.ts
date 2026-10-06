// The "HAAS Verified Worker" ACDC schema and its SAID (self-addressing identifier).
//
// An ACDC names its schema by SAID: the Blake3-256 digest (CESR code 'E') of the schema JSON with
// its own "$id" filled with '#' placeholders. KERIA refuses a schema whose $id does not match its
// content, so the SAID is computed, never typed: run `pnpm veridian:schema` after editing the JSON.
// The attributes block carries its own "$id" (ACDC compact/expanded form), saidified first.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ready, Saider } from 'signify-ts';
import schemaJson from './schema/haas-verified-worker.schema.json';

export type JsonSchema = Record<string, unknown>;

export const SCHEMA_FILE = fileURLToPath(new URL('./schema/haas-verified-worker.schema.json', import.meta.url));

/** The committed schema. Its "$id" is the SAID that credentials reference in their "s" field. */
export const HAAS_WORKER_SCHEMA: JsonSchema = schemaJson as JsonSchema;
export const HAAS_WORKER_SCHEMA_SAID: string = schemaJson.$id;

const LABEL = '$id';

/** Returns a copy of the schema with the attributes block $id and the top-level $id recomputed. */
export async function saidifySchema(schema: JsonSchema): Promise<JsonSchema> {
  await ready();
  const copy = structuredClone(schema) as JsonSchema & { properties?: { a?: { oneOf?: JsonSchema[] } } };
  const variants = copy.properties?.a?.oneOf;
  if (variants) {
    const i = variants.findIndex((v) => v.type === 'object');
    if (i >= 0) variants[i] = Saider.saidify({ ...variants[i], [LABEL]: '' }, undefined, undefined, LABEL)[1];
  }
  const [, sad] = Saider.saidify({ ...copy, [LABEL]: '' }, undefined, undefined, LABEL);
  return sad;
}

/** True when the schema's $id (and the attributes block's) match its content. */
export async function schemaSaidIsValid(schema: JsonSchema): Promise<boolean> {
  const fresh = await saidifySchema(schema);
  return JSON.stringify(fresh) === JSON.stringify(schema);
}

/** Recomputes the SAIDs and rewrites the schema file. Returns the new SAID. */
export async function writeSchemaSaid(file = SCHEMA_FILE): Promise<string> {
  const current = JSON.parse(readFileSync(file, 'utf8')) as JsonSchema;
  const sad = await saidifySchema(current);
  writeFileSync(file, `${JSON.stringify(sad, null, 2)}\n`);
  return String(sad[LABEL]);
}

// `tsx src/identity/veridian/schema.ts` (pnpm veridian:schema)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeSchemaSaid()
    .then((said) => console.log(`HAAS Verified Worker schema SAID: ${said}\n${SCHEMA_FILE}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
