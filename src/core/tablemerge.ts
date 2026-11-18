// Three-way table merge. Columns are matched by header name (or position), rows
// by key columns or by content (diff3 over rows), and cells merge one by one:
// a cell changed on one side only takes that change; changed on both sides to
// different values, it becomes a conflict. Row-level clashes that can't be
// paired cell by cell become conflict blocks.

import { diffSequences } from './seqdiff';
import { columnLetter, headerKey, splitHeader, width } from './table';

export type Side = 'base' | 'ours' | 'theirs';
export const SIDES: Side[] = ['base', 'ours', 'theirs'];

export interface MergeOptions {
  hasHeader: boolean;
  alignColumnsByName: boolean;
  /** Indexes into the merged column list. */
  keyColumns: number[];
  /**
   * With no key columns given, use the first of the leading columns whose
   * values are unique and non-empty on every side (an id column), if any.
   */
  autoKey: boolean;
}

export const defaultMergeOptions: MergeOptions = { hasHeader: true, alignColumnsByName: true, keyColumns: [], autoKey: true };

export interface MergeColumn {
  name: string;
  base: number | null;
  ours: number | null;
  theirs: number | null;
}

/** Where a merged value came from. `row` is a body row index; -1 is the header. */
export interface CellRef {
  side: Side;
  row: number;
  col: number;
}

export interface CellConflict {
  base: string;
  ours: string;
  theirs: string;
}

export interface MergeCell {
  value: string;
  src: CellRef | null;
  conflict?: CellConflict;
  /** How a conflict was resolved: a side, or 'edited' for a typed value. */
  resolved?: Side | 'edited';
}

export interface MergeRow {
  type: 'row';
  base: number | null;
  ours: number | null;
  theirs: number | null;
  cells: MergeCell[];
}

export type BlockChoice = Side | 'ours-then-theirs' | 'theirs-then-ours';

export interface MergeBlock {
  type: 'block';
  base: number[];
  ours: number[];
  theirs: number[];
  choice: BlockChoice | null;
}

export type MergeItem = MergeRow | MergeBlock;

export interface TableMerge {
  hasHeader: boolean;
  /** The key columns rows were matched by (given, or detected). Empty: by content. */
  keyColumns: number[];
  /** The key was detected rather than given. */
  autoKey: boolean;
  columns: MergeColumn[];
  bodies: Record<Side, string[][]>;
  items: MergeItem[];
}

type Tables = Record<Side, string[][]>;

export function mergeColumns(headers: Record<Side, string[]>, widths: Record<Side, number>, byName: boolean): MergeColumn[] {
  if (!byName) {
    const w = Math.max(widths.base, widths.ours, widths.theirs);
    return Array.from({ length: w }, (_, i) => ({
      name: headers.ours[i] ?? headers.theirs[i] ?? headers.base[i] ?? columnLetter(i),
      base: i < widths.base ? i : null,
      ours: i < widths.ours ? i : null,
      theirs: i < widths.theirs ? i : null,
    }));
  }
  // Key each column by name plus occurrence, so duplicate names pair in order.
  const keyed = (side: Side) => {
    const seen = new Map<string, number>();
    const map = new Map<string, number>();
    for (let i = 0; i < widths[side]; i++) {
      const k = headerKey(headers[side][i] ?? columnLetter(i));
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      map.set(`${k}#${n}`, i);
    }
    return map;
  };
  const b = keyed('base'), o = keyed('ours'), t = keyed('theirs');
  const columns: MergeColumn[] = [];
  const make = (k: string, name: string): MergeColumn => ({ name, base: b.get(k) ?? null, ours: o.get(k) ?? null, theirs: t.get(k) ?? null });
  for (const [k, i] of o) {
    // Deleted by theirs (present in base, gone in theirs): the deletion wins.
    if (b.has(k) && !t.has(k)) continue;
    columns.push(make(k, headers.ours[i] ?? columnLetter(i)));
  }
  for (const [k, i] of t) {
    if (o.has(k)) continue;
    if (b.has(k)) continue; // deleted by ours
    columns.push(make(k, headers.theirs[i] ?? columnLetter(i)));
  }
  return columns;
}

