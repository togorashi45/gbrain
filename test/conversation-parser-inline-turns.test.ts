/**
 * Fleet bug 4 — `conversation_format_coverage` false positive.
 *
 * Jake's box: the check samples up to 50 each of meeting/slack/email
 * (150-page denominator) and reports a 68% no-match rate. Two causes:
 *   1. `email` pages are single messages; they can never match a
 *      multi-turn conversation pattern. Including them in the sample
 *      guarantees a permanent penalty unrelated to parser quality.
 *   2. Granola `meeting` pages are raw JSON blobs with INLINE "Them:"/
 *      "Me:" speaker tags in one continuous paragraph, no per-turn line
 *      break. No built-in pattern (all line-anchored) can match that
 *      shape.
 */

import { describe, test, expect } from 'bun:test';
import {
  looksLikeInlineTurnConversation,
  normalizeInlineTurnConversation,
} from '../src/core/conversation-parser/normalize-inline-turns.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { CONVERSATION_FORMAT_COVERAGE_TYPES } from '../src/core/conversation-parser/types.ts';

// A realistic Granola export: one paragraph, inline speaker tags, no
// line breaks between turns.
const GRANOLA_INLINE = 'Them: So the renewal is coming up next month. Me: Right, I saw that on the calendar. Them: We should get ahead of it this time. Me: Agreed, I will send a note today.';

// A realistic single email page body. From/Date/Subject live in
// frontmatter (parsed out separately, per markdown.ts convention); the
// page body used for conversation-format scoring is what's left:
// compiled_truth, the message text itself, with no per-line speaker
// anchor of any kind. One message, no turns.
const EMAIL_BODY = `Hey, just flagging the renewal is coming up next month. Let's get ahead of it before the auto-renew date.`;

describe('looksLikeInlineTurnConversation', () => {
  test('detects two-or-more inline Them:/Me: tags', () => {
    expect(looksLikeInlineTurnConversation(GRANOLA_INLINE)).toBe(true);
  });

  test('does not false-trigger on a single incidental tag', () => {
    expect(looksLikeInlineTurnConversation('Them: hi there, nothing else here')).toBe(false);
    expect(looksLikeInlineTurnConversation('just some prose about them and me')).toBe(false);
  });

  test('does not false-trigger on word fragments (e.g. "Theme:")', () => {
    expect(looksLikeInlineTurnConversation('Theme: dark mode. Meta: v2.')).toBe(false);
  });
});

describe('normalizeInlineTurnConversation', () => {
  test('splits inline Them:/Me: turns onto their own lines', () => {
    const out = normalizeInlineTurnConversation(GRANOLA_INLINE).split('\n');
    expect(out).toEqual([
      'Them: So the renewal is coming up next month.',
      'Me: Right, I saw that on the calendar.',
      'Them: We should get ahead of it this time.',
      'Me: Agreed, I will send a note today.',
    ]);
  });

  test('is a no-op on content with fewer than 2 tags', () => {
    const prose = 'just a normal paragraph with no speaker tags at all';
    expect(normalizeInlineTurnConversation(prose)).toBe(prose);
  });
});

describe('parseConversation — Granola inline Them:/Me: shape (fleet bug 4)', () => {
  test('a raw Granola inline paragraph parses as a real conversation, not no_match', () => {
    const result = parseConversation(GRANOLA_INLINE, { noPolish: true, noFallback: true });
    expect(result.phase).not.toBe('no_match');
    expect(result.messages.length).toBe(4);
    expect(result.messages.map(m => m.speaker)).toEqual(['Them', 'Me', 'Them', 'Me']);
    expect(result.messages[0].text).toBe('So the renewal is coming up next month.');
    expect(result.messages[3].text).toBe('Agreed, I will send a note today.');
  });
});

describe('CONVERSATION_FORMAT_COVERAGE_TYPES — email exclusion (fleet bug 4 decision)', () => {
  test('email is NOT in the sampled type list — a single message can never match a conversation-turn pattern', () => {
    expect(CONVERSATION_FORMAT_COVERAGE_TYPES).not.toContain('email');
  });

  test('a realistic single-email body structurally cannot match any built-in conversation pattern', () => {
    // This is exactly why `email` doesn't belong in the sampled set: it's
    // not a parser gap, it's a category mismatch. Confirmed here so the
    // exclusion decision is falsifiable, not just assumed.
    const result = parseConversation(EMAIL_BODY, { noPolish: true, noFallback: true });
    expect(result.phase).toBe('no_match');
  });
});

describe('conversation_format_coverage — simulated check math (fleet bug 4 false positive)', () => {
  // Mirrors doctor.ts's own computation: sample pages of each allowed
  // type, parseConversation each with noPolish/noFallback, count
  // unmatched, warn above 10%. Run in-process (no DB, no subprocess) so
  // this stays fast while still proving the real arithmetic.
  function unmatchedPct(bodies: string[]): number {
    let unmatched = 0;
    for (const body of bodies) {
      const r = parseConversation(body, { noPolish: true, noFallback: true });
      if (r.phase === 'no_match') unmatched++;
    }
    return (unmatched / bodies.length) * 100;
  }

  test(
    'old sample (3 meetings + 2 emails, pre-fix pattern set) breaches the ' +
    '10% warn threshold even though the meetings are legitimate content',
    () => {
      // Same 3 real Granola-shaped meeting bodies + 2 real single-email
      // bodies. Both categories fail: meetings for lack of a built-in
      // pattern (bug 4b, now fixed), emails structurally (bug 4a).
      const oldSample = [GRANOLA_INLINE, GRANOLA_INLINE, GRANOLA_INLINE, EMAIL_BODY, EMAIL_BODY];
      // The meetings match now that the built-in pattern exists — the
      // remaining failures are 100% attributable to email, which is
      // exactly the point: email being in the sample is what breaches
      // the threshold, not a real parser gap.
      expect(unmatchedPct(oldSample)).toBeGreaterThan(10);
    },
  );

  test('post-fix sample (meetings only, email excluded) matches cleanly', () => {
    const newSample = [GRANOLA_INLINE, GRANOLA_INLINE, GRANOLA_INLINE];
    expect(unmatchedPct(newSample)).toBe(0);
  });
});
