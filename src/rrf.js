const DEFAULT_K = 60;

function resultKey(result) {
  return result.filepath || result.displayPath || result.hash;
}

export function fuseRankedLists(lists, { k = DEFAULT_K } = {}) {
  const fused = new Map();
  for (const list of lists) {
    const listWeight = Number(list.weight ?? 1);
    list.results.forEach((result, index) => {
      const key = resultKey(result);
      if (!key) return;
      const rank = index + 1;
      const contribution = listWeight / (k + rank);
      const existing = fused.get(key) || {
        ...result,
        rrfScore: 0,
        contributions: [],
        lexicalRank: null,
        vectorRank: null,
      };
      existing.rrfScore += contribution;
      existing.contributions.push({
        source: list.source,
        collection: list.collection,
        rank,
        weight: listWeight,
        backendScore: Number(result.score || 0),
        contribution,
      });
      if (list.source === 'lexical') {
        existing.lexicalRank = existing.lexicalRank === null ? rank : Math.min(existing.lexicalRank, rank);
      }
      if (list.source === 'vector') {
        existing.vectorRank = existing.vectorRank === null ? rank : Math.min(existing.vectorRank, rank);
        if (Number.isFinite(result.lineStartHint)) existing.lineStartHint = result.lineStartHint;
        if (Number.isFinite(result.lineEndHint)) existing.lineEndHint = result.lineEndHint;
      }
      fused.set(key, existing);
    });
  }

  return [...fused.values()].sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    const aBest = Math.min(a.lexicalRank ?? Infinity, a.vectorRank ?? Infinity);
    const bBest = Math.min(b.lexicalRank ?? Infinity, b.vectorRank ?? Infinity);
    return aBest - bBest;
  });
}
