/**
 * Regression: a take stored at exactly the threshold weight must be counted.
 *
 * `takes.weight` is REAL (float4). `weight >= 0.7` widens both sides to
 * float8, where the stored value is 0.699999988079071 and the literal is
 * 0.7, so the boundary row was silently dropped. That undercounted
 * high-conviction takes in `doctor abandoned_threads` and in the
 * serve-http abandoned-threads ship-state endpoint.
 *
 * A commit message on master (e92bfd4d) claimed this was fixed. It was not.
 * These tests pin the real behavior against a real Postgres (PGlite).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkAbandonedThreads } from '../src/commands/doctor.ts';
import {
  HIGH_CONVICTION_WEIGHT,
  DRIFT_BAND_MAX_WEIGHT,
  DRIFT_BAND_MIN_WEIGHT,
  weightGte,
  weightLte,
} from '../src/core/takes-weight-sql.ts';

let engine: PGLiteEngine;
let pageId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = await engine.putPage('companies/float4-boundary', {
    title: 'Float4 Boundary',
    type: 'company' as const,
    compiled_truth: 'Boundary weights.\n',
  });
  pageId = page.id;
  await engine.addTakesBatch([
    // Exactly at the high-conviction floor. This is the row that vanished.
    { page_id: pageId, row_num: 1, claim: 'Exactly seven tenths', kind: 'take', holder: 'brain', weight: 0.7, source: 'test' },
    // Just under. Must stay excluded. 0.65 not 0.69: buildTakeRows snaps
    // weight to the 0.05 grid, so 0.69 would land back on 0.7.
    { page_id: pageId, row_num: 2, claim: 'Just under', kind: 'take', holder: 'brain', weight: 0.65, source: 'test' },
    // Exactly at both drift-band edges.
    { page_id: pageId, row_num: 3, claim: 'Drift band floor', kind: 'take', holder: 'brain', weight: 0.3, source: 'test' },
    { page_id: pageId, row_num: 4, claim: 'Drift band ceiling', kind: 'take', holder: 'brain', weight: 0.85, source: 'test' },
  ]);
  // since_date is what abandoned_threads filters on. Backdate row 1 and row 2
  // past the 12 month window so only the weight predicate decides.
  await engine.executeRaw(
    `UPDATE takes SET since_date = '2020-01' WHERE page_id = $1 AND row_num IN (1, 2)`,
    [pageId],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('float4 weight threshold', () => {
  test('the bare literal form is the bug: it drops rows stored at the threshold', async () => {
    const bare = await engine.executeRaw<{ claim: string }>(
      `SELECT claim FROM takes WHERE page_id = $1 AND weight >= 0.7 ORDER BY row_num`,
      [pageId],
    );
    // 0.7 and 0.85 both qualify on paper. The bare form sees only 0.85.
    // Documents WHY the helper exists. If Postgres ever changes this, the
    // helper is still correct and this assertion is the one to revisit.
    expect(bare.map(r => r.claim)).toEqual(['Drift band ceiling']);
  });

  test('weightGte includes a take stored at exactly the threshold', async () => {
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes
         WHERE page_id = $1 AND ${weightGte('weight', HIGH_CONVICTION_WEIGHT)}`,
      [pageId],
    );
    expect(rows[0]?.count).toBe(2);
  });

  test('weightGte still excludes a take below the threshold', async () => {
    const rows = await engine.executeRaw<{ claim: string }>(
      `SELECT claim FROM takes
         WHERE page_id = $1 AND ${weightGte('weight', HIGH_CONVICTION_WEIGHT)}`,
      [pageId],
    );
    expect(rows.map(r => r.claim).sort()).toEqual(['Drift band ceiling', 'Exactly seven tenths']);
  });

  test('weightGte and weightLte include both drift-band edges', async () => {
    const rows = await engine.executeRaw<{ claim: string }>(
      `SELECT claim FROM takes
         WHERE page_id = $1
           AND ${weightGte('weight', DRIFT_BAND_MIN_WEIGHT)}
           AND ${weightLte('weight', DRIFT_BAND_MAX_WEIGHT)}
         ORDER BY row_num`,
      [pageId],
    );
    // The band is inclusive at both ends, so every seeded row qualifies.
    // The point of the assertion is that both EDGE rows (0.3 and 0.85) are
    // present. Those two happen to survive the bare form as well, because
    // float4 rounds 0.3 up and 0.85 down. That is luck, not correctness,
    // and it flips the moment a threshold changes.
    expect(rows.map(r => r.claim)).toEqual([
      'Exactly seven tenths',
      'Just under',
      'Drift band floor',
      'Drift band ceiling',
    ]);
  });

  // Also pins a second bug found while writing this test: the doctor query
  // cast month-precision since_date straight to date, so ANY brain with a
  // `--since YYYY-MM` take turned the whole check into a warn.
  test('doctor abandoned_threads counts the exactly-0.7 take', async () => {
    const check = await checkAbandonedThreads(engine);
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('No abandoned high-conviction threads');
    expect(check.message).toContain('1');
  });
});
