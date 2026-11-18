// Sequence alignment over string keys: patience diff (unique anchors), falling
// back to an LCS table for small unmatched regions and a plain replace for
// large ones, so memory stays bounded on very different inputs.

export type OpKind = 'equal' | 'delete' | 'insert' | 'replace';

export interface DiffOp {
  kind: OpKind;
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
}

const LCS_LIMIT = 4_000_000;

export function diffSequences(a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  const push = (kind: OpKind, aStart: number, aLen: number, bStart: number, bLen: number) => {
    if (aLen === 0 && bLen === 0) return;
    if (kind !== 'equal') {
      kind = aLen === 0 ? 'insert' : bLen === 0 ? 'delete' : 'replace';
    }
    const last = ops.at(-1);
    if (last && (last.kind === kind || (kind !== 'equal' && last.kind !== 'equal'))) {
      // Merge adjacent ops of the same family.
      if (last.aStart + last.aLen === aStart && last.bStart + last.bLen === bStart) {
        last.aLen += aLen;
        last.bLen += bLen;
        if (last.kind !== 'equal') last.kind = last.aLen === 0 ? 'insert' : last.bLen === 0 ? 'delete' : 'replace';
        return;
      }
    }
    ops.push({ kind, aStart, aLen, bStart, bLen });
  };
  region(a, b, 0, a.length, 0, b.length, push);
  return ops;
}

type Push = (kind: OpKind, aStart: number, aLen: number, bStart: number, bLen: number) => void;

function region(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, push: Push): void {
  // Common prefix and suffix.
  let p = 0;
  while (a0 + p < a1 && b0 + p < b1 && a[a0 + p] === b[b0 + p]) p++;
  let s = 0;
  while (a1 - s > a0 + p && b1 - s > b0 + p && a[a1 - 1 - s] === b[b1 - 1 - s]) s++;
  push('equal', a0, p, b0, p);
  const ia0 = a0 + p, ia1 = a1 - s, ib0 = b0 + p, ib1 = b1 - s;
  if (ia0 === ia1 || ib0 === ib1) {
    push('replace', ia0, ia1 - ia0, ib0, ib1 - ib0);
  } else {
    const anchors = uniqueAnchors(a, b, ia0, ia1, ib0, ib1);
    if (anchors.length > 0) {
      let ca = ia0, cb = ib0;
      for (const [x, y] of anchors) {
        region(a, b, ca, x, cb, y, push);
        push('equal', x, 1, y, 1);
        ca = x + 1;
        cb = y + 1;
      }
      region(a, b, ca, ia1, cb, ib1, push);
    } else if ((ia1 - ia0) * (ib1 - ib0) <= LCS_LIMIT) {
      lcs(a, b, ia0, ia1, ib0, ib1, push);
    } else {
      push('replace', ia0, ia1 - ia0, ib0, ib1 - ib0);
    }
  }
  push('equal', a1 - s, s, b1 - s, s);
}

/** Lines unique in both ranges, kept in the longest increasing order (patience). */
function uniqueAnchors(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
  const ca = new Map<string, number>();
  for (let i = a0; i < a1; i++) ca.set(a[i], ca.has(a[i]) ? -1 : i);
  const cb = new Map<string, number>();
  for (let j = b0; j < b1; j++) cb.set(b[j], cb.has(b[j]) ? -1 : j);
  const pairs: [number, number][] = [];
  for (const [k, i] of ca) {
    if (i < 0) continue;
    const j = cb.get(k);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  if (pairs.length === 0) return [];
  pairs.sort((x, y) => x[0] - y[0]);
  // Longest increasing subsequence on the b index.
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const y = pairs[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < y) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.at(-1) ?? -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

function lcs(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, push: Push): void {
  const n = a1 - a0, m = b1 - b0;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[a0 + i] === b[b0 + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  let ga = 0, gb = 0; // start of the current unmatched run
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      push('replace', a0 + ga, i - ga, b0 + gb, j - gb);
      push('equal', a0 + i, 1, b0 + j, 1);
      i++;
      j++;
      ga = i;
      gb = j;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  push('replace', a0 + ga, n - ga, b0 + gb, m - gb);
}
