/**
 * Matching for the graph search panel ("Ctrl-F for buildings").
 * Pure — the panel builds display-name candidates via i18n helpers and
 * delegates filtering/ranking here.
 */

export interface SearchCandidate {
  /** Flow node id (bin / building-instance / sink id). */
  id: string;
  /** Primary display name — the card's headline item name. */
  label: string;
  /** Secondary display name — usually the facility name. */
  sublabel?: string;
}

/**
 * Case-insensitive substring filter with simple ranking:
 * label-prefix matches first, then label-substring, then
 * sublabel-substring. Ties keep candidate order (stable). Empty or
 * whitespace-only queries match nothing.
 */
export function filterSearchCandidates(
  candidates: SearchCandidate[],
  query: string,
  limit = 8,
): SearchCandidate[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const rank = (c: SearchCandidate): number => {
    const label = c.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    if (c.sublabel && c.sublabel.toLowerCase().includes(q)) return 2;
    return -1;
  };

  return candidates
    .map((candidate, index) => ({ candidate, index, rank: rank(candidate) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
