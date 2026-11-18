// Two-way table comparison: column alignment by header name, row alignment by
// key columns or by content, cell comparison with case/whitespace/numeric
// tolerance. Ported from CompareCraft's table.rs.

import { diffSequences } from './seqdiff';

export interface TableOptions {
  hasHeader: boolean;
  /** Column indexes (in the left table) that uniquely identify a row. */
  keyColumns: number[];
  ignoreCase: boolean;
  trimWhitespace: boolean;
  /** Numbers within this absolute difference are considered equal. */
  numericTolerance: number;
  /** Align columns by header name instead of position. */
  alignColumnsByName: boolean;
}

export const defaultTableOptions: TableOptions = {
  hasHeader: true,
  keyColumns: [],
  ignoreCase: false,
  trimWhitespace: true,
  numericTolerance: 0,
  alignColumnsByName: true,
};

export interface ColumnPair {
  left: number | null;
  right: number | null;
  name: string;
}

/** `similar` = differs only in ways the options consider unimportant. */
export type CellStatus = 'same' | 'similar' | 'different' | 'missing';
export type RowKind = 'same' | 'changed' | 'left-only' | 'right-only';

export interface TableRow {
  kind: RowKind;
  /** Has a difference the options don't excuse. */
  important: boolean;
  left: number | null;
  right: number | null;
  /** One status per entry in `columns`. */
  cells: CellStatus[];
}

export interface TableDiff {
  leftHeader: string[];
  rightHeader: string[];
  columns: ColumnPair[];
  leftRows: string[][];
  rightRows: string[][];
  rows: TableRow[];
  differentRows: number;
  leftOnlyRows: number;
  rightOnlyRows: number;
  equivalent: boolean;
}

export function columnLetter(i: number): string {
  let n = '';
  let k = i + 1;
  while (k > 0) {
    const r = (k - 1) % 26;
    n = String.fromCharCode(65 + r) + n;
    k = Math.floor((k - 1) / 26);
  }
  return n;
}

export function splitHeader(rows: string[][], hasHeader: boolean): { header: string[]; body: string[][] } {
  if (!hasHeader || rows.length === 0) return { header: [], body: rows };
  return { header: rows[0], body: rows.slice(1) };
}

export function width(header: string[], body: string[][]): number {
  let w = header.length;
  for (const r of body) if (r.length > w) w = r.length;
  return w;
}

export function headerKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Pairs columns of two tables, by header name or by position. */
export function alignColumns(lh: string[], lw: number, rh: string[], rw: number, byName: boolean): ColumnPair[] {
  const columns: ColumnPair[] = [];
  if (byName && (lh.length > 0 || rh.length > 0)) {
    const rindex = new Map<string, number>();
    rh.forEach((n, i) => {
      const k = headerKey(n);
      if (!rindex.has(k)) rindex.set(k, i);
    });
    const used = new Array<boolean>(rw).fill(false);
    for (let i = 0; i < lw; i++) {
      const name = lh[i] ?? columnLetter(i);
      let r: number | null = rindex.get(headerKey(name)) ?? null;
      if (r !== null && used[r]) r = null;
      if (r !== null) used[r] = true;
      columns.push({ left: i, right: r, name });
    }
    used.forEach((u, r) => {
      if (!u) columns.push({ left: null, right: r, name: rh[r] ?? columnLetter(r) });
    });
  } else {
    for (let i = 0; i < Math.max(lw, rw); i++) {
      columns.push({ left: i < lw ? i : null, right: i < rw ? i : null, name: lh[i] ?? rh[i] ?? columnLetter(i) });
    }
  }
  return columns;
}

