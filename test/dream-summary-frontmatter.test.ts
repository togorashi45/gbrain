/**
 * Two writers can land a `dream-cycle-summaries/<date>` page:
 *
 *  1. the orchestrator's deterministic `writeSummaryPage`
 *  2. a synthesize subagent's `put_page` (that prefix is in the
 *     `dream_synthesize_paths` allow-list), whose row then only ever gets the
 *     frontmatter `stampDreamProvenance` writes
 *
 * Writer 2 drifted on a production brain: 28 summary pages carried
 * `{dream_cycle_date, dream_generated, validate}` with both exemption keys
 * missing, so they warned forever in the doctor `raw_provenance` check.
 *
 * These tests pin BOTH writers to the shared helper and assert the doctor
 * check comes back clean either way.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { rawProvenanceCheck } from '../src/commands/doctor.ts';
import { stampDreamProvenance, writeSummaryPage } from '../src/core/cycle/synthesize.ts';
import {
  DREAM_SUMMARY_EXEMPT_REASON,
  dreamSummaryFrontmatter,
  ensureDreamSummaryExemption,
  isDreamSummarySlug,
} from '../src/core/cycle/dream-summary-frontmatter.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-summary-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('dream summary frontmatter helper', () => {
  test('carries all four keys', () => {
    expect(dreamSummaryFrontmatter('2026-07-01')).toEqual({
      dream_generated: true,
      dream_cycle_date: '2026-07-01',
      raw_trace_exempt: true,
      raw_trace_exempt_reason: DREAM_SUMMARY_EXEMPT_REASON,
    });
  });

  test('recognizes summary slugs only', () => {
    expect(isDreamSummarySlug('dream-cycle-summaries/2026-07-01')).toBe(true);
    expect(isDreamSummarySlug('wiki/personal/reflections/2026-07-01-x-abc123')).toBe(false);
  });

  test('ensureDreamSummaryExemption adds the exemption for summary slugs', () => {
    const patched = ensureDreamSummaryExemption('dream-cycle-summaries/2026-07-01', {
      dream_generated: true,
      dream_cycle_date: '2026-07-01',
    });
    expect(patched.raw_trace_exempt).toBe(true);
    expect(patched.raw_trace_exempt_reason).toBe(DREAM_SUMMARY_EXEMPT_REASON);
  });

  test('ensureDreamSummaryExemption is a no-op for other slugs', () => {
    const patch = { dream_generated: true, dream_cycle_date: '2026-07-01' };
    expect(ensureDreamSummaryExemption('wiki/originals/ideas/x', patch)).toEqual(patch);
  });
});

describe('writer 1: orchestrator writeSummaryPage', () => {
  test('writes a summary page that raw_provenance accepts', async () => {
    await writeSummaryPage(
      engine as unknown as BrainEngine,
      brainDir,
      'dream-cycle-summaries/2026-07-01',
      '2026-07-01',
      [],
      [{ jobId: 1, status: 'completed' }],
    );
    const page = await engine.getPage('dream-cycle-summaries/2026-07-01');
    const fm = page?.frontmatter as Record<string, unknown> | undefined;
    expect(fm?.dream_generated).toBe(true);
    expect(fm?.dream_cycle_date).toBe('2026-07-01');
    expect(fm?.raw_trace_exempt).toBe(true);
    expect(fm?.raw_trace_exempt_reason).toBe(DREAM_SUMMARY_EXEMPT_REASON);

    const check = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(check.status).toBe('ok');
  });
});

describe('writer 2: subagent put_page + provenance stamp', () => {
  test('a subagent-authored summary picks up the exemption from the stamp', async () => {
    // What the subagent actually wrote: its own frontmatter, no dream markers,
    // no exemption. `validate` is the key the real drifted pages carried and
    // that the orchestrator write never sets.
    await engine.putPage('dream-cycle-summaries/2026-06-28', {
      type: 'note',
      title: 'Dream cycle 2026-06-28',
      compiled_truth: '# Dream cycle 2026-06-28\n\n- [[wiki/originals/ideas/x]]\n',
      timeline: '',
      frontmatter: { validate: false },
    });

    // Before the stamp the page is not yet dream_generated, so the check
    // does not see it at all. Stamp it the way the orchestrator does.
    await stampDreamProvenance(
      engine as unknown as BrainEngine,
      [{ slug: 'dream-cycle-summaries/2026-06-28', source_id: 'default' }],
      '2026-06-28',
    );

    const page = await engine.getPage('dream-cycle-summaries/2026-06-28');
    const fm = page?.frontmatter as Record<string, unknown> | undefined;
    expect(fm?.dream_generated).toBe(true);
    expect(fm?.dream_cycle_date).toBe('2026-06-28');
    // The regression: these two were missing on all 28 production pages.
    expect(fm?.raw_trace_exempt).toBe(true);
    expect(fm?.raw_trace_exempt_reason).toBe(DREAM_SUMMARY_EXEMPT_REASON);
    // The subagent's own key survives; the stamp only adds.
    expect(fm?.validate).toBe(false);

    const check = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(check.status).toBe('ok');
  });

  test('the stamp does NOT exempt a non-summary subagent page', async () => {
    await engine.putPage('wiki/originals/ideas/2026-06-28-thing-abc123', {
      type: 'note',
      title: 'Thing',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
    });
    await stampDreamProvenance(
      engine as unknown as BrainEngine,
      [{ slug: 'wiki/originals/ideas/2026-06-28-thing-abc123', source_id: 'default' }],
      '2026-06-28',
    );
    const page = await engine.getPage('wiki/originals/ideas/2026-06-28-thing-abc123');
    const fm = page?.frontmatter as Record<string, unknown> | undefined;
    expect(fm?.raw_trace_exempt).toBeUndefined();
    // A reflection page genuinely has a source transcript, so it must keep
    // warning until raw_source is stamped. Blanket-exempting every dream
    // page would gut the check.
    const check = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(check.status).toBe('warn');
  });
});
