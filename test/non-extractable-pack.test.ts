// Pins the SUBTRACTIVE half of pack-driven facts eligibility.
//
// Background. `facts/eligibility.ts` gated on a hardcoded ELIGIBLE_TYPES list
// and never consulted the pack, so a pack could declare `extractable: false`
// on a type and facts extraction would keep mining it. Atom extraction DID
// honor the flag (it resolves the pack), which made the split invisible: an
// operator sets the flag, watches atom extraction stop, and reasonably
// concludes the type is no longer costing LLM calls.
//
// Observed on a real brain: `email` was declared `extractable: false` on
// 2026-08-03 with a written rationale ending "searchable, never extractable",
// and facts extraction mined 30,604 email pages for two more weeks.
//
// The fix is subtractive, not a replacement. See the long comment on
// nonExtractableTypesFromPack: ELIGIBLE_TYPES contains types no pack declares
// (`slack`, `atom`, `source`, …) and switching to the pack's additive
// extractable set would silently drop every one of them.

import { describe, expect, test } from 'bun:test';
import {
  nonExtractableTypesFromPack,
  extractableTypesFromPack,
  parseSchemaPackManifest,
} from '../src/core/schema-pack/index.ts';

function pack(pageTypes: unknown[]) {
  return parseSchemaPackManifest({
    api_version: 'gbrain-schema-pack-v1',
    name: 'test-pack',
    version: '1.0.0',
    extends: null,
    page_types: pageTypes,
  });
}

describe('nonExtractableTypesFromPack', () => {
  test('returns types explicitly declared extractable: false', () => {
    const p = pack([
      { name: 'email', primitive: 'temporal', extractable: false },
      { name: 'note', primitive: 'concept', extractable: true },
    ]);
    const out = nonExtractableTypesFromPack(p);
    expect(out.has('email')).toBe(true);
    expect(out.has('note')).toBe(false);
  });

  test('includes ALIASES of a non-extractable type', () => {
    // This is the case that would otherwise leak. A page can carry
    // `type: calendar-event` while the pack declares `event` with
    // `aliases: [calendar-event]`. Honoring the declaration without the
    // aliases leaves exactly those pages extracting.
    const p = pack([
      {
        name: 'event',
        primitive: 'temporal',
        aliases: ['calendar-event', 'appointment', 'booking'],
        extractable: false,
      },
    ]);
    const out = nonExtractableTypesFromPack(p);
    expect(out.has('event')).toBe(true);
    expect(out.has('calendar-event')).toBe(true);
    expect(out.has('appointment')).toBe(true);
    expect(out.has('booking')).toBe(true);
  });

  test('does NOT include aliases of an EXTRACTABLE type', () => {
    const p = pack([
      { name: 'note', primitive: 'concept', aliases: ['scratch'], extractable: true },
    ]);
    expect(nonExtractableTypesFromPack(p).size).toBe(0);
  });

  test('a struct-shaped extractable counts as extractable, not excluded', () => {
    // v0.42 widening: `extractable` may be a spec struct. A pack author who
    // supplies prompt_template + eval_dimensions plainly means "extract this".
    const p = pack([
      { name: 'claim', primitive: 'concept', extractable: { eval_dimensions: [] } },
    ]);
    expect(nonExtractableTypesFromPack(p).has('claim')).toBe(false);
  });

  test('is the exact complement of extractableTypesFromPack over declared names', () => {
    const p = pack([
      { name: 'email', primitive: 'temporal', extractable: false },
      { name: 'event', primitive: 'temporal', extractable: false },
      { name: 'note', primitive: 'concept', extractable: true },
      { name: 'meeting', primitive: 'temporal', extractable: true },
    ]);
    const no = nonExtractableTypesFromPack(p);
    const yes = extractableTypesFromPack(p);
    for (const name of ['email', 'event', 'note', 'meeting']) {
      // Every declared name lands in exactly one of the two sets.
      expect(no.has(name) !== yes.has(name)).toBe(true);
    }
  });

  test('types the pack does not declare appear in NEITHER set', () => {
    // The whole reason the eligibility change is subtractive. `slack` and
    // `atom` are in the hardcoded ELIGIBLE_TYPES but are absent from real
    // user packs; they must not be swept out by a pack-driven gate.
    const p = pack([{ name: 'email', primitive: 'temporal', extractable: false }]);
    const no = nonExtractableTypesFromPack(p);
    const yes = extractableTypesFromPack(p);
    for (const undeclared of ['slack', 'atom', 'source', 'writing', 'media', 'tweet']) {
      expect(no.has(undeclared)).toBe(false);
      expect(yes.has(undeclared)).toBe(false);
    }
  });

  test('empty page_types yields an empty exclusion set, never a throw', () => {
    // Fail-open shape: a pack with nothing declared must not exclude anything.
    const p = pack([]);
    expect(nonExtractableTypesFromPack(p).size).toBe(0);
  });
});

// The ADDITIVE half. A pack declaring `extractable: true` on a type outside the
// hardcoded ELIGIBLE_TYPES must make it eligible, or the flag is one-way.
describe('extractableTypesFromPack — the additive half', () => {
  test('surfaces a type absent from the hardcoded eligible list', () => {
    // Real case: rereset-stayops-v1 declares call-log over 4,699 Dialpad
    // transcripts. `call-log` is not in ELIGIBLE_TYPES, so before the additive
    // half the declaration did nothing at all.
    const p = pack([
      { name: 'call-log', primitive: 'temporal',
        aliases: ['dialpad-call', 'phone-call'], extractable: true },
    ]);
    expect(extractableTypesFromPack(p).has('call-log')).toBe(true);
    expect(nonExtractableTypesFromPack(p).has('call-log')).toBe(false);
  });

  test('a pack can flip a type in BOTH directions independently', () => {
    const p = pack([
      { name: 'call-log', primitive: 'temporal', extractable: true },
      { name: 'email', primitive: 'temporal', extractable: false },
    ]);
    const add = extractableTypesFromPack(p);
    const rm = nonExtractableTypesFromPack(p);
    expect(add.has('call-log')).toBe(true);
    expect(rm.has('call-log')).toBe(false);
    expect(rm.has('email')).toBe(true);
    expect(add.has('email')).toBe(false);
  });
});

// Aliases must follow their type in BOTH directions or the two halves disagree.
describe('alias symmetry across both directions', () => {
  test('an extractable type lends eligibility to its aliases', () => {
    const p = pack([
      { name: 'call-log', primitive: 'temporal',
        aliases: ['dialpad-call', 'phone-call'], extractable: true },
    ]);
    // Verified live on a real brain before this fix: call-log was {"ok":true}
    // while dialpad-call came back {"ok":false,"reason":"kind:dialpad-call"}.
    const ex = extractableTypesFromPack(p);
    expect(ex.has('call-log')).toBe(true);
    const declared = p.page_types.find(t => t.name === 'call-log');
    expect(declared?.aliases).toContain('dialpad-call');
    expect(nonExtractableTypesFromPack(p).has('dialpad-call')).toBe(false);
  });
});
