// Delimited-text (CSV/TSV) parsing and writing. RFC 4180 quoting, flexible row
// lengths, and enough bookkeeping to write a file back in the style it came in.

export interface CsvDialect {
  delimiter: string;
  /** Line ending used when writing. */
  newline: '\n' | '\r\n';
  /** The input ended with a newline. */
  trailingNewline: boolean;
  /** UTF-8 byte order mark at the start. */
  bom: boolean;
}

export const TABLE_EXTENSIONS = ['csv', 'tsv', 'tab', 'psv'];

export function detectDelimiter(text: string, fileName?: string): string {
  const lower = fileName?.toLowerCase() ?? '';
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return '\t';
  if (lower.endsWith('.psv')) return '|';
  const sample = text.split(/\r?\n/, 20).filter((l) => l.length > 0);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', '\t', ';', '|']) {
    const counts = sample.map((l) => countOutsideQuotes(l, d));
    const first = counts[0] ?? 0;
    // Prefer delimiters that appear the same number of times on every line.
    const consistent = counts.filter((c) => c === first).length;
    const score = first > 0 ? first * consistent : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

export function detectDialect(text: string, fileName?: string): CsvDialect {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const crlf = body.indexOf('\r\n');
  const lf = body.indexOf('\n');
  return {
    delimiter: detectDelimiter(body, fileName),
    newline: crlf >= 0 && crlf === lf - 1 ? '\r\n' : '\n',
    trailingNewline: /\r?\n$/.test(body),
    bom,
  };
}

/** Parses delimited text into rows of fields. Malformed quoting never throws. */
export function parseCsv(text: string, delimiter: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0 && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field.length > 0 || fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function quote(field: string, delimiter: string): string {
  if (field.includes('"') || field.includes(delimiter) || field.includes('\n') || field.includes('\r') || /^\s|\s$/.test(field)) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

export function writeCsv(rows: string[][], dialect: CsvDialect): string {
  const body = rows.map((r) => r.map((f) => quote(f, dialect.delimiter)).join(dialect.delimiter)).join(dialect.newline);
  return (dialect.bom ? '﻿' : '') + body + (dialect.trailingNewline && rows.length > 0 ? dialect.newline : '');
}
