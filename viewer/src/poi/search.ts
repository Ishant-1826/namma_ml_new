/**
 * search.ts
 * Fuzzy, tokenized, ranked POI search engine.
 * Includes Damerau-Levenshtein typo tolerance and walking-distance tie breaking.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { NavGrid } from "../nav/navgrid";
import { POI } from "./poi_types";

/**
 * Calculates Damerau-Levenshtein distance between strings a and b.
 * Supports insertions, deletions, substitutions, and transpositions.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const d: number[][] = [];
  for (let i = 0; i <= al; i++) {
    d[i] = new Array(bl + 1);
    d[i][0] = i;
  }
  for (let j = 0; j <= bl; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost  // substitution
      );

      // Transposition of adjacent characters
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[al][bl];
}

/**
 * Normalizes a word by converting to lowercase, stripping non-alphanumeric chars,
 * and performing simple English plural stripping.
 */
export function normalizeToken(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  if (s.length > 4 && s.endsWith("ies")) {
    return s.slice(0, -3) + "y";
  }
  if (s.length > 4 && (s.endsWith("shes") || s.endsWith("ches") || s.endsWith("sses") || s.endsWith("xes"))) {
    return s.slice(0, -2);
  }
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) {
    return s.slice(0, -1);
  }
  return s;
}

/**
 * Tokenizes text into normalized unique tokens.
 */
export function tokenizeText(text: string): string[] {
  const rawTokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of rawTokens) {
    const norm = normalizeToken(t);
    if (norm) {
      out.add(norm);
    }
    // Also include the un-stemmed token if different
    const bare = t.replace(/[^a-z0-9]/g, "");
    if (bare && bare !== norm) {
      out.add(bare);
    }
  }
  return Array.from(out);
}

/**
 * Evaluates whether a query token matches a candidate token,
 * returning the match quality score (0 for no match).
 */
function matchTokenScore(q: string, target: string): number {
  if (!q || !target) return 0;
  if (q === target) return 100; // Exact match

  // Prefix match (query is prefix of target word, e.g. "recep" -> "reception")
  if (target.startsWith(q) && q.length >= 2) {
    return 75 + Math.min(20, (q.length / target.length) * 20);
  }

  // Typo tolerance: Damerau-Levenshtein
  // 4-6 letters: 1 edit; 7+ letters: 2 edits; <= 3 letters: exact only
  const wordLen = Math.max(q.length, target.length);
  const maxEdits = wordLen >= 7 ? 2 : wordLen >= 4 ? 1 : 0;
  if (maxEdits > 0) {
    const dist = damerauLevenshtein(q, target);
    if (dist <= maxEdits) {
      return 50 - dist * 10;
    }
  }

  return 0;
}

export interface SearchResult extends POI {
  poi: POI;
  score: number;
  walkingDistance?: number;
  pinDistance?: number;
}

/**
 * Searches and ranks POIs matching query text.
 * Ranked scoring: exact > prefix > alias > tag/category > fuzzy.
 * Returns all matching instances (e.g. searching "sofa" returns all sofas).
 * If originDistanceField is provided, ties in score are broken by walking distance,
 * else by pin distance if origin is provided.
 */
