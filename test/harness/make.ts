// Writes HTML pages that load the built webview with sample data and a mock
// VS Code API, for checking the UI in a browser. Run: npm run harness
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { parseCsv } from '../../src/core/csv';
import { readWorkbook } from '../../src/core/excel';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { diffArchives, mergeArchives } from '../../src/core/archive';
import { diffBytes, toBase64 } from '../../src/core/bytes';
import type { FileDoc, InitPayload, TableDoc } from '../../src/shared/protocol';

/** A minimal RGBA PNG encoder, so the harness needs no image library. */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const imgDoc = (label: string, bytes: Uint8Array): FileDoc => ({ label, size: bytes.length, image: { mime: 'image/png', base64: toBase64(bytes) } });
const fileDoc = (label: string, bytes: Uint8Array): FileDoc => ({ label, size: bytes.length });

const out = resolve(process.argv[2] ?? 'test/harness/out');
mkdirSync(out, { recursive: true });

/** VS Code's Dark Modern and Light Modern theme variables (a subset), as webviews receive them. */
const THEME_VARS: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    'editor-background': '#1f1f1f', 'editor-foreground': '#cccccc', foreground: '#cccccc', 'descriptionForeground': '#9d9d9d', 'disabledForeground': '#cccccc80',
    'sideBar-background': '#181818', 'editorGroup-border': '#ffffff17', 'panel-border': '#2b2b2b', 'widget-border': '#313131', 'focusBorder': '#0078d4',
    'list-hoverBackground': '#2a2d2e', 'list-inactiveSelectionBackground': '#37373d', 'toolbar-hoverBackground': '#5a5d5e50', 'icon-foreground': '#cccccc',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-border': '#ffffff12',
    'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
    'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c',
    'inputOption-activeBackground': '#2489db82', 'inputOption-activeForeground': '#ffffff', 'inputOption-activeBorder': '#2488db',
    'editorWidget-background': '#202020', 'editorWidget-border': '#454545', 'widget-shadow': '#00000066',
    'scrollbarSlider-background': '#79797966', 'scrollbarSlider-hoverBackground': '#646464b3', 'tab-activeBorderTop': '#0078d4',
    'diffEditor-insertedTextBackground': '#9ccc2c33', 'diffEditor-removedTextBackground': '#ff000033', 'diffEditor-insertedLineBackground': '#9bb95533', 'diffEditor-removedLineBackground': '#ff000033',
    'gitDecoration-addedResourceForeground': '#81b88b', 'gitDecoration-modifiedResourceForeground': '#e2c08d', 'gitDecoration-deletedResourceForeground': '#c74e39',
    'gitDecoration-conflictingResourceForeground': '#e4676b', 'gitDecoration-ignoredResourceForeground': '#8c8c8c', 'charts-purple': '#b180d7',
  },
  light: {
    'editor-background': '#ffffff', 'editor-foreground': '#3b3b3b', foreground: '#3b3b3b', 'descriptionForeground': '#3b3b3b', 'disabledForeground': '#61616180',
    'sideBar-background': '#f8f8f8', 'editorGroup-border': '#e5e5e5', 'panel-border': '#e5e5e5', 'widget-border': '#e5e5e5', 'focusBorder': '#005fb8',
    'list-hoverBackground': '#f2f2f2', 'list-inactiveSelectionBackground': '#e4e6f1', 'toolbar-hoverBackground': '#b8b8b850', 'icon-foreground': '#3b3b3b',
    'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-border': '#0000001a',
    'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc',
    'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece',
    'inputOption-activeBackground': '#bed6ed', 'inputOption-activeForeground': '#000000', 'inputOption-activeBorder': '#005fb8',
    'editorWidget-background': '#f8f8f8', 'editorWidget-border': '#c8c8c8', 'widget-shadow': '#00000029',
    'scrollbarSlider-background': '#64646466', 'scrollbarSlider-hoverBackground': '#646464b3', 'tab-activeBorderTop': '#005fb8',
    'diffEditor-insertedTextBackground': '#9ccc2c40', 'diffEditor-removedTextBackground': '#ff000033', 'diffEditor-insertedLineBackground': '#9bb95533', 'diffEditor-removedLineBackground': '#ff000033',
    'gitDecoration-addedResourceForeground': '#587c0c', 'gitDecoration-modifiedResourceForeground': '#895503', 'gitDecoration-deletedResourceForeground': '#ad0707',
    'gitDecoration-conflictingResourceForeground': '#ad0707', 'gitDecoration-ignoredResourceForeground': '#8e8e90', 'charts-purple': '#652d90',
  },
};

