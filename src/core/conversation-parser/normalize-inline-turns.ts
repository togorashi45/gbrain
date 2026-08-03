/**
 * Inline-turn conversation normalizer (fleet bug 4).
 *
 * Granola exports a meeting transcript as raw JSON that lands in gbrain
 * as a single paragraph, one continuous block of text, with speaker
 * turns marked inline by literal `Them:` / `Me:` tags and NO line break
 * between turns:
 *
 *     Them: So the renewal is coming up next month. Me: Right, I saw
 *     that on the calendar. Them: We should get ahead of it this time.
 *
 * None of the built-in patterns in `builtins.ts` can match this shape:
 * every one of them anchors on `^` (start of line) and this is ONE line
 * with multiple turns crammed into it. Result: `phase: 'no_match'` for
 * every Granola meeting page shaped this way, which is most of them on
 * a box that ingests Granola.
 *
 * This collapses the inline tags onto their own lines — mirroring
 * `normalize-block.ts`'s approach for the Slack block-header shape — so
 * the existing line-anchored `granola-inline-me-them` built-in pattern
 * (see `builtins.ts`) can then match each turn.
 *
 * Strict no-op unless at least two `Them:`/`Me:` tags are present, so
 * already-canonical content (or prose that happens to contain one
 * incidental "Me:" or "Them:") passes through unchanged.
 */

// Word-boundary anchored so this never fires mid-word (e.g. "Theme:").
// Requires at least one space after the colon, matching the real export
// shape; a bare "Them:" with no trailing text isn't a turn worth
// splitting on.
const INLINE_TURN_TAG = /\b(?:Them|Me):\s/g;

/** True when the body has at least two inline Them:/Me: turn tags. */
export function looksLikeInlineTurnConversation(body: string): boolean {
  const matches = body.match(INLINE_TURN_TAG);
  return !!matches && matches.length >= 2;
}

/**
 * Split inline `Them:`/`Me:` turns onto their own lines. Returns `body`
 * unchanged when fewer than two turn tags are present.
 *
 * Implementation: split right before each tag (lookahead split keeps the
 * tag attached to the turn that follows it), then rejoin with newlines.
 * Any leading text before the first tag (a title, a summary line) is
 * preserved as its own leading segment — it never matched a pattern
 * anyway, same convention as `normalize-block.ts`.
 */
export function normalizeInlineTurnConversation(body: string): string {
  if (!looksLikeInlineTurnConversation(body)) return body;

  const parts = body.split(/(?=\b(?:Them|Me):\s)/g);
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');
}
