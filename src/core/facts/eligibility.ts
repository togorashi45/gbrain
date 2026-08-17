/**
 * v0.31.2 — facts backstop eligibility predicate.
 *
 * Single source of truth for "should this page write fire the facts
 * extraction backstop?" Used by:
 *   - put_page (operations.ts:556 — MCP backstop hook)
 *   - sync.ts post-import hook
 *   - file_upload + code_import callers
 *   - extract_facts MCP op (negative path: returns 'eligibility_failed' so
 *     the caller sees a stable reason)
 *
 * Pre-extraction (PR1 commit 5), this lived inline at operations.ts:633
 * and sync.ts had its own divergent type filter (`['conversation',
 * 'transcript', 'personal', 'therapy', 'call']` — only `meeting` was a
 * real PageType, the rest never matched). Sync's filter is deleted in
 * commit 7; everyone routes through this predicate.
 *
 * Eligible:
 *   - parsed is non-null
 *   - slug does NOT start with `wiki/agents/` (subagent scratch is its
 *     own world; not user-meaningful for hot memory)
 *   - frontmatter.dream_generated is NOT `true` (anti-loop: never extract
 *     from dream-generated pages — they're already a digest)
 *   - body length >= 80 chars (skip TODO-style snippets)
 *   - parsed.type ∈ {note, meeting, slack, email, calendar-event, source, writing}
 *     OR slug.startsWith('meetings/' | 'personal/' | 'daily/')
 *     (the slug-prefix branch is a "rescue" — a meetings/2026-05-09-foo.md
 *      page that frontmatter-typed itself as 'note' should still get facts
 *      extracted; the directory says it's a meeting regardless of the
 *      legacy frontmatter type. Test fixtures cover all four combinations.)
 *
 * Reasons returned for the skipped envelope are stable strings consumed
 * by tests and observability (the doctor's facts_extraction_health check
 * groups by reason).
 */

import type { PageType } from '../types.ts';

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

/**
 * Path prefixes that rescue a page even when frontmatter type is not
 * eligible. A `meetings/2026-05-09-foo.md` page typed as 'note' (the
 * legacy default) still extracts because the directory tells us it's
 * conversation-shape.
 */
const RESCUE_SLUG_PREFIXES = ['meetings/', 'personal/', 'daily/'] as const;

// v0.41.22 (T21, codex F-ELIGIBLE finding): UNION of gbrain-base's hardcoded
// types AND gbrain-base-v2's canonical extractable types. Pre-rebase plan
// deferred pack-aware ELIGIBLE_TYPES to v0.43+; codex outside voice caught
// it as a blocker — changing the default taxonomy to gbrain-base-v2 while
// `eligibility.ts:49` hardcodes only gbrain-base's types means post-unify
// `media` (subtype: article), `tweet`, `atom`, `analysis` pages would
// silently drop out of facts extraction.
//
// `concept` is DELIBERATELY excluded: v0.41.11 documented its `extractable:
// true` flag in gbrain-base.yaml as "cosmetic on the backstop path because
// backstop uses hardcoded ELIGIBLE_TYPES" and the pre-existing test suite
// pins `kind:concept` rejection. Concept extraction stays out of the
// backstop; the schema-pack flag remains a forward-compatibility marker.
//
// The union here is safe for both packs:
//   - gbrain-base brains: all original types still eligible (back-compat)
//   - gbrain-base-v2 brains: post-unify canonical types also eligible
//
// Pack-aware async lookup via extractableTypesFromPack(pack) deferred to
// v0.43+ once an async eligibility-check signature is feasible across all
// call sites (operations.ts + import-file.ts + others).
const ELIGIBLE_TYPES: PageType[] = [
  // gbrain-base (legacy) types
  'note', 'meeting', 'slack', 'email', 'calendar-event', 'source', 'writing',
  // gbrain-base-v2 canonical types declared extractable in the pack
  // (concept deliberately omitted — see above)
  'media', 'tweet', 'atom', 'analysis',
];

const MIN_BODY_CHARS = 80;

/**
 * Types the ACTIVE pack explicitly declares `extractable: false`, or null when
 * the pack is not resolvable synchronously.
 *
 * Why this exists: a pack could already say `extractable: false` on a type and
 * this predicate ignored it, so the flag stopped atom extraction (which does
 * resolve the pack) while facts extraction kept running. On one brain that meant
 * `email` was declared non-extractable on 2026-08-03, with a written rationale
 * of "searchable, never extractable", and facts extraction still mined 30,604
 * email pages for another two weeks against the configured chat model. The flag
 * that exists to express "do not extract this" was honored by one pipeline and
 * silently ignored by the other.
 *
 * Why it is SUBTRACTIVE and not a replacement: see
 * `nonExtractableTypesFromPack`. `ELIGIBLE_TYPES` below holds types no pack
 * declares (`slack`, `atom`, `source`, …); switching to the pack's additive
 * extractable set would drop all of them.
 *
 * Why it is SYNCHRONOUS: the v0.41.22 note above deferred this to v0.43+ "once
 * an async eligibility-check signature is feasible across all call sites."
 * That is not needed. `tryCachedPack` is a synchronous read of the in-process
 * pack cache, and both real call sites (`operations.ts` put_page and
 * `facts/backstop.ts`) run in a process that has already resolved the pack, so
 * the cache is warm. No call-site signature changes.
 *
 * Fail-OPEN by design: a cold cache, absent config, or any throw returns null
 * and eligibility falls back to exactly the previous behavior. A pack problem
 * must never silently stop facts extraction, which is the same class of bug
 * this change fixes.
 */
