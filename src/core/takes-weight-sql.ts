/**
 * float4 weight comparisons, in one place.
 *
 * `takes.weight` is declared REAL (float4). A bare SQL predicate like
 * `weight >= 0.7` does NOT do what it reads like it does. Postgres has no
 * `real >= numeric` operator, so both sides widen to float8. The stored
 * float4 0.7 widens to 0.699999988079071 while the literal 0.7 stays
 * 0.7, and the row is silently dropped. Same trap for 0.3, 0.6, 0.8, 0.9
 * and every other value that has no exact binary representation. Only
 * values on the /2^n grid (0.5, 0.25, 0.75) survive the widening.
 *
 * The effect is a silent undercount of exactly the rows an operator cares
 * about most: takes recorded at the round threshold. `takes add --weight 0.7`
 * writes a take that `weight >= 0.7` then refuses to see.
 *
 * The fix is to cast the LITERAL down to real instead of casting the column
 * up. `weight >= 0.7::real` compares float4 to float4, so the stored value
 * and the threshold round identically and the boundary row is included.
 * Casting the column instead (`weight::numeric >= 0.7`) is also correct but
 * throws away `idx_takes_weight_active ON takes(weight DESC) WHERE active`,
 * so every high-conviction query would go to a scan. Do not "simplify" the
 * `::real` back out.
 *
 * NOTE ON HISTORY: commit e92bfd4d's message claims this was already fixed.
 * It was not. Both known sites still carried the bare literal until
 * v0.42.72.0+rspur.1.
 */

/** Conviction floor for "high-conviction take". */
export const HIGH_CONVICTION_WEIGHT = 0.7;

/** Lower bound of the drift-eligible conviction band. */
export const DRIFT_BAND_MIN_WEIGHT = 0.3;

/** Upper bound of the drift-eligible conviction band. */
export const DRIFT_BAND_MAX_WEIGHT = 0.85;

function literal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`weight threshold must be finite, got ${value}`);
  }
  return `${value}::real`;
}

/**
 * `<column> >= <value>` with the literal rounded to float4 so a stored
 * value equal to `value` is included.
 */
export function weightGte(column: string, value: number): string {
  return `${column} >= ${literal(value)}`;
}

/**
 * `<column> <= <value>` with the literal rounded to float4 so a stored
 * value equal to `value` is included.
 */
export function weightLte(column: string, value: number): string {
  return `${column} <= ${literal(value)}`;
}