export function mergeTables(base: string[][], ours: string[][], theirs: string[][], opts: MergeOptions = defaultMergeOptions): TableMerge {
  const split = { base: splitHeader(base, opts.hasHeader), ours: splitHeader(ours, opts.hasHeader), theirs: splitHeader(theirs, opts.hasHeader) };
  const bodies: Tables = { base: split.base.body, ours: split.ours.body, theirs: split.theirs.body };
  const headers = { base: split.base.header, ours: split.ours.header, theirs: split.theirs.header };
  const widths = {
    base: width(headers.base, bodies.base),
    ours: width(headers.ours, bodies.ours),
    theirs: width(headers.theirs, bodies.theirs),
  };
  const columns = mergeColumns(headers, widths, opts.hasHeader && opts.alignColumnsByName);
  const val = (side: Side, row: number | null, c: MergeColumn): string => {
    const idx = c[side];
    if (row === null || idx === null) return '';
    return bodies[side][row][idx] ?? '';
  };
  const rowKey = (side: Side, row: number, cols: MergeColumn[]) => cols.map((c) => val(side, row, c)).join('\u001f');

  const sideRow = (side: Side, row: number): MergeRow => ({
    type: 'row',
    base: side === 'base' ? row : null,
    ours: side === 'ours' ? row : null,
    theirs: side === 'theirs' ? row : null,
    cells: columns.map((c) => ({ value: val(side, row, c), src: c[side] === null ? null : { side, row, col: c[side]! } })),
  });

  const mergeRow = (b: number | null, o: number, t: number): MergeRow => ({
    type: 'row',
    base: b,
    ours: o,
    theirs: t,
    cells: columns.map((c): MergeCell => {
      const bv = val('base', b, c), ov = val('ours', o, c), tv = val('theirs', t, c);
      const ref = (side: Side, row: number): CellRef | null => (c[side] === null ? null : { side, row, col: c[side]! });
      if (ov === tv) return { value: ov, src: ref('ours', o) ?? ref('theirs', t) };
      if (ov === bv) return { value: tv, src: ref('theirs', t) };
      if (tv === bv) return { value: ov, src: ref('ours', o) };
      return { value: ov, src: ref('ours', o), conflict: { base: bv, ours: ov, theirs: tv } };
    }),
  });

  let keyColumns = opts.keyColumns;
  const detected = keyColumns.length === 0 && opts.autoKey ? detectKey() : null;
  if (detected !== null) keyColumns = [detected];
  const items: MergeItem[] = keyColumns.length > 0 ? mergeKeyed() : mergeByContent();
  return { hasHeader: opts.hasHeader, keyColumns, autoKey: detected !== null, columns, bodies, items };

  function detectKey(): number | null {
    const sides = SIDES.filter((s) => bodies[s].length > 0);
    if (sides.length < 2) return null;
    for (let i = 0; i < Math.min(3, columns.length); i++) {
      const c = columns[i];
      const ok = sides.every((s) => {
        if (c[s] === null) return false;
        const seen = new Set<string>();
        for (let r = 0; r < bodies[s].length; r++) {
          const v = val(s, r, c).trim();
          if (v === '' || seen.has(v)) return false;
          seen.add(v);
        }
        return true;
      });
      if (ok) return i;
    }
    return null;
  }

  function mergeKeyed(): MergeItem[] {
    const keyCols = keyColumns.map((i) => columns[i]).filter((c) => c !== undefined);
    const index = (side: Side) => {
      const m = new Map<string, number[]>();
      bodies[side].forEach((_, i) => {
        const k = rowKey(side, i, keyCols).trim();
        const list = m.get(k);
        if (list) list.push(i);
        else m.set(k, [i]);
      });
      return m;
    };
    const bi = index('base'), ti = index('theirs');
    const take = (m: Map<string, number[]>, k: string) => m.get(k)?.shift() ?? null;
    const sameAsBase = (side: Side, row: number, b: number) => columns.every((c) => val(side, row, c) === val('base', b, c));

    // Items keyed by their theirs row, so rows theirs added can follow their predecessor.
    const out: MergeItem[] = [];
    const theirsItem = new Map<number, MergeItem>();
    const consumedTheirs = new Set<number>();
    bodies.ours.forEach((_, o) => {
      const k = rowKey('ours', o, keyCols).trim();
      const b = take(bi, k), t = take(ti, k);
      let item: MergeItem | null = null;
      if (t !== null) {
        consumedTheirs.add(t);
        item = mergeRow(b, o, t);
      } else if (b !== null) {
        // Theirs deleted the row: fine if ours left it alone.
        if (!sameAsBase('ours', o, b)) item = { type: 'block', base: [b], ours: [o], theirs: [], choice: null };
      } else {
        item = sideRow('ours', o);
      }
      if (item) {
        out.push(item);
        if (t !== null) theirsItem.set(t, item);
      }
    });
    // Rows only theirs still has: added by theirs, or deleted by ours.
    const inserts = new Map<MergeItem | null, MergeItem[]>();
    let anchor: MergeItem | null = null;
    bodies.theirs.forEach((_, t) => {
      if (consumedTheirs.has(t)) {
        anchor = theirsItem.get(t) ?? anchor;
        return;
      }
      const k = rowKey('theirs', t, keyCols).trim();
      const b = take(bi, k);
      let item: MergeItem | null = null;
      if (b !== null) {
        if (!sameAsBase('theirs', t, b)) item = { type: 'block', base: [b], ours: [], theirs: [t], choice: null };
      } else {
        item = sideRow('theirs', t);
      }
      if (item) {
        const list = inserts.get(anchor) ?? [];
        list.push(item);
        inserts.set(anchor, list);
        anchor = item;
      }
    });
    const result: MergeItem[] = [...(inserts.get(null) ?? [])];
    const expand = (item: MergeItem) => {
      result.push(item);
      for (const next of inserts.get(item) ?? []) expand(next);
    };
    for (const item of out) expand(item);
    return result;
  }

  function mergeByContent(): MergeItem[] {
    const keys = (side: Side) => bodies[side].map((_, i) => rowKey(side, i, columns));
    const bk = keys('base'), ok = keys('ours'), tk = keys('theirs');
    const match = (other: string[]) => {
      const m = new Array<number>(bk.length).fill(-1);
      for (const op of diffSequences(bk, other)) {
        if (op.kind === 'equal') for (let k = 0; k < op.aLen; k++) m[op.aStart + k] = op.bStart + k;
      }
      return m;
    };
    const mo = match(ok), mt = match(tk);
    const out: MergeItem[] = [];
    const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
    const same = (xs: number[], xk: string[], ys: number[], yk: string[]) => xs.length === ys.length && xs.every((x, i) => xk[x] === yk[ys[i]]);

    const chunk = (b: number[], o: number[], t: number[]) => {
      if (b.length + o.length + t.length === 0) return;
      if (same(o, ok, b, bk)) t.forEach((r) => out.push(sideRow('theirs', r)));
      else if (same(t, tk, b, bk) || same(o, ok, t, tk)) o.forEach((r) => out.push(sideRow('ours', r)));
      else if (b.length > 0 && o.length === b.length && t.length === b.length) {
        // The same rows edited on both sides: merge cell by cell.
        o.forEach((r, i) => out.push(mergeRow(b[i], r, t[i])));
      } else out.push({ type: 'block', base: b, ours: o, theirs: t, choice: null });
    };

    let b0 = 0, o0 = 0, t0 = 0;
    for (let b = 0; b < bk.length; b++) {
      if (mo[b] < o0 || mt[b] < t0) continue; // not matched in both (or out of order)
      chunk(range(b0, b), range(o0, mo[b]), range(t0, mt[b]));
      out.push(sideRow('ours', mo[b]));
      const last = out.at(-1) as MergeRow;
      last.base = b;
      last.theirs = mt[b];
      b0 = b + 1;
      o0 = mo[b] + 1;
      t0 = mt[b] + 1;
    }
    chunk(range(b0, bk.length), range(o0, ok.length), range(t0, tk.length));
    return out;
  }
}

