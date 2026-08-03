/**
 * Tests for the `links_extraction_lag` doctor check (v0.42.7, #1696; content
 * pre-scan fix, fleet finding on atomic + jeremiah).
 *
 * Hermetic PGLite. The check does a COUNT + countStalePagesForExtraction, and
 * (since the content pre-scan fix) a bounded listStalePagesForExtraction scan
 * whenever the raw stale count clears the warn/fail threshold. Seeded content
 * therefore matters now: pages with genuinely empty compiled_truth/timeline
 * and no frontmatter link fields are "scanned and empty," not backlog — the
 * exact case that used to cry wolf.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

/**
 * Bulk-insert N pages under a source; all start with links_extracted_at
 * NULL. `compiled_truth` is blank by default — a page with nothing in it,
 * the "scanned and empty" case the content pre-scan must not flag as
 * backlog. Pass `withLinks: true` to give every page a genuine wikilink so
 * the pre-scan finds real extractable content (the actual backlog case).
 */
async function seedPages(
  n: number,
  opts: { sourceId?: string; prefix?: string; withLinks?: boolean } = {},
): Promise<void> {
  const { sourceId = 'default', prefix = 'p', withLinks = false } = opts;
  // SQL expression so each row gets a distinct, regex-matching wikilink
  // target when withLinks is true.
  const compiledTruthExpr = withLinks ? `'[[people/somebody-' || $1 || g || ']]'` : `''`;
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
     SELECT $1 || '/' || g, $2, 'concept', 'T' || g, ${compiledTruthExpr}, '', '{}'::jsonb, $1 || 'h' || g, now(), now()
       FROM generate_series(1, $3) g`,
    [prefix, sourceId, n],
  );
}

describe('links_extraction_lag doctor check', () => {
  test('no pages → ok (not applicable)', async () => {
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('no pages');
  });

  test('<100 pages, no --source → ok (vacuous-skip)', async () => {
    await seedPages(50);
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('too few');
  });

  test('>100 pages, all genuinely un-extracted (real wikilinks) → warn (>20%)', async () => {
    await seedPages(120, { withLinks: true });
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('genuinely un-extracted');
    expect(c.message).toContain('gbrain extract --stale');
    expect((c.details as any).pct).toBe(100);
    expect((c.details as any).extractable_pct).toBe(100);
  });

  // Regression for the fleet finding: `stale` counting "not yet scanned" as
  // "has un-extracted edges" produced a warning that `extract --stale`
  // could not act on — verified on atomic (418/418 links, 325/325 timeline
  // entries, unchanged before/after; the warning only cleared because the
  // watermark got stamped). Pages with blank content have nothing to
  // extract; the check must say OK, not send the operator to run a no-op.
  test('>100 pages, all unscanned but genuinely EMPTY content → ok (no cry-wolf)', async () => {
    await seedPages(120); // withLinks: false — blank compiled_truth/timeline
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('nothing extractable');
    expect((c.details as any).pct).toBe(100); // raw watermark still says 100% stale
    expect((c.details as any).extractable).toBe(0);
    expect((c.details as any).estimated_extractable).toBe(0);
  });

  test('>100 pages, all stamped fresh → ok', async () => {
    await seedPages(120, { withLinks: true });
    await engine.executeRaw(`UPDATE pages SET links_extracted_at = now()`);
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Extraction current');
  });

  test('warn-only by default: 100% genuinely-stale does NOT fail without fail-pct', async () => {
    await seedPages(120, { withLinks: true });
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('warn'); // never 'fail' by default
  });

  test('GBRAIN_EXTRACTION_LAG_FAIL_PCT opts into hard fail on genuine backlog', async () => {
    await seedPages(120, { withLinks: true });
    await withEnv({ GBRAIN_EXTRACTION_LAG_FAIL_PCT: '50' }, async () => {
      const c = await checkLinksExtractionLag(engine);
      expect(c.status).toBe('fail');
      expect(c.message).toContain('fail threshold');
    });
  });

  test('GBRAIN_EXTRACTION_LAG_FAIL_PCT does NOT fire when the backlog is genuinely empty', async () => {
    await seedPages(120); // blank content — raw pct still 100%, but nothing to extract
    await withEnv({ GBRAIN_EXTRACTION_LAG_FAIL_PCT: '50' }, async () => {
      const c = await checkLinksExtractionLag(engine);
      expect(c.status).toBe('ok');
    });
  });

  test('GBRAIN_EXTRACTION_LAG_WARN_PCT raises the warn bar (genuine backlog)', async () => {
    // 10 of 120 stale (with real links) = ~8%. Default warn 20% → ok.
    // Lower to 5% → warn.
    await seedPages(120, { withLinks: true });
    await engine.executeRaw(`UPDATE pages SET links_extracted_at = now() WHERE slug NOT IN (SELECT slug FROM pages ORDER BY id LIMIT 10)`);
    const ok = await checkLinksExtractionLag(engine);
    expect(ok.status).toBe('ok');
    await withEnv({ GBRAIN_EXTRACTION_LAG_WARN_PCT: '5' }, async () => {
      const warn = await checkLinksExtractionLag(engine);
      expect(warn.status).toBe('warn');
    });
  });

  test('--source scope: small source with real links IS assessed (no vacuous-skip)', async () => {
    // 10 pages under source 'dept-x' — below the 100 floor, but explicit
    // --source means we assess it anyway (mirrors orphan_ratio).
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('dept-x', 'Dept X', '{}'::jsonb) ON CONFLICT DO NOTHING`);
    await seedPages(10, { sourceId: 'dept-x', prefix: 'dx', withLinks: true });
    const c = await checkLinksExtractionLag(engine, { sourceId: 'dept-x' });
    expect(c.status).toBe('warn'); // all 10 stale AND genuinely extractable
    expect(c.message).toContain("source 'dept-x'");
  });

  test('--source scope: small source with EMPTY content → ok (still no cry-wolf when scoped)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('dept-y', 'Dept Y', '{}'::jsonb) ON CONFLICT DO NOTHING`);
    await seedPages(10, { sourceId: 'dept-y', prefix: 'dy' });
    const c = await checkLinksExtractionLag(engine, { sourceId: 'dept-y' });
    expect(c.status).toBe('ok');
  });

  test('mixed backlog: only the pages with real content count toward extractable_pct', async () => {
    // 60 pages with links (genuine backlog) + 60 pages blank (nothing to
    // extract), all stale → raw pct 100%, but only half is genuine backlog.
    await seedPages(60, { withLinks: true, prefix: 'has' });
    await seedPages(60, { withLinks: false, prefix: 'empty' });
    const c = await checkLinksExtractionLag(engine);
    expect(c.status).toBe('warn'); // 50% still clears the 20% warn bar
    expect((c.details as any).pct).toBe(100);
    expect((c.details as any).extractable_pct).toBeCloseTo(50, 0);
  });

  test('pre-v112 brain (column missing) → ok (graceful)', async () => {
    await seedPages(120, { withLinks: true });
    // Simulate a pre-v112 brain by dropping the column.
    await engine.executeRaw(`ALTER TABLE pages DROP COLUMN links_extracted_at`);
    try {
      const c = await checkLinksExtractionLag(engine);
      expect(c.status).toBe('ok');
      expect(c.message).toContain('pre-v112');
    } finally {
      // Restore so resetPgliteState's TRUNCATE-only reset leaves a valid schema
      // for the next test (the column is re-added; data is wiped by beforeEach).
      await engine.executeRaw(`ALTER TABLE pages ADD COLUMN links_extracted_at TIMESTAMPTZ`);
    }
  });
});
