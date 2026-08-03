/**
 * Dream-cycle summary frontmatter, constructed in exactly one place.
 *
 * WHY THIS MODULE EXISTS
 *
 * There are TWO writers that can land a page at `dream-cycle-summaries/<date>`:
 *
 *  1. The deterministic orchestrator write, `writeSummaryPage` in
 *     synthesize.ts. It builds the index from `writtenRefs` and stamps the
 *     full marker set.
 *  2. The synthesize SUBAGENT's `put_page`. `dream-cycle-summaries/*` is one
 *     of the prefixes in the `dream_synthesize_paths` allow-list (see
 *     skills/migrations/v0.23.0.md), so a child can write that slug itself.
 *     The child then gets `dream_generated` + `dream_cycle_date` stamped onto
 *     its row by `stampDreamProvenance`, and nothing else.
 *
 * Writer 2 produced a real drift on a production brain: 28
 * `dream-cycle-summaries/*` pages carried only
 * `{dream_cycle_date, dream_generated, validate}`. Two of writer 1's keys,
 * both exemption keys missing, plus a `validate` key writer 1 never sets.
 * `created_at` was 2026-08-01 while `dream_cycle_date` spanned 2026-06-28 to
 * 2026-07-10, so it was a backfill run, not the live cycle. Without
 * `raw_trace_exempt` those pages then warn forever in the doctor
 * `raw_provenance` check, because a deterministic index has no source
 * document of its own to point at.
 *
 * The fix is structural, not a second copy of the literal. Both writers now
 * derive their frontmatter from `dreamSummaryFrontmatter` here, and the
 * provenance stamp routes summary slugs through
 * `ensureDreamSummaryExemption` so a subagent-authored summary picks up the
 * exemption in the same UPDATE that stamps the dream markers. Add a key here
 * and both paths get it. There is nowhere else to add one.
 */

/** Slug prefix reserved for dream-cycle index pages. */
export const DREAM_SUMMARY_SLUG_PREFIX = 'dream-cycle-summaries/';

/**
 * The one exemption reason string. A dream-cycle index is derived purely
 * from the pages it lists, so it has no raw source of its own; the raw
 * traces live on those listed pages.
 */
export const DREAM_SUMMARY_EXEMPT_REASON =
  'deterministic dream-cycle index; raw traces live on listed pages';

/** True for a dream-cycle summary page slug. */
export function isDreamSummarySlug(slug: string): boolean {
  return slug.startsWith(DREAM_SUMMARY_SLUG_PREFIX);
}

/**
 * The canonical frontmatter for a dream-cycle summary page. Every key a
 * summary must carry, in one object literal.
 */
export function dreamSummaryFrontmatter(cycleDate: string): Record<string, unknown> {
  return {
    dream_generated: true,
    dream_cycle_date: cycleDate,
    // #1978: deterministic index page, no source document of its own.
    // Explicit exemption keeps the doctor raw_provenance check quiet.
    raw_trace_exempt: true,
    raw_trace_exempt_reason: DREAM_SUMMARY_EXEMPT_REASON,
  };
}

/**
 * Merge the exemption keys into a frontmatter patch when the slug is a
 * dream-cycle summary. No-op for every other slug, so callers can route all
 * their writes through this without special-casing.
 *
 * Existing keys on the patch win, so a caller that already set the full set
 * (writer 1) is unchanged, and a caller that set none (writer 2) gets them.
 */
export function ensureDreamSummaryExemption(
  slug: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!isDreamSummarySlug(slug)) return patch;
  return {
    raw_trace_exempt: true,
    raw_trace_exempt_reason: DREAM_SUMMARY_EXEMPT_REASON,
    ...patch,
  };
}