let _exclusionCache: { name: string; types: Set<string>; atMs: number } | null = null;
const EXCLUSION_TTL_MS = 60_000;

function packNonExtractableTypes(): Set<string> | null {
  try {
    // All imports are sync. Kept inside the function so a config/pack failure
    // cannot break module load for callers that never reach this line.
    const { loadConfig, gbrainPath } = require('../config.ts') as typeof import('../config.ts');
    const { tryCachedPack } = require('../schema-pack/registry.ts') as typeof import('../schema-pack/registry.ts');
    const { nonExtractableTypesFromPack } = require('../schema-pack/extractable.ts') as typeof import('../schema-pack/extractable.ts');

    const packName = loadConfig()?.schema_pack;
    if (!packName) return null;

    if (_exclusionCache
      && _exclusionCache.name === packName
      && Date.now() - _exclusionCache.atMs < EXCLUSION_TTL_MS) {
      return _exclusionCache.types;
    }

    // Preferred: the in-process pack cache, already resolved with its full
    // `extends` chain.
    const resolved = tryCachedPack(packName);
    let types: Set<string> | null = resolved ? nonExtractableTypesFromPack(resolved.manifest) : null;

    // Fallback: read the pack off disk synchronously.
    //
    // This branch is load-bearing, not belt-and-braces. `tryCachedPack` is
    // empty in any process that has not already resolved the pack, and relying
    // on "something upstream probably warmed it" would reintroduce exactly the
    // failure being fixed: a declared exclusion that silently does not apply.
    // Measured on a live brain: warm returned pack_not_extractable:email, cold
    // returned ok:true for the same page.
    //
    // Leaf-only by design. `loadPackFromFile` does not walk `extends`, so this
    // path honors only what the ACTIVE pack declares itself. That is the
    // conservative direction: it can miss an inherited `extractable: false`,
    // but it can never invent an exclusion the operator did not write.
    if (!types) {
      const { loadPackFromFile } = require('../schema-pack/loader.ts') as typeof import('../schema-pack/loader.ts');
      const { join } = require('node:path') as typeof import('node:path');
      const { existsSync } = require('node:fs') as typeof import('node:fs');
      const path = join(gbrainPath(), 'schema-packs', packName, 'pack.yaml');
      if (!existsSync(path)) return null;
      types = nonExtractableTypesFromPack(loadPackFromFile(path));
    }

    _exclusionCache = { name: packName, types, atMs: Date.now() };
    return types;
  } catch {
    return null;
  }
}

/** Test seam: drop the memoized exclusion set. */
export function _resetPackExclusionCacheForTests(): void {
  _exclusionCache = null;
}

export function isFactsBackstopEligible(
  slug: string,
  parsed: { type: PageType; compiled_truth: string; frontmatter: Record<string, unknown> } | null | undefined,
): EligibilityResult {
  if (!parsed) return { ok: false, reason: 'no_parsed_page' };
  if (slug.startsWith('wiki/agents/')) return { ok: false, reason: 'subagent_namespace' };
  if (parsed.frontmatter && parsed.frontmatter.dream_generated === true) {
    return { ok: false, reason: 'dream_generated' };
  }

  const body = (parsed.compiled_truth ?? '').trim();
  if (body.length < MIN_BODY_CHARS) return { ok: false, reason: 'too_short' };

  // An explicit pack declaration outranks both the hardcoded allowlist and the
  // slug rescue. `meetings/`-shaped rescue exists to catch pages MIS-typed as
  // `note`; it must not resurrect a type the pack deliberately excluded.
  const packExcluded = packNonExtractableTypes();
  if (packExcluded?.has(parsed.type)) {
    return { ok: false, reason: `pack_not_extractable:${parsed.type}` };
  }

  const typeOk = ELIGIBLE_TYPES.includes(parsed.type);
  const slugOk = RESCUE_SLUG_PREFIXES.some(p => slug.startsWith(p));
  if (!typeOk && !slugOk) return { ok: false, reason: `kind:${parsed.type}` };

  return { ok: true };
}
