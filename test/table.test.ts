import { describe, expect, it } from 'vitest';
import { detectDelimiter, detectDialect, parseCsv, writeCsv } from '../src/core/csv';
import { diffSequences } from '../src/core/seqdiff';
import { defaultTableOptions, diffTables } from '../src/core/table';
import { conflictCount, defaultMergeOptions, materialize, mergeTables, resolveAll, resolveBlock, resolveCell } from '../src/core/tablemerge';

const csv = (s: string) => parseCsv(s, ',');

describe('csv', () => {
  it('parses quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,"b,c"\r\n"x ""y""","line1\nline2"\r\n', ',')).toEqual([
      ['a', 'b,c'],
      ['x "y"', 'line1\nline2'],
    ]);
  });
  it('keeps empty trailing fields and tolerates bad quoting', () => {
    expect(parseCsv('a,,\n1,"open', ',')).toEqual([['a', '', ''], ['1', 'open']]);
  });
  it('round-trips with the detected dialect', () => {
    const text = '﻿id;name\r\n1;"a;b"\r\n';
    const d = detectDialect(text);
    expect(d).toEqual({ delimiter: ';', newline: '\r\n', trailingNewline: true, bom: true });
    expect(writeCsv(parseCsv(text, d.delimiter), d)).toBe(text);
  });
  it('detects delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('a,b\n', 'x.tsv')).toBe('\t');
  });
});

describe('seqdiff', () => {
  const apply = (a: string[], b: string[]) => {
    const out: string[] = [];
    for (const op of diffSequences(a, b)) {
      if (op.kind === 'equal') {
        for (let k = 0; k < op.aLen; k++) expect(a[op.aStart + k]).toBe(b[op.bStart + k]);
      }
      out.push(...b.slice(op.bStart, op.bStart + op.bLen));
    }
    return out;
  };
  it('covers both sequences in order', () => {
    const a = 'a b c d e f g'.split(' ');
    const b = 'a x c d y f g z'.split(' ');
    expect(apply(a, b)).toEqual(b);
    const ops = diffSequences(a, b);
    expect(ops.filter((o) => o.kind === 'equal').reduce((n, o) => n + o.aLen, 0)).toBe(5);
  });
  it('handles repeated lines without unique anchors', () => {
    const a = ['x', 'x', 'y', 'x'];
    const b = ['x', 'y', 'x', 'x'];
    expect(apply(a, b)).toEqual(b);
  });
  it('handles empty inputs', () => {
    expect(diffSequences([], [])).toEqual([]);
    expect(diffSequences(['a'], [])).toEqual([{ kind: 'delete', aStart: 0, aLen: 1, bStart: 0, bLen: 0 }]);
  });
});

describe('diffTables', () => {
  it('compares by position', () => {
    const d = diffTables(csv('id,name\n1,a\n2,b\n'), csv('id,name\n1,a\n2,B\n3,c\n'));
    expect(d.columns.length).toBe(2);
    expect(d.differentRows).toBe(1);
    expect(d.rightOnlyRows).toBe(1);
  });
  it('matches by key and column names with numeric tolerance', () => {
    const d = diffTables(csv('id,price\n1,1.000\n2,5\n'), csv('price,id\n5,2\n1.001,1\n'), {
      ...defaultTableOptions,
      keyColumns: [0],
      numericTolerance: 0.01,
    });
    expect(d.equivalent).toBe(true);
  });
  it('pairs rows when columns are reordered and one is dropped', () => {
    const d = diffTables(csv('id,name,extra\n1,a,x\n2,b,y\n'), csv('name,id\na,1\nb,2\n'));
    expect(d.columns.length).toBe(3);
    expect(d.rows.every((r) => !r.important && r.left === r.right)).toBe(true);
  });
});