function page(name: string, payload: InitPayload, theme: 'dark' | 'light', bytes?: { left: Uint8Array; right: Uint8Array }) {
  const fonts = "--vscode-font-family:-apple-system,BlinkMacSystemFont,'Segoe WPC','Segoe UI',system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,'Courier New',monospace;--vscode-editor-font-size:14px";
  const vars = Object.entries(THEME_VARS[theme]).map(([k, v]) => `--vscode-${k}:${v}`).join(';') + ';' + fonts;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/webview.css">
<style>html{${vars}}</style>
<script>
window.__posted = [];
window.__bytes = ${JSON.stringify(bytes ? { left: toBase64(bytes.left), right: toBase64(bytes.right) } : {})};
window.__vscodeMock = {
  postMessage(m) {
    window.__posted.push(m);
    if (m.type === 'ready') setTimeout(() => window.postMessage({ type: 'init', payload: ${JSON.stringify(payload)} }, '*'));
    if (m.type === 'save') setTimeout(() => window.postMessage({ type: 'saved', ok: true }, '*'));
    if (m.type === 'readBytes') {
      const all = window.__bytes[m.side];
      const bin = atob(all);
      const part = bin.slice(m.offset, m.offset + m.length);
      setTimeout(() => window.postMessage({ type: 'bytes', id: m.id, base64: btoa(part) }, '*'), 20);
    }
  },
  getState() {}, setState() {}
};
</script></head><body class="vscode-${theme}"><div id="root"></div>
<script src="/dist/webview.js"></script></body></html>`;
  writeFileSync(join(out, `${name}-${theme}.html`), html);
}

const csvDoc = (label: string, text: string): TableDoc => ({ label, format: 'csv', sheets: [{ name: 'data.csv', rows: parseCsv(text, ','), formulas: {} }] });

const base = 'id,name,qty,price\n1,apple,5,1.20\n2,pear,3,0.80\n3,plum,1,2.00\n4,fig,7,3.10\n5,kiwi,2,0.50\n';
const ours = 'id,name,qty,price\n1,apple,6,1.20\n2,pear,3,0.80\n3,plum,1,2.10\n4,fig,7,3.10\n5,kiwi,2,0.50\n6,lime,4,0.30\n';
const theirs = 'id,name,qty,price\n1,Apple,5,1.20\n2,pear,3,0.85\n3,plum,1,2.25\n5,kiwi,2,0.50\n7,date,9,4.00\n';

async function main() {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Orders');
  s1.addRow(['order', 'customer', 'amount', 'total']);
  for (let i = 1; i <= 2000; i++) s1.addRow([i, `Customer ${i % 37}`, i * 3, { formula: `C${i + 1}*1.24`, result: i * 3 * 1.24 }]);
  wb.addWorksheet('Notes').addRow(['note']);
  const xlsx = await readWorkbook(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer));
  const xlsx2 = structuredClone(xlsx);
  xlsx2.sheets[0].rows[10][2] = '999';
  xlsx2.sheets[0].rows.splice(20, 1);
  xlsx2.sheets[0].rows.push(['2001', 'New customer', '1', '1.24']);
  xlsx2.sheets.push({ name: 'Extra', rows: [['x']], formulas: {} });

  const picA = png(320, 200, (x, y) => [40 + (x % 64), 90, 160 + (y % 60), 255]);
  const picB = png(320, 200, (x, y) => (x > 100 && x < 180 && y > 60 && y < 120 ? [240, 200, 40, 255] : [40 + (x % 64), 90, 160 + (y % 60), 255]));
  const picC = png(320, 200, (x, y) => [200, 60 + (y % 80), 60, 255]);
  const binA = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
  const binB = binA.slice();
  binB.set([1, 2, 3, 4], 100);
  binB[3000] = 0;
  const binB2 = new Uint8Array(5100);
  binB2.set(binB);
  const zip = async (files: Record<string, string>) => {
    const z = new JSZip();
    for (const [k, v] of Object.entries(files)) z.file(k, v);
    return z.generateAsync({ type: 'uint8array' });
  };
  const zb = await zip({ 'README.md': 'a', 'src/app.js': '1', 'src/util.js': '1', 'data/old.csv': 'x', 'img/logo.svg': '<svg/>' });
  const zo = await zip({ 'README.md': 'a', 'src/app.js': '2', 'src/util.js': 'u', 'data/old.csv': 'x', 'img/logo.svg': '<svg/>', 'src/new.js': 'n' });
  const zt = await zip({ 'README.md': 'b', 'src/app.js': '3', 'src/util.js': '1', 'img/logo.svg': '<svg/>' });

  for (const theme of ['dark', 'light'] as const) {
    page('picture-diff', { view: 'picture-diff', left: imgDoc('logo.png (HEAD)', picA), right: imgDoc('logo.png (Working Copy)', picB) }, theme);
    page('hex-diff', { view: 'hex-diff', left: fileDoc('fw.bin (HEAD)', binA), right: fileDoc('fw.bin', binB2), ...diffBytes(binA, binB2) }, theme, { left: binA, right: binB2 });
    page('archive-diff', { view: 'archive-diff', left: fileDoc('site.zip (main)', zb), right: fileDoc('site.zip', zo), entries: diffArchives(zb, zo) }, theme);
    page(
      'archive-merge',
      { view: 'archive-merge', base: fileDoc('site.zip (Base)', zb), ours: fileDoc('site.zip (Ours)', zo), theirs: fileDoc('site.zip (Theirs)', zt), entries: mergeArchives(zb, zo, zt), outputLabel: 'site.zip' },
      theme,
    );
    page(
      'folder-diff',
      {
        view: 'folder-diff',
        left: { label: 'main' },
        right: { label: 'feature/import (merge base 1a2b3c4)' },
        source: 'git',
        rows: [
          { path: 'src/core/table.ts', status: 'different', leftSize: null, rightSize: null },
          { path: 'src/core/merge.ts', status: 'right-only', leftSize: null, rightSize: null },
          { path: 'src/views/Grid.tsx', status: 'renamed', oldPath: 'src/views/Table.tsx', leftSize: null, rightSize: null },
          { path: 'docs/old.md', status: 'left-only', leftSize: null, rightSize: null },
          { path: 'package.json', status: 'different', leftSize: null, rightSize: null },
        ],
      },
      theme,
    );
    page(
      'folder-disk',
      {
        view: 'folder-diff',
        left: { label: 'site', detail: 'D:\\work\\site' },
        right: { label: 'site-backup', detail: 'D:\\backup\\site' },
        source: 'folders',
        rows: [
          { path: 'index.html', status: 'same', leftSize: 4210, rightSize: 4210 },
          { path: 'app.js', status: 'different', leftSize: 18200, rightSize: 18950 },
          { path: 'css/main.css', status: 'unknown', leftSize: 3200, rightSize: 3200 },
          { path: 'css/print.css', status: 'left-only', leftSize: 800, rightSize: null },
          { path: 'img/logo.png', status: 'same', leftSize: 12000, rightSize: 12000 },
          { path: 'img/hero.jpg', status: 'different', leftSize: 220000, rightSize: 220000 },
          { path: 'docs/notes.md', status: 'right-only', leftSize: null, rightSize: 950 },
          { path: 'docs/old/readme.txt', status: 'right-only', leftSize: null, rightSize: 120 },
        ],
      },
      theme,
    );
    page(
      'whole-merge',
      { view: 'whole-merge', kind: 'picture', base: imgDoc('logo.png (Base)', picA), ours: imgDoc('logo.png (Ours)', picB), theirs: imgDoc('logo.png (Theirs)', picC), outputLabel: 'img/logo.png' },
      theme,
    );
    page('diff-csv', { view: 'table-diff', left: csvDoc('data.csv (HEAD)', base), right: csvDoc('data.csv (Working Copy)', ours) }, theme);
    page(
      'diff-excel',
      { view: 'table-diff', left: { label: 'book.xlsx (main)', format: 'excel', sheets: xlsx.sheets }, right: { label: 'book.xlsx', format: 'excel', sheets: xlsx2.sheets } },
      theme,
    );
    page('view-excel', { view: 'table-view', doc: { label: 'book.xlsx', format: 'excel', sheets: xlsx.sheets } }, theme);
    page(
      'merge-csv',
      { view: 'table-merge', format: 'csv', base: csvDoc('data.csv (Base)', base), ours: csvDoc('data.csv (Ours)', ours), theirs: csvDoc('data.csv (Theirs)', theirs), outputLabel: 'data.csv' },
      theme,
    );
    page(
      'merge-excel',
      {
        view: 'table-merge',
        format: 'excel',
        base: { label: 'book.xlsx (Base)', format: 'excel', sheets: xlsx.sheets },
        ours: { label: 'book.xlsx (Ours)', format: 'excel', sheets: xlsx.sheets.map((s, i) => (i === 0 ? { ...s, rows: s.rows.map((r, j) => (j === 5 ? [r[0], r[1], '77', r[3]] : r)) } : s)) },
        theirs: { label: 'book.xlsx (Theirs)', format: 'excel', sheets: xlsx2.sheets },
        outputLabel: 'book.xlsx',
      },
      theme,
    );
  }
  console.log(`Harness pages written to ${out}`);
}

void main();
