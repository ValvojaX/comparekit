import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildWorkbook, readWorkbook, writeMergedWorkbook } from '../src/core/excel';
import { materialize, mergeTables } from '../src/core/tablemerge';
import { checkZipLimits, listZip, ZipLimitError } from '../src/core/zipinfo';

describe('zipinfo', () => {
  it('lists entries and sizes', async () => {
    const zip = new JSZip();
    zip.file('a.txt', 'hello');
    zip.file('dir/b.txt', 'x'.repeat(1000));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const entries = listZip(bytes);
    expect(entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ['a.txt', 5],
      ['dir/', 0],
      ['dir/b.txt', 1000],
    ]);
  });
  it('rejects archives that expand too far', async () => {
    const zip = new JSZip();
    zip.file('bomb.bin', new Uint8Array(20 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    expect(() => checkZipLimits(listZip(bytes))).toThrow(ZipLimitError);
    expect(() => checkZipLimits(listZip(bytes), { maxEntries: 10, maxTotalUncompressed: 1e6, maxRatio: 1e9 })).toThrow(/expands to/);
  });
  it('rejects non-zip input', () => {
    expect(() => listZip(new Uint8Array(100))).toThrow();
  });
});

describe('excel', () => {
  it('reads values, formulas, dates and rich text', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['id', 'name', 'total', 'when']);
    ws.addRow([1, { richText: [{ text: 'ap' }, { text: 'ple' }] }, { formula: 'A2*2', result: 2 }, new Date(Date.UTC(2026, 0, 31))]);
    wb.addWorksheet('Empty');
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const t = await readWorkbook(bytes);
    expect(t.sheets.map((s) => s.name)).toEqual(['Data', 'Empty']);
    expect(t.sheets[0].rows).toEqual([
      ['id', 'name', 'total', 'when'],
      ['1', 'apple', '2', '2026-01-31'],
    ]);
    expect(t.sheets[0].formulas).toEqual({ '1,2': 'A2*2' });
    expect(t.sheets[1].rows).toEqual([]);
  });

  it('writes a merged sheet, keeping values typed and taking cells from both sides', async () => {
    const base = await buildWorkbook([{ name: 'S', rows: [['id', 'qty'], [1, 5], [2, 3]] }]);
    const ours = await buildWorkbook([{ name: 'S', rows: [['id', 'qty'], [1, 6], [2, 3]] }]);
    const theirs = await buildWorkbook([{ name: 'S', rows: [['id', 'qty'], [1, 5], [2, 3], [3, 9]] }]);
    const tables = await Promise.all([base, ours, theirs].map((b) => readWorkbook(b)));
    const m = mergeTables(tables[0].sheets[0].rows, tables[1].sheets[0].rows, tables[2].sheets[0].rows);
    const out = await writeMergedWorkbook({ base, ours, theirs }, [{ name: 'S', action: 'merge', hasHeader: true, table: materialize(m) }]);
    const back = await readWorkbook(out);
    expect(back.sheets[0].rows).toEqual([['id', 'qty'], ['1', '6'], ['2', '3'], ['3', '9']]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.buffer as ArrayBuffer);
    expect(wb.getWorksheet('S')!.getCell('B4').value).toBe(9);
  });

  it('deletes rows past the merged end and handles sheet plans', async () => {
    const ours = await buildWorkbook([{ name: 'A', rows: [['x'], [1], [2], [3]] }, { name: 'Gone', rows: [['y']] }]);
    const theirs = await buildWorkbook([{ name: 'A', rows: [['x']] }, { name: 'New', rows: [['z'], [7]] }]);
    const out = await writeMergedWorkbook({ ours, theirs }, [
      { name: 'A', action: 'merge', hasHeader: true, table: { rows: [['x'], ['1']], refs: [[null], [null]] } },
      { name: 'Gone', action: 'delete' },
      { name: 'New', action: 'copy', from: 'theirs' },
    ]);
    const back = await readWorkbook(out);
    expect(back.sheets.map((s) => [s.name, s.rows])).toEqual([
      ['A', [['x'], ['1']]],
      ['New', [['z'], ['7']]],
    ]);
  });
});