export function conflictCount(m: TableMerge): number {
  let n = 0;
  for (const item of m.items) {
    if (item.type === 'block') {
      if (item.choice === null) n++;
    } else {
      for (const c of item.cells) if (c.conflict && !c.resolved) n++;
    }
  }
  return n;
}

export function resolveCell(m: TableMerge, item: number, col: number, choice: Side | { edited: string }): void {
  const row = m.items[item];
  if (row?.type !== 'row') return;
  const cell = row.cells[col];
  const c = m.columns[col];
  if (typeof choice === 'object') {
    cell.value = choice.edited;
    cell.src = null;
    cell.resolved = 'edited';
    return;
  }
  const r = row[choice];
  cell.value = cell.conflict ? cell.conflict[choice] : r !== null && c[choice] !== null ? (m.bodies[choice][r][c[choice]!] ?? '') : '';
  cell.src = r !== null && c[choice] !== null ? { side: choice, row: r, col: c[choice]! } : null;
  cell.resolved = choice;
}

export function resolveBlock(m: TableMerge, item: number, choice: BlockChoice | null): void {
  const block = m.items[item];
  if (block?.type === 'block') block.choice = choice;
}

/** Resolves every open conflict the same way. */
export function resolveAll(m: TableMerge, side: 'ours' | 'theirs'): void {
  m.items.forEach((item, i) => {
    if (item.type === 'block') {
      if (item.choice === null) item.choice = side;
    } else {
      item.cells.forEach((c, col) => {
        if (c.conflict && !c.resolved) resolveCell(m, i, col, side);
      });
    }
  });
}