export function makeNormalizer(opts: Pick<TableOptions, 'trimWhitespace' | 'ignoreCase'>): (s: string) => string {
  return (s) => {
    let v = opts.trimWhitespace ? s.trim() : s;
    if (opts.ignoreCase) v = v.toLowerCase();
    return v;
  };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function compareCells(a: string | undefined, b: string | undefined, opts: TableOptions, norm = makeNormalizer(opts)): CellStatus {
  if (a === undefined && b === undefined) return 'same';
  if (a !== undefined && b !== undefined) {
    if (a === b) return 'same';
    const na = norm(a), nb = norm(b);
    if (na === nb) return 'similar';
    if (NUMBER.test(na) && NUMBER.test(nb) && Math.abs(Number(na) - Number(nb)) <= opts.numericTolerance) return 'similar';
    return 'different';
  }
  const x = (a ?? b)!;
  return x.trim() === '' ? 'similar' : 'missing';
}

export function diffTables(left: string[][], right: string[][], opts: TableOptions = defaultTableOptions): TableDiff {
  const { header: lh, body: lrows } = splitHeader(left, opts.hasHeader);
  const { header: rh, body: rrows } = splitHeader(right, opts.hasHeader);
  const columns = alignColumns(lh, width(lh, lrows), rh, width(rh, rrows), opts.hasHeader && opts.alignColumnsByName);
  const norm = makeNormalizer(opts);
  const paired = (c: ColumnPair) => c.left !== null && c.right !== null;

  const compareRow = (l: number, r: number): TableRow => {
    const cells = columns.map((c): CellStatus => {
      const a = c.left !== null ? lrows[l][c.left] : undefined;
      const b = c.right !== null ? rrows[r][c.right] : undefined;
      if (!paired(c)) return (a ?? b ?? '').trim() !== '' ? 'missing' : 'same';
      return compareCells(a, b, opts, norm);
    });
    // Columns on one side only are shown as missing but don't make a row important.
    const important = cells.some((s, i) => paired(columns[i]) && (s === 'different' || s === 'missing'));
    const any = cells.some((s, i) => paired(columns[i]) && s !== 'same');
    return { kind: any ? 'changed' : 'same', important, left: l, right: r, cells };
  };
  const orphan = (kind: RowKind, l: number | null, r: number | null): TableRow => ({
    kind,
    important: true,
    left: l,
    right: r,
    cells: columns.map(() => 'missing'),
  });

  const keyOf = (row: string[], rightSide: boolean): string => {
    if (opts.keyColumns.length === 0) {
      // Match on paired columns in aligned order, so reordered columns still match.
      return columns
        .filter(paired)
        .map((c) => norm(row[(rightSide ? c.right : c.left)!] ?? ''))
        .join('\u001f');
    }
    return opts.keyColumns
      .map((k) => {
        const idx = rightSide ? (columns.find((c) => c.left === k)?.right ?? null) : k;
        return idx === null ? '' : norm(row[idx] ?? '');
      })
      .join('\u001f');
  };
  const lkeys = lrows.map((r) => keyOf(r, false));
  const rkeys = rrows.map((r) => keyOf(r, true));
  const rows: TableRow[] = [];

  if (opts.keyColumns.length > 0) {
    // Keyed: match globally so moved rows still pair up. Right-only rows go last.
    const rpos = new Map<string, number[]>();
    for (let i = rkeys.length - 1; i >= 0; i--) {
      const list = rpos.get(rkeys[i]);
      if (list) list.push(i);
      else rpos.set(rkeys[i], [i]);
    }
    const used = new Array<boolean>(rrows.length).fill(false);
    lkeys.forEach((k, l) => {
      const r = rpos.get(k)?.pop();
      if (r === undefined) rows.push(orphan('left-only', l, null));
      else {
        used[r] = true;
        rows.push(compareRow(l, r));
      }
    });
    used.forEach((u, r) => {
      if (!u) rows.push(orphan('right-only', null, r));
    });
  } else {
    for (const op of diffSequences(lkeys, rkeys)) {
      const common = op.kind === 'equal' ? op.aLen : Math.min(op.aLen, op.bLen);
      // Pair replaced rows positionally; leftovers are orphans.
      for (let k = 0; k < common; k++) rows.push(compareRow(op.aStart + k, op.bStart + k));
      for (let k = common; k < op.aLen; k++) rows.push(orphan('left-only', op.aStart + k, null));
      for (let k = common; k < op.bLen; k++) rows.push(orphan('right-only', null, op.bStart + k));
    }
  }

  const differentRows = rows.filter((r) => r.kind === 'changed' && r.important).length;
  const leftOnlyRows = rows.filter((r) => r.kind === 'left-only').length;
  const rightOnlyRows = rows.filter((r) => r.kind === 'right-only').length;
  return {
    leftHeader: lh,
    rightHeader: rh,
    columns,
    leftRows: lrows,
    rightRows: rrows,
    rows,
    differentRows,
    leftOnlyRows,
    rightOnlyRows,
    equivalent: differentRows + leftOnlyRows + rightOnlyRows === 0,
  };
}
