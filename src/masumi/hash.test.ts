import { describe, expect, it } from 'vitest';
import { canonicalJson, inputHash, resultHash } from './hash';

// Vectors were computed with Python (hashlib + json.dumps sort_keys, compact separators, ensure_ascii=False),
// the same canonical form as pip-masumi's canonicaljson. No vector ships with pip-masumi or the MIPs.
const id = 'abcdef0123456789';

describe('hash', () => {
  it('canonicalises like JCS', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: undefined } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"z":1}}');
  });
  it('input hash', () => {
    const d = { task: 'Logo design', skills: 'figma,branding', budget_usd: 250, remote_ok: true, notes: 'café "quoted"\nline' };
    expect(canonicalJson(d)).toBe('{"budget_usd":250,"notes":"café \\"quoted\\"\\nline","remote_ok":true,"skills":"figma,branding","task":"Logo design"}');
    expect(inputHash(d, id)).toBe('4468cd5d99e4a6cca0512b82a9ec8e23bacfd4964d6762782c35a684716b9418');
  });
  it('result hash JSON-escapes the output like the reference', () => {
    expect(resultHash('Booked "Ana"\nfor $120 – café', id)).toBe('32f1960c1ae340c854567250cbc7b9fd1d57942d82a03942c95db89e13ca7b57');
    expect(resultHash('plain', id)).toBe(resultHash('plain', id, { raw: true }));
  });
});
