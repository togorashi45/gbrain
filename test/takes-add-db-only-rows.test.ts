/**
 * Regression: `gbrain takes add` must not overwrite DB-only takes.
 *
 * Takes written by `gbrain extract takes --from-pages` (and the consolidate
 * phase) live in the DB with no fence on disk. cmdAdd used to derive the next
 * row_num from the markdown fence alone, so on such a page it restarted at 1
 * and the engine's ON CONFLICT DO UPDATE silently replaced live rows. 14 takes
 * were destroyed this way on a production brain (2026-08-02); the loss was
 * invisible in the repo diff because the overwritten claims never had a fence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'companies/bootstrap-example';
const BOOTSTRAP = 'cli:takes-bootstrap-from-pages';

let engine: PGLiteEngine;
let pageId: number;
const tmpRoots: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = await engine.putPage(SLUG, {
    title: 'Bootstrap Example',
    type: 'company' as const,
    compiled_truth: 'A company page with no takes fence on disk.\n',
  });
  pageId = page.id;
  // DB-only takes: exactly what `extract takes --from-pages` produces. No
  // fence is ever written for these.
  await engine.addTakesBatch([
    { page_id: pageId, row_num: 1, claim: 'Bootstrap claim one', kind: 'fact', holder: 'world', weight: 0.8, source: BOOTSTRAP },
    { page_id: pageId, row_num: 2, claim: 'Bootstrap claim two', kind: 'take', holder: 'brain', weight: 0.6, source: BOOTSTRAP },
    { page_id: pageId, row_num: 3, claim: 'Bootstrap claim three', kind: 'take', holder: 'brain', weight: 0.5, source: BOOTSTRAP },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('takes add on a page whose takes are DB-only', () => {
  test('appends after MAX(row_num) in the DB instead of overwriting row 1', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-dbonly-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);

    // The page on disk has a body but NO takes fence — the trigger condition.
    const path = join(brainDir, `${SLUG}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# Bootstrap Example\n\nA company page with no takes fence on disk.\n', 'utf-8');

    await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add', SLUG,
        '--claim', 'Manually added claim',
        '--kind', 'take',
        '--who', 'brain',
        '--weight', '0.7',
        '--dir', brainDir,
      ]);
    });

    const takes = await engine.listTakes({ page_id: pageId });
    // Nothing was replaced: all three bootstrap claims survive verbatim.
    expect(takes).toHaveLength(4);
    const byRow = new Map(takes.map(t => [t.row_num, t]));
    expect(byRow.get(1)?.claim).toBe('Bootstrap claim one');
    expect(byRow.get(2)?.claim).toBe('Bootstrap claim two');
    expect(byRow.get(3)?.claim).toBe('Bootstrap claim three');
    expect(byRow.get(1)?.source).toBe(BOOTSTRAP);
    // The new take landed after them.
    expect(byRow.get(4)?.claim).toBe('Manually added claim');

    // Fence row number matches the DB row number, so the next extract-takes
    // pass upserts row 4 onto itself rather than colliding.
    const written = readFileSync(path, 'utf-8');
    expect(written).toContain('| 4 | Manually added claim |');
  });

  test("addTakesBatch conflict:'insert' skips an occupied row instead of updating it", async () => {
    const inserted = await engine.addTakesBatch([
      { page_id: pageId, row_num: 1, claim: 'Should never land', kind: 'take', holder: 'brain', weight: 0.1 },
    ], { conflict: 'insert' });
    expect(inserted).toBe(0);
    const takes = await engine.listTakes({ page_id: pageId });
    expect(takes.find(t => t.row_num === 1)?.claim).toBe('Bootstrap claim one');
  });
});
