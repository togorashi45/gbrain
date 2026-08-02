/**
 * `cycle.extract_atoms.min_page_chars` — the atom-extraction page-length floor.
 *
 * The floor was a hardcoded 500 in extract-atoms.ts, global to every pack and
 * every brain, invisible to `gbrain config show`. It is genuinely binding on
 * production brains (shortest page ever extracted: 523 / 524 / 500 across the
 * fleet), so a brain whose corpus skews short had no way to reach its own
 * material short of a redeploy.
 *
 * These tests pin the contract:
 *   - Unconfigured brains keep the historical 500 EXACTLY (>= 500, not > 500),
 *     so upstream behaviour is unchanged.
 *   - A configured value overrides it, in BOTH SQL sites that bind the floor
 *     (discoverExtractablePages and countExtractAtomsBacklog). If those two
 *     ever disagree, the doctor backlog count lies about what the phase will do.
 *   - A junk value fails soft back to 500 rather than wedging discovery.
 *   - The override does not leak across tests. Config lives in the `config`
 *     table, which resetPgliteState TRUNCATEs, so isolation is structural:
 *     each test sets what it needs and the reset clears it. `restores the
 *     default once the override is cleared` asserts that rather than assuming it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  discoverExtractablePages,
  countExtractAtomsBacklog,
  resolveMinPageChars,
} from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const MIN_PAGE_CHARS_KEY = 'cycle.extract_atoms.min_page_chars';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Seed an extractable page whose compiled_truth is exactly `chars` long. */
async function seedPageOfLength(slug: string, chars: number): Promise<void> {
  await engine.putPage(
    slug,
    {
      type: 'meeting' as never,
      title: slug,
      compiled_truth: 'a'.repeat(chars),
      timeline: '',
      frontmatter: {},
      content_hash: `hash-for-${slug}`,
    },
    { sourceId: 'default' },
  );
}

describe('cycle.extract_atoms.min_page_chars: default', () => {
  test('resolves to 500 when unset', async () => {
    expect(await resolveMinPageChars(engine)).toBe(500);
  });

  test('discovery admits exactly-500 and rejects 499 (>= boundary preserved)', async () => {
    await seedPageOfLength('meeting/at-floor', 500);
    await seedPageOfLength('meeting/below-floor', 499);

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map(d => d.slug)).toEqual(['meeting/at-floor']);
  });

  test('backlog count uses the same 500 default as discovery', async () => {
    await seedPageOfLength('meeting/at-floor', 500);
    await seedPageOfLength('meeting/below-floor', 499);

    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    // Brain-wide (doctor) form binds the floor as $2 rather than $3; both
    // must land on the same number or the doctor misreports the backlog.
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
  });
});

describe('cycle.extract_atoms.min_page_chars: configured override', () => {
  test('a lower value makes previously-skipped short pages discoverable', async () => {
    await seedPageOfLength('meeting/short', 200);
    await seedPageOfLength('meeting/long', 800);

    // Default: the short page is invisible.
    expect((await discoverExtractablePages(engine, 'default')).map(d => d.slug))
      .toEqual(['meeting/long']);

    await engine.setConfig(MIN_PAGE_CHARS_KEY, '100');
    expect(await resolveMinPageChars(engine)).toBe(100);

    // No re-run, no backfill: sub-floor pages never got an atoms_scan_hash,
    // so lowering the floor is retroactive on the very next discovery.
    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map(d => d.slug).sort()).toEqual(['meeting/long', 'meeting/short']);
  });

  test('a higher value excludes pages the default would have admitted', async () => {
    await seedPageOfLength('meeting/mid', 600);
    await engine.setConfig(MIN_PAGE_CHARS_KEY, '1000');

    expect(await discoverExtractablePages(engine, 'default')).toEqual([]);
  });

  test('backlog count honors the override too (doctor agrees with the phase)', async () => {
    await seedPageOfLength('meeting/short', 200);
    await seedPageOfLength('meeting/long', 800);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);

    await engine.setConfig(MIN_PAGE_CHARS_KEY, '100');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(2);
    expect(await countExtractAtomsBacklog(engine)).toBe(2);
  });

  test('restores the default once the override is cleared (no cross-test leak)', async () => {
    await engine.setConfig(MIN_PAGE_CHARS_KEY, '100');
    expect(await resolveMinPageChars(engine)).toBe(100);

    await engine.unsetConfig(MIN_PAGE_CHARS_KEY);
    expect(await resolveMinPageChars(engine)).toBe(500);
  });
});

describe('cycle.extract_atoms.min_page_chars: bad values fail soft', () => {
  test.each([
    ['not-a-number', 'nonsense'],
    ['0', 'zero'],
    ['-250', 'negative'],
    ['', 'empty string'],
  ])('%s (%s) falls back to 500', async (value) => {
    await engine.setConfig(MIN_PAGE_CHARS_KEY, value);
    expect(await resolveMinPageChars(engine)).toBe(500);
  });

  test('a fractional value floors to a whole char count', async () => {
    await engine.setConfig(MIN_PAGE_CHARS_KEY, '250.9');
    expect(await resolveMinPageChars(engine)).toBe(250);
  });

  test('a throwing getConfig falls back to 500 rather than wedging discovery', async () => {
    const throwing = {
      getConfig: async () => { throw new Error('synthetic config read failure'); },
    };
    expect(await resolveMinPageChars(throwing as never)).toBe(500);
  });
});

describe('cycle.extract_atoms.min_page_chars: registered as a known key', () => {
  test('appears in KNOWN_CONFIG_KEYS so `gbrain config set` accepts it', async () => {
    const { KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    expect(KNOWN_CONFIG_KEYS).toContain(MIN_PAGE_CHARS_KEY);
  });
});
