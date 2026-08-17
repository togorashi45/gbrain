// v0.38 T7d: pack-driven facts-eligibility types.
//
// Pre-v0.38: src/core/facts/eligibility.ts hardcoded:
//   const ELIGIBLE_TYPES = ['note', 'meeting', 'slack', 'email',
//                            'calendar-event', 'source', 'writing']
// plus RESCUE_SLUG_PREFIXES = ['meetings/', 'personal/', 'daily/'].
//
// v0.38 T7d: the active schema pack declares which types are
// `extractable: true`. gbrain-base preserves the 7 legacy types so
// existing facts extraction behavior is byte-for-byte unchanged.
// User packs (research-state, legal, …) override by setting
// `extractable: true` on their domain-specific types — e.g. a paper
// pack marks `claim` and `finding` as extractable so the backstop
// fires on those pages.
//
// Usage (when callers wire this in Phase B):
//
//   const eligible = extractableTypesFromPack(activePack);
//   if (!eligible.has(parsed.type)) { ... }
//
// Until the wiring lands, legacy facts/eligibility.ts callers continue
// to use the hardcoded ELIGIBLE_TYPES list — which gbrain-base also
// declares, so behavior is preserved.

import type { SchemaPackManifest, ExtractableSpec } from './manifest-v1.ts';

/**
 * v0.42 widening: `extractable` may be `true | false | ExtractableSpec`.
 * Both `true` and a non-empty struct mean "this type is extractable."
 *
 * Pure predicate; reusable across all read sites.
 */
function isExtractable(extractable: boolean | ExtractableSpec): boolean {
  if (typeof extractable === 'boolean') return extractable;
  // Struct shape implies extractable = true (pack author wouldn't declare
  // prompt_template + fixtures + eval_dimensions for a non-extractable type).
  return true;
}

/**
 * Return the Set of type names the pack EXPLICITLY declares non-extractable,
 * including their aliases.
 *
 * This is the subtractive counterpart to `extractableTypesFromPack`, and it
 * exists because the two are not interchangeable at the facts-eligibility call
 * site. `facts/eligibility.ts` cannot simply switch to the additive set: its
 * hardcoded `ELIGIBLE_TYPES` list contains types that real packs never declare
 * at all (`slack`, `source`, `writing`, `media`, `tweet`, `atom`, `analysis`).
 * Replacing the list with pack-extractable types would silently drop every one
 * of those out of facts extraction. Subtracting only what a pack explicitly
 * marks `extractable: false` is the narrow, non-regressing change.
 *
 * Aliases are included because `inferType` and the query-closure layer treat an
 * alias as the same type, so a page can legitimately carry `type:
 * calendar-event` while the pack declares `event` with
 * `aliases: [calendar-event]`. Honoring the declaration without the aliases
 * would leave exactly those pages extracting.
 */
export function nonExtractableTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): Set<string> {
  const out = new Set<string>();
  for (const pt of pack.page_types) {
    if (isExtractable(pt.extractable)) continue;
    out.add(pt.name);
    for (const alias of pt.aliases ?? []) out.add(alias);
  }
  return out;
}

/**
 * Return the Set of pack-declared types with `extractable: true` OR
 * `extractable: <struct>`. Set return shape (vs array) because callers
 * want O(1) membership checks in the eligibility predicate, which fires
 * on every put_page.
 */
export function extractableTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): Set<string> {
  return new Set(
    pack.page_types
      .filter(pt => isExtractable(pt.extractable))
      .map(pt => pt.name),
  );
}

/**
 * Convenience predicate: is this type facts-extractable per the
 * active pack? Avoids creating a Set on every call when the caller
 * only has a manifest, not a precomputed Set.
 */
export function isExtractableType(
  pack: Pick<SchemaPackManifest, 'page_types'>,
  type: string,
): boolean {
  return pack.page_types.some(pt => pt.name === type && isExtractable(pt.extractable));
}

/**
 * v0.42 — Return a Map of type-name → ExtractableSpec for every
 * extractable type. Boolean `true` resolves to the default empty struct
 * (no prompt template, no fixtures, no eval dimensions). Pack authors who
 * want pack-supplied prompts + fixtures opt into the struct shape per
 * `ExtractableSpec`.
 *
 * Consumed by `gbrain extract benchmark`, `gbrain extract --explain`,
 * and `gbrain schema scaffold-extractable`.
 */
export function extractableSpecsFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): Map<string, ExtractableSpec> {
  const out = new Map<string, ExtractableSpec>();
  for (const pt of pack.page_types) {
    if (!isExtractable(pt.extractable)) continue;
    if (typeof pt.extractable === 'boolean') {
      // boolean true → empty default spec (back-compat)
      out.set(pt.name, { eval_dimensions: [] });
    } else {
      out.set(pt.name, pt.extractable);
    }
  }
  return out;
}

/**
 * v0.42 — Return the ExtractableSpec for a single type, or null if not
 * extractable. Convenience for read sites that only have one type name.
 */
export function getExtractableSpec(
  pack: Pick<SchemaPackManifest, 'page_types'>,
  type: string,
): ExtractableSpec | null {
  const pt = pack.page_types.find(p => p.name === type);
  if (!pt || !isExtractable(pt.extractable)) return null;
  if (typeof pt.extractable === 'boolean') return { eval_dimensions: [] };
  return pt.extractable;
}

/**
 * v0.42 — Forward-compat runtime gate for D-EXTRACT-37. A pack-supplied
 * `verifier_path` field is RESERVED in v0.42 — accepted at parse time,
 * REFUSED at runtime. Call this anywhere a runtime would attempt to load
 * pack-shipped verifier code.
 *
 * @throws Error with paste-ready message if verifier_path is set
 */
export function refuseVerifierPathInV042(
  spec: Pick<ExtractableSpec, 'verifier_path'>,
  typeName: string,
): void {
  if (spec.verifier_path) {
    throw new Error(
      `pack-shipped verifier code is not supported in v0.42 (type: ${typeName}, ` +
      `verifier_path: ${spec.verifier_path}). v0.43+ trust review is the gate ` +
      `for loading pack-shipped verifier scripts. Remove verifier_path from your ` +
      `pack manifest OR wait for v0.43 to land.`
    );
  }
}
