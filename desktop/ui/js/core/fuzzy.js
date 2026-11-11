/**
 * The command palette's matcher: a case-insensitive subsequence match that
 * scores contiguous runs and word starts higher, so "nt" finds "New terminal"
 * before "Paste image". The Android app's `FuzzyMatch.kt` is the same scorer.
 */

const WORD_BREAK = /[\s\-_:./\\()[\]]/;

/**
 * A score for [query] against [text], or null when the query is not a
 * subsequence of the text. Higher is better; an empty query scores 0.
 */
export function fuzzyScore(query, text) {
  const q = String(query ?? '').trim().toLowerCase();
  const t = String(text ?? '');
  if (!q) return 0;
  const lower = t.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue; // spaces in the query only separate words
    // Prefer the next occurrence that starts a word, if one is close by;
    // otherwise take the nearest one.
    let found = lower.indexOf(ch, ti);
    if (found < 0) return null;
    if (found !== prev + 1) {
      for (let k = found; k < lower.length; k++) {
        // Only jump when the rest of the query still fits after the jump.
        if (lower[k] === ch && isWordStart(t, k) && isSubsequence(q, qi + 1, lower, k + 1)) { found = k; break; }
        if (k - found > 24) break;
      }
    }
    const contiguous = found === prev + 1;
    run = contiguous ? run + 1 : 1;
    score += 1;
    if (contiguous) score += 4 + run;
    if (isWordStart(t, found)) score += 8;
    if (found === 0) score += 6;
    score -= Math.min(3, (found - ti) * 0.05);
    prev = found;
    ti = found + 1;
  }
  // Shorter labels win ties: "Paste" before "Paste image" for "paste".
  score -= t.length * 0.01;
  if (lower.startsWith(q)) score += 10;
  return score;
}

function isSubsequence(q, qi, lower, from) {
  let ti = from;
  for (let i = qi; i < q.length; i++) {
    if (q[i] === ' ') continue;
    const f = lower.indexOf(q[i], ti);
    if (f < 0) return false;
    ti = f + 1;
  }
  return true;
}

function isWordStart(text, i) {
  if (i === 0) return true;
  const before = text[i - 1];
  if (WORD_BREAK.test(before)) return true;
  // camelCase: a capital after a lower-case letter.
  const c = text[i];
  return c >= 'A' && c <= 'Z' && before >= 'a' && before <= 'z';
}

/**
 * Rank [items] by [label](item) against [query]: matches only, best first,
 * stable for equal scores, at most [limit]. An empty query keeps the order.
 */
export function fuzzyFilter(items, query, label = (x) => x.label, limit = 50) {
  const q = String(query ?? '').trim();
  if (!q) return items.slice(0, limit);
  const scored = [];
  items.forEach((item, index) => {
    const s = fuzzyScore(q, label(item));
    if (s != null) scored.push({ item, s, index });
  });
  scored.sort((a, b) => b.s - a.s || a.index - b.index);
  return scored.slice(0, limit).map((x) => x.item);
}
