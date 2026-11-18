// Loading CSV and Excel files into the tables the webview shows, and writing
// merge results back.

import { detectDialect, parseCsv, writeCsv, type CsvDialect } from './core/csv';
import { readWorkbook, writeMergedWorkbook, type SheetPlan } from './core/excel';
import type { Side as MergeSide } from './core/tablemerge';
import type { TableDoc, TableFormat } from './shared/protocol';
import type { Side } from './sides';
import { baseName } from './formats';

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function tableFromBytes(bytes: Uint8Array, format: TableFormat, label: string, detail: string, path: string): Promise<TableDoc> {
  if (format === 'excel') {
    return readWorkbook(bytes).then((wb) => ({ label, detail, format, sheets: wb.sheets, notes: wb.notes }));
  }
  const text = decodeText(bytes);
  const dialect = detectDialect(text, path);
  return Promise.resolve({
    label,
    detail,
    format,
    sheets: [{ name: baseName(path), rows: parseCsv(text, dialect.delimiter), formulas: {} }],
  });
}

export async function loadTable(side: Side, format: TableFormat): Promise<TableDoc> {
  return tableFromBytes(await side.read(), format, side.label, side.detail, side.uri.path);
}

/** CSV output keeps ours' dialect (delimiter, line endings, BOM). */
export function csvOutput(rows: string[][], template: Uint8Array | undefined, path: string): Uint8Array {
  const dialect: CsvDialect = template
    ? detectDialect(decodeText(template), path)
    : { delimiter: path.toLowerCase().endsWith('.tsv') ? '\t' : ',', newline: '\n', trailingNewline: true, bom: false };
  return new TextEncoder().encode(writeCsv(rows, dialect));
}

export function excelOutput(sources: Partial<Record<MergeSide, Uint8Array>>, plans: SheetPlan[]): Promise<Uint8Array> {
  return writeMergedWorkbook(sources, plans);
}
