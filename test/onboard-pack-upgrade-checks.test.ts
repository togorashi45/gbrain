// v0.42 Type Unification (T31) — 3 new onboard checks.
//
// Coverage: pack_upgrade_available fires on gbrain-base brain;
// type_proliferation pack-aware ratio (D16); dangling_aliases source-scoped
// JOIN (F12); manual_only RemediationStep flag round-trips through render.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import {
  checkPackUpgradeAvailable,
  checkTypeProliferation,
  checkDanglingAliases,
} from '../src/core/onboard/checks.ts';
import { toOnboardRecommendation } from '../src/core/onboard/render.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import {
  _resetPackLocatorForTests,
  __setPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  // Defensive reset: sibling test files in the same shard process
  // (test/schema-pack-sync.test.ts) call __setPackLocatorForTests to
  // stub the disk-loader. The mutation persists module-level across
  // files; without this reset, the stubbed locator returns null for
  // gbrain-base / gbrain-base-v2 and findPackSuccessors silently returns
  // []. Repros only when sync.test.ts runs first in the same shard, so
  // local single-file runs pass but CI shard 6 fails.
  _resetPackLocatorForTests();
});

async function seedPages(types: string[]) {
  for (let i = 0; i < types.length; i++) {
    await engine.putPage(`p${i}`, {
      title: `p${i}`,
      type: types[i] as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: `p${i}.md`,
    });
  }
}

describe('checkPackUpgradeAvailable', () => {
  it('fires on gbrain-base brain with gbrain-base-v2 available', async () => {
    // Default active pack is gbrain-base; gbrain-base-v2 declares
    // migration_from: {pack: gbrain-base, version: "1.x"}.
    // Sandbox GBRAIN_HOME: the check reads file-plane config, so a dev
    // machine whose real ~/.gbrain/config.json sets schema_pack would
    // flip this assertion.
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkPackUpgradeAvailable(engine);
      expect(result.check.name).toBe('pack_upgrade_available');
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toContain('gbrain-base-v2');
      expect(result.remediations.length).toBe(1);
      expect(result.remediations[0].job).toBe('unify-types');
      expect(result.remediations[0].protected).toBe(true);
      expect(result.remediations[0].params.target_pack).toBe('gbrain-base-v2');
    });
  });

  it('honors file-plane schema_pack when DB config is unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-pack-upgrade-'));
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ schema_pack: 'gbrain-base-v2' }, null, 2),
    );

    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      _resetPackCacheForTests();
      const result = await checkPackUpgradeAvailable(engine);
      expect(result.check.name).toBe('pack_upgrade_available');
      expect(result.check.status).toBe('ok');
      expect(result.check.message).toContain('gbrain-base-v2');
      expect(result.remediations).toEqual([]);
    });
  });

  it('manual_only routing via render.ts allowlist (D17)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkPackUpgradeAvailable(engine);
      const step = result.remediations[0];
      const rec = toOnboardRecommendation(step);
      expect(rec.apply_policy).toBe('manual_only');
    });
  });
});

