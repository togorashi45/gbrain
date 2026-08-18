// `autopilot.full_cycle_floor_min` — the per-source cadence knob.
//
// `autopilot.global_floor_min` already governed GLOBAL maintenance, but the
// per-source cycle floor was a hardcoded 60. A low-churn brain therefore had no
// way to slow its own cycles: one ran 25 cycles/day, each executing 14 phases
// (synthesize / patterns / consolidate / propose_takes / enrich_thin /
// schema-suggest are all LLM work) while every cycle total came back zero.

import { describe, expect, test } from 'bun:test';
import { isSourceStale, selectSourcesForDispatch } from '../src/commands/autopilot-fanout.ts';
import type { SourceRow } from '../src/core/engine.ts';

const NOW = Date.parse('2026-08-18T12:00:00Z');
const srcAgedMin = (id: string, mins: number): SourceRow => ({
  id,
  config: { last_full_cycle_at: new Date(NOW - mins * 60_000).toISOString() },
} as unknown as SourceRow);

describe('per-source cycle floor', () => {
  test('default 60: a source cycled 90 min ago is stale', () => {
    expect(isSourceStale(srcAgedMin('a', 90), NOW)).toBe(true);
  });

  test('default 60: a source cycled 30 min ago is fresh', () => {
    expect(isSourceStale(srcAgedMin('a', 30), NOW)).toBe(false);
  });

  test('a raised floor holds back a source the default would dispatch', () => {
    const s = srcAgedMin('a', 90);
    expect(isSourceStale(s, NOW, 60)).toBe(true);    // hourly: dispatch
    expect(isSourceStale(s, NOW, 360)).toBe(false);  // 6-hourly: hold
  });

  test('selectSourcesForDispatch honors the raised floor', () => {
    const sources = [srcAgedMin('default', 90), srcAgedMin('slack', 400)];
    const hourly = selectSourcesForDispatch(sources, 10, NOW, 60);
    expect(hourly.dispatch.map(s => s.id).sort()).toEqual(['default', 'slack']);

    const sixHourly = selectSourcesForDispatch(sources, 10, NOW, 360);
    // Only the 400-min-old source clears a 360-min floor.
    expect(sixHourly.dispatch.map(s => s.id)).toEqual(['slack']);
    expect(sixHourly.skippedFresh.map(s => s.id)).toEqual(['default']);
  });

  test('a never-cycled source dispatches at ANY floor', () => {
    // Guards the knob from starving a brand-new source.
    const fresh = { id: 'new', config: {} } as unknown as SourceRow;
    expect(isSourceStale(fresh, NOW, 10_000)).toBe(true);
  });
});