export interface MaterializedTable {
  rows: string[][];
  /** Same shape as `rows`; where each value came from (null = typed or empty). */
  refs: (CellRef | null)[][];
}

/** The merged table, header included. Unresolved conflicts keep ours. */
export function materialize(m: TableMerge): MaterializedTable {
  const rows: string[][] = [];
  const refs: (CellRef | null)[][] = [];
  if (m.hasHeader) {
    rows.push(m.columns.map((c) => c.name));
    refs.push(m.columns.map((c) => (c.ours !== null ? { side: 'ours', row: -1, col: c.ours } : c.theirs !== null ? { side: 'theirs', row: -1, col: c.theirs } : null)));
  }
  const emitSide = (side: Side, list: number[]) => {
    for (const r of list) {
      rows.push(m.columns.map((c) => (c[side] === null ? '' : (m.bodies[side][r][c[side]!] ?? ''))));
      refs.push(m.columns.map((c) => (c[side] === null ? null : { side, row: r, col: c[side]! })));
    }
  };
  for (const item of m.items) {
    if (item.type === 'row') {
      rows.push(item.cells.map((c) => c.value));
      refs.push(item.cells.map((c) => c.src));
      continue;
    }
    switch (item.choice ?? 'ours') {
      case 'base': emitSide('base', item.base); break;
      case 'ours': emitSide('ours', item.ours); break;
      case 'theirs': emitSide('theirs', item.theirs); break;
      case 'ours-then-theirs': emitSide('ours', item.ours); emitSide('theirs', item.theirs); break;
      case 'theirs-then-ours': emitSide('theirs', item.theirs); emitSide('ours', item.ours); break;
    }
  }
  return { rows, refs };
}