describe('checkTypeProliferation (D16 pack-aware ratio)', () => {
  it('returns ok when distinct types under declared+5 threshold', async () => {
    await seedPages(['note', 'meeting', 'slack']);
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('ok');
    });
  });

  it('warns when distinct types exceed declared+5', async () => {
    // Threshold-relative (v0.42.56.0): compute `declared` from the active pack
    // the same way checkTypeProliferation does, then seed declared+6 so the
    // test keeps passing when the base pack grows (e.g. #2390 added
    // event + diary and silently moved the fixed threshold).
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const { loadActivePack } = await import('../src/core/schema-pack/load-active.ts');
      const dbConfig = (await engine.getConfig('schema_pack')) ?? undefined;
      const active = await loadActivePack({ cfg: null, remote: false, dbConfig }).catch(() => null);
      const declared = active ? active.manifest.page_types.length : 15;
      const seedCount = declared + 6; // one past the warn threshold (declared+5)
      const types: string[] = [];
      for (let i = 0; i < seedCount; i++) types.push(`custom-type-${i}`);
      await seedPages(types);
      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toMatch(new RegExp(`${seedCount} distinct`));
    });
  });

  it(
    'does NOT false-positive when every "extra" distinct type is a declared ' +
    'ALIAS, not a primary name (fleet bug 3 — Jake\'s box: 60 live types, ' +
    'zero genuine gaps, all resolve via name or alias)',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-alias-pack-'));
      try {
        const dir = join(home, 'schema-packs', 'alias-test');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'pack.yaml');
        // Declared page_types.length = 3 (note, meeting, person). person
        // declares 6 aliases — none of those alias strings is itself a
        // `name:` in this pack, matching real-world alias usage (a
        // canonical type absorbing several legacy/synonym labels).
        const body = `api_version: gbrain-schema-pack-v1
name: alias-test
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: note
    primitive: concept
    path_prefixes: []
    aliases: []
    extractable: false
    expert_routing: false
  - name: meeting
    primitive: temporal
    path_prefixes: []
    aliases: []
    extractable: false
    expert_routing: false
  - name: person
    primitive: entity
    path_prefixes: []
    aliases:
      - researcher
      - engineer
      - writer
      - coach
      - investor
      - founder
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`;
        writeFileSync(path, body, 'utf-8');
        __setPackLocatorForTests((name) => (name === 'alias-test' ? path : null));

        await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'alias-test' }, async () => {
          // declared = 3. Old code: n distinct DB types compared to
          // declared+5=8 with NO alias awareness. Seed 9 distinct types —
          // 'note', 'meeting', 'person' (primary names) plus 6 alias
          // values. Every single one resolves via a declared name or a
          // declared alias; there is no genuine gap.
          await seedPages([
            'note', 'meeting', 'person',
            'researcher', 'engineer', 'writer', 'coach', 'investor', 'founder',
          ]);
          const result = await checkTypeProliferation(engine);
          expect(result.check.status).toBe('ok');
        });
      } finally {
        _resetPackLocatorForTests();
      }
    },
  );

  it('still fails/warns on genuinely unresolved types when aliases ARE present (check keeps its value)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-alias-pack-gap-'));
    try {
      const dir = join(home, 'schema-packs', 'alias-test-gap');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'pack.yaml');
      const body = `api_version: gbrain-schema-pack-v1
name: alias-test-gap
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: note
    primitive: concept
    path_prefixes: []
    aliases: []
    extractable: false
    expert_routing: false
  - name: person
    primitive: entity
    path_prefixes: []
    aliases:
      - researcher
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`;
      writeFileSync(path, body, 'utf-8');
      __setPackLocatorForTests((name) => (name === 'alias-test-gap' ? path : null));

      await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'alias-test-gap' }, async () => {
        // 'researcher' resolves via alias (no gap). 'totally-unknown-type'
        // does NOT resolve via any declared name or alias — a REAL gap
        // that the check must still catch.
        await seedPages(['note', 'person', 'researcher', 'totally-unknown-type']);
        const result = await checkTypeProliferation(engine);
        expect(result.check.status).not.toBe('ok');
        expect(result.check.message).toContain('totally-unknown-type');
        expect(result.check.message).not.toContain('researcher');
      });
    } finally {
      _resetPackLocatorForTests();
    }
  });
});

describe('checkDanglingAliases (F12 source-scoped JOIN)', () => {
  it('returns ok when no aliases exist', async () => {
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('returns ok when alias points at active canonical', async () => {
    await seedPages(['note']);  // creates p0
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'p0')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('warns when alias points at missing canonical', async () => {
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'wiki/concepts/deleted')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
  });

  it('does NOT false-positive across sources (F12 regression)', async () => {
    // Insert a canonical page in source A
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    await engine.putPage('shared-slug', {
      title: 'shared', type: 'note' as never,
      compiled_truth: 'body that is long enough to pass any min-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: 'shared-slug.md',
    }, { sourceId: 'alt' });
    // Insert an alias in source 'default' that points at the same slug —
    // which exists ONLY in source 'alt'. The source-scoped JOIN MUST flag
    // this as dangling (not satisfied by the alt-source canonical).
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old', 'shared-slug')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
  });
});