describe('mergeTables', () => {
  const base = csv('id,name,qty\n1,apple,5\n2,pear,3\n3,plum,1\n');

  it('takes non-overlapping changes from both sides', () => {
    const ours = csv('id,name,qty\n1,apple,6\n2,pear,3\n3,plum,1\n');
    const theirs = csv('id,name,qty\n1,apple,5\n2,Pear,3\n3,plum,1\n4,fig,9\n');
    const m = mergeTables(base, ours, theirs);
    expect(conflictCount(m)).toBe(0);
    expect(materialize(m).rows).toEqual(csv('id,name,qty\n1,apple,6\n2,Pear,3\n3,plum,1\n4,fig,9\n'));
  });

  it('merges different cells of the same row', () => {
    const ours = csv('id,name,qty\n1,apple,6\n2,pear,3\n3,plum,1\n');
    const theirs = csv('id,name,qty\n1,Apple,5\n2,pear,3\n3,plum,1\n');
    const m = mergeTables(base, ours, theirs);
    expect(conflictCount(m)).toBe(0);
    expect(materialize(m).rows[1]).toEqual(['1', 'Apple', '6']);
  });

  it('reports a cell conflict and resolves it', () => {
    const ours = csv('id,name,qty\n1,apple,6\n2,pear,3\n3,plum,1\n');
    const theirs = csv('id,name,qty\n1,apple,7\n2,pear,3\n3,plum,1\n');
    const m = mergeTables(base, ours, theirs);
    expect(conflictCount(m)).toBe(1);
    const item = m.items.findIndex((i) => i.type === 'row' && i.cells.some((c) => c.conflict));
    resolveCell(m, item, 2, 'theirs');
    expect(conflictCount(m)).toBe(0);
    const out = materialize(m);
    expect(out.rows[1]).toEqual(['1', 'apple', '7']);
    expect(out.refs[1][2]).toEqual({ side: 'theirs', row: 0, col: 2 });
    resolveCell(m, item, 2, { edited: '13' });
    expect(materialize(m).rows[1][2]).toBe('13');
  });

  it('merges columns added and removed on different sides', () => {
    const ours = csv('id,name,qty,color\n1,apple,5,red\n2,pear,3,green\n3,plum,1,purple\n');
    const theirs = csv('id,name\n1,apple\n2,pear\n3,plum\n');
    const m = mergeTables(base, ours, theirs);
    expect(m.columns.map((c) => c.name)).toEqual(['id', 'name', 'color']);
    expect(conflictCount(m)).toBe(0);
    expect(materialize(m).rows[3]).toEqual(['3', 'plum', 'purple']);
  });

  it('matches by key when rows move', () => {
    const ours = csv('id,name,qty\n3,plum,1\n1,apple,5\n2,pear,4\n');
    const theirs = csv('id,name,qty\n1,apple,5\n2,pear,3\n3,plum,2\n5,kiwi,1\n');
    const m = mergeTables(base, ours, theirs, { hasHeader: true, alignColumnsByName: true, keyColumns: [0], autoKey: false });
    expect(conflictCount(m)).toBe(0);
    // kiwi follows plum, its predecessor on theirs' side.
    expect(materialize(m).rows).toEqual(csv('id,name,qty\n3,plum,2\n5,kiwi,1\n1,apple,5\n2,pear,4\n'));
  });

  it('flags delete versus modify as a block conflict', () => {
    const ours = csv('id,name,qty\n1,apple,5\n3,plum,1\n');
    const theirs = csv('id,name,qty\n1,apple,5\n2,pear,8\n3,plum,1\n');
    const keyed = mergeTables(base, ours, theirs, { hasHeader: true, alignColumnsByName: true, keyColumns: [0], autoKey: false });
    expect(conflictCount(keyed)).toBe(1);
    const unkeyed = mergeTables(base, ours, theirs, { ...defaultMergeOptions, autoKey: false });
    expect(conflictCount(unkeyed)).toBe(1);
    const block = unkeyed.items.findIndex((i) => i.type === 'block');
    resolveBlock(unkeyed, block, 'theirs');
    expect(materialize(unkeyed).rows).toEqual(theirs);
  });

  it('deletes a row deleted on one side and untouched on the other', () => {
    const ours = csv('id,name,qty\n1,apple,5\n3,plum,1\n');
    const m = mergeTables(base, ours, base);
    expect(conflictCount(m)).toBe(0);
    expect(materialize(m).rows).toEqual(ours);
  });

  it('resolves everything one way', () => {
    const ours = csv('id,name,qty\n1,apple,6\n2,pear,3\n');
    const theirs = csv('id,name,qty\n1,apple,7\n2,pear,3\n3,plum,2\n');
    const m = mergeTables(base, ours, theirs);
    expect(conflictCount(m)).toBeGreaterThan(0);
    resolveAll(m, 'ours');
    expect(conflictCount(m)).toBe(0);
  });

  it('detects an id column and merges by it', () => {
    const ours = csv('id,name,qty\n1,apple,6\n2,pear,3\n3,plum,1\n6,lime,4\n');
    const theirs = csv('id,name,qty\n1,Apple,5\n3,plum,2\n7,date,9\n');
    const m = mergeTables(base, ours, theirs);
    expect(m.autoKey).toBe(true);
    expect(m.keyColumns).toEqual([0]);
    expect(conflictCount(m)).toBe(0);
    expect(materialize(m).rows).toEqual(csv('id,name,qty\n1,Apple,6\n3,plum,2\n7,date,9\n6,lime,4\n'));
  });

  it('offers rows added at the same place on both sides as a block', () => {
    const m = mergeTables(base, csv('id,name,qty\n1,apple,5\n2,pear,3\n3,plum,1\nx,lime,4\n'), csv('id,name,qty\n1,apple,5\n2,pear,3\n3,plum,1\ny,date,9\n'), {
      ...defaultMergeOptions,
      autoKey: false,
    });
    expect(conflictCount(m)).toBe(1);
    const block = m.items.findIndex((i) => i.type === 'block');
    resolveBlock(m, block, 'ours-then-theirs');
    expect(materialize(m).rows.slice(-2)).toEqual([['x', 'lime', '4'], ['y', 'date', '9']]);
  });

  it('merges headerless tables by position', () => {
    const m = mergeTables(csv('a,b\nc,d\n'), csv('a,B\nc,d\n'), csv('a,b\nC,d\n'), { hasHeader: false, alignColumnsByName: false, keyColumns: [], autoKey: false });
    expect(materialize(m).rows).toEqual(csv('a,B\nC,d\n'));
  });
});
