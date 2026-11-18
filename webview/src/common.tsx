// Helpers shared by the table views.
import type { SheetTable } from '../../src/core/excel';

/** Rows with formulas shown as "=formula" instead of their results. */
export function withFormulas(sheet: SheetTable): string[][] {
  const keys = Object.keys(sheet.formulas);
  if (keys.length === 0) return sheet.rows;
  const rows = sheet.rows.map((r) => r.slice());
  for (const k of keys) {
    const [r, c] = k.split(',').map(Number);
    while (rows.length <= r) rows.push([]);
    while (rows[r].length <= c) rows[r].push('');
    rows[r][c] = '=' + sheet.formulas[k];
  }
  return rows;
}

export function hasFormulas(sheets: (SheetTable | undefined | null)[]): boolean {
  return sheets.some((s) => s && Object.keys(s.formulas).length > 0);
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