export function searchPOIs(
  query: string,
  pois: POI[],
  originDistanceField?: Float32Array,
  grid?: NavGrid,
  origin?: { x: number; z: number }
): SearchResult[] {
  const queryTokens = tokenizeText(query);
  if (queryTokens.length === 0 || pois.length === 0) {
    return [];
  }

  const rawQueryLower = query.toLowerCase().trim();
  const rawQueryNormalized = normalizeToken(rawQueryLower);

  const results: SearchResult[] = [];

  for (const poi of pois) {
    // 1. Check full exact string matches first
    const nameLower = poi.name.toLowerCase().trim();
    const catLower = poi.category.toLowerCase().trim();
    const catNorm = normalizeToken(catLower);

    let maxScore = 0;

    // Full exact name match
    if (nameLower === rawQueryLower || normalizeToken(nameLower) === rawQueryNormalized) {
      maxScore = Math.max(maxScore, 1000);
    }

    // Full exact category match (guarantees category query returns all instances)
    if (catLower === rawQueryLower || catNorm === rawQueryNormalized) {
      maxScore = Math.max(maxScore, 850);
    }

    // Full alias match
    for (const alias of poi.aliases) {
      const aLower = alias.toLowerCase().trim();
      if (aLower === rawQueryLower || normalizeToken(aLower) === rawQueryNormalized) {
        maxScore = Math.max(maxScore, 900);
      }
    }

    // Full tag match
    for (const tag of poi.tags) {
      const tLower = tag.toLowerCase().trim();
      if (tLower === rawQueryLower || normalizeToken(tLower) === rawQueryNormalized) {
        maxScore = Math.max(maxScore, 800);
      }
    }

    // 2. Tokenized multi-attribute evaluation
    const nameTokens = tokenizeText(poi.name);
    const catTokens = tokenizeText(poi.category);
    const aliasTokens = poi.aliases.flatMap((a) => tokenizeText(a));
    const tagTokens = poi.tags.flatMap((t) => tokenizeText(t));

    // For every query token, calculate the best match across all fields
    let allTokensMatched = true;
    let queryTokenScoreSum = 0;

    for (const qToken of queryTokens) {
      let bestQScore = 0;

      // Match against Name tokens (weight 1.0)
      for (const nToken of nameTokens) {
        const s = matchTokenScore(qToken, nToken);
        if (s > 0) bestQScore = Math.max(bestQScore, s * 7.0);
      }

      // Match against Category tokens (weight 0.9)
      for (const cToken of catTokens) {
        const s = matchTokenScore(qToken, cToken);
        if (s > 0) bestQScore = Math.max(bestQScore, s * 6.5);
      }

      // Match against Alias tokens (weight 0.85)
      for (const aToken of aliasTokens) {
        const s = matchTokenScore(qToken, aToken);
        if (s > 0) bestQScore = Math.max(bestQScore, s * 6.0);
      }

      // Match against Tag tokens (weight 0.75)
      for (const tToken of tagTokens) {
        const s = matchTokenScore(qToken, tToken);
        if (s > 0) bestQScore = Math.max(bestQScore, s * 5.5);
      }

      if (bestQScore === 0) {
        allTokensMatched = false;
        break;
      }
      queryTokenScoreSum += bestQScore;
    }

    if (allTokensMatched) {
      const avgScore = queryTokenScoreSum / queryTokens.length;
      maxScore = Math.max(maxScore, avgScore);
    }

    if (maxScore > 0) {
      // Calculate walking distance if distance field and grid are available
      let walkingDist: number | undefined;
      const navGrid = grid ?? (originDistanceField as unknown as { grid?: NavGrid })?.grid;

      if (originDistanceField && navGrid) {
        const cell = navGrid.worldToCell(poi.anchor.x, poi.anchor.z);
        if (navGrid.isValidCell(cell.col, cell.row)) {
          const d = originDistanceField[cell.row * navGrid.width + cell.col];
          if (isFinite(d)) {
            walkingDist = d;
          }
        }
      }

      const pinDist = origin ? Math.hypot(poi.position.x - origin.x, poi.position.z - origin.z) : undefined;

      results.push({
        ...poi,
        poi,
        score: maxScore,
        walkingDistance: walkingDist,
        pinDistance: pinDist,
      });
    }
  }

  // Rank sorting: score descending, tie-broken by walking distance, then pin distance, then name
  results.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-4) {
      return b.score - a.score;
    }
    // Tie-break by walking distance if available
    if (a.walkingDistance !== undefined && b.walkingDistance !== undefined) {
      if (Math.abs(a.walkingDistance - b.walkingDistance) > 1e-4) {
        return a.walkingDistance - b.walkingDistance;
      }
    } else if (a.walkingDistance !== undefined) {
      return -1;
    } else if (b.walkingDistance !== undefined) {
      return 1;
    }

    // Tie-break by pin distance if available
    if (a.pinDistance !== undefined && b.pinDistance !== undefined) {
      if (Math.abs(a.pinDistance - b.pinDistance) > 1e-4) {
        return a.pinDistance - b.pinDistance;
      }
    } else if (a.pinDistance !== undefined) {
      return -1;
    } else if (b.pinDistance !== undefined) {
      return 1;
    }

    return a.name.localeCompare(b.name);
  });

  return results;
}
