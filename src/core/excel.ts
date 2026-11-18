// Excel workbooks as tables (via ExcelJS), and writing a merged workbook back.
// Runs in the extension host only; the webview receives plain string tables.

import ExcelJS from 'exceljs';
import type { Side } from './tablemerge';
import type { MaterializedTable } from './tablemerge';
import { checkZipLimits, listZip, type ZipLimits } from './zipinfo';

export interface SheetTable {
  name: string;
  /** Displayed values, row-major, trailing empty cells and rows trimmed. */
  rows: string[][];
  /** Formula text (without '=') by "row,col" (0-based), for cells that have one. */
  formulas: Record<string, string>;
}

export interface WorkbookTables {
  sheets: SheetTable[];
  /** Notes about content left out (charts, size limits). */
  notes: string[];
}

const MAX_CELLS = 5_000_000;

type CellValue = ExcelJS.CellValue;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date);
}

export function formatDate(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

export function cellText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  // Excel shows at most 15 significant digits; this hides float noise like 3.7199999999999998.
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return formatDate(v);
  if (isObject(v)) {
    if ('formula' in v || 'sharedFormula' in v) return cellText((v as { result?: CellValue }).result);
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t: { text?: string }) => t.text ?? '').join('');
    if ('hyperlink' in v) return cellText((v as { text?: CellValue }).text);
    if ('error' in v) return String(v.error);
  }
  return String(v);
}

async function loadWorkbook(bytes: Uint8Array, limits?: ZipLimits): Promise<ExcelJS.Workbook> {
  checkZipLimits(listZip(bytes), limits);
  const wb = new ExcelJS.Workbook();
  // ExcelJS's typings want a Node Buffer; an ArrayBuffer slice works at runtime too.
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return wb;
}

export async function readWorkbook(bytes: Uint8Array, limits?: ZipLimits): Promise<WorkbookTables> {
  const wb = await loadWorkbook(bytes, limits);
  const sheets: SheetTable[] = [];
  const notes: string[] = [];
  let budget = MAX_CELLS;
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    const formulas: Record<string, string> = {};
    const rowCount = ws.rowCount;
    const colCount = ws.columnCount;
    if (rowCount * colCount > budget) {
      notes.push(`Sheet "${ws.name}" has ${rowCount} x ${colCount} cells and was not loaded.`);
      sheets.push({ name: ws.name, rows: [], formulas });
      return;
    }
    budget -= rowCount * colCount;
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      const out: string[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        if (cell.isMerged && cell.master !== cell) {
          out.push('');
          continue;
        }
        out.push(cellText(cell.value));
        if (cell.formula) formulas[`${r - 1},${c - 1}`] = cell.formula;
      }
      while (out.length > 0 && out.at(-1) === '') out.pop();
      rows.push(out);
    }
    while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
    sheets.push({ name: ws.name, rows, formulas });
  });
  return { sheets, notes };
}

/** What to do with one sheet of the merged workbook. */
export type SheetPlan =
  | { name: string; action: 'merge'; hasHeader: boolean; table: MaterializedTable }
  | { name: string; action: 'delete' }
  | { name: string; action: 'copy'; from: Side };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function typedValue(text: string): CellValue {
  if (text === '') return null;
  if (NUMBER.test(text.trim())) return Number(text.trim());
  if (text.startsWith('=') && text.length > 1) return { formula: text.slice(1) } as CellValue;
  return text;
}

function copyValue(src: ExcelJS.Cell): CellValue {
  if (src.formula) return { formula: src.formula, result: src.result } as CellValue;
  const v = src.value;
  if (isObject(v)) return JSON.parse(JSON.stringify(v)) as CellValue;
  return v;
}

function copyStyle(dest: ExcelJS.Cell, src: ExcelJS.Cell): void {
  dest.style = JSON.parse(JSON.stringify(src.style ?? {}));
}

/**
 * Writes the merged workbook. Ours is the template, so its formatting, column
 * widths and anything ExcelJS round-trips are kept; cells that came from another
 * side bring their value and style along.
 */
export async function writeMergedWorkbook(sources: Partial<Record<Side, Uint8Array>>, plans: SheetPlan[], limits?: ZipLimits): Promise<Uint8Array> {
  if (!sources.ours) throw new Error('The ours workbook is required.');
  const target = await loadWorkbook(sources.ours, limits);
  const loaded: Partial<Record<Side, ExcelJS.Workbook>> = {};
  const source = async (side: Side) => {
    if (!loaded[side]) {
      const bytes = sources[side];
      if (!bytes) throw new Error(`The ${side} workbook is missing.`);
      loaded[side] = await loadWorkbook(bytes, limits);
    }
    return loaded[side]!;
  };

  for (const plan of plans) {
    const existing = target.getWorksheet(plan.name);
    if (plan.action === 'delete') {
      if (existing) target.removeWorksheet(existing.id);
      continue;
    }
    if (plan.action === 'copy') {
      if (plan.from === 'ours' && existing) continue;
      const src = (await source(plan.from)).getWorksheet(plan.name);
      if (!src) continue;
      if (existing) target.removeWorksheet(existing.id);
      const ws = target.addWorksheet(plan.name);
      src.columns?.forEach((col, i) => {
        if (col.width) ws.getColumn(i + 1).width = col.width;
      });
      src.eachRow({ includeEmpty: false }, (row, r) => {
        row.eachCell({ includeEmpty: false }, (cell, c) => {
          const dest = ws.getCell(r, c);
          dest.value = copyValue(cell);
          copyStyle(dest, cell);
        });
      });
      continue;
    }
    const ws = existing ?? target.addWorksheet(plan.name);
    const offset = plan.hasHeader ? 2 : 1; // body row 0 is sheet row 2 under a header
    const srcSheets: Partial<Record<Side, ExcelJS.Worksheet | undefined>> = {};
    const srcSheet = async (side: Side) => {
      if (!(side in srcSheets)) srcSheets[side] = (await source(side)).getWorksheet(plan.name);
      return srcSheets[side];
    };
    const { rows, refs } = plan.table;
    const oldRows = ws.rowCount;
    const oldCols = ws.columnCount;
    for (let i = 0; i < rows.length; i++) {
      const width = Math.max(rows[i].length, oldCols);
      for (let j = 0; j < width; j++) {
        const dest = ws.getCell(i + 1, j + 1);
        if (j >= rows[i].length) {
          dest.value = null;
          continue;
        }
        const ref = refs[i][j];
        const sheet = ref ? await srcSheet(ref.side) : undefined;
        if (ref && sheet) {
          const srcRow = ref.row + offset;
          const src = sheet.getCell(srcRow, ref.col + 1);
          dest.value = copyValue(src);
          if (!(ref.side === 'ours' && srcRow === i + 1 && ref.col === j)) copyStyle(dest, src);
        } else {
          dest.value = typedValue(rows[i][j]);
        }
      }
    }
    // ExcelJS's spliceRows is a no-op on loaded sheets, so clear the leftover rows instead.
    for (let r = rows.length + 1; r <= oldRows; r++) {
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        cell.value = null;
      });
    }
  }
  const out = await target.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}

/** A small workbook from tables; used by tests and by "copy as new" flows. */
export async function buildWorkbook(sheets: { name: string; rows: (string | number)[][] }[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r) => ws.addRow(r));
  }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
