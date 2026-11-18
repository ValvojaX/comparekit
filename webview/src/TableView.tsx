// Table viewer for CSV/TSV and Excel files: one half of the table compare
// layout, with sorting, a row filter and a cell detail bar.
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Diff, FileText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { columnLetter } from '../../src/core/table';
import type { TableViewInit } from '../../src/shared/protocol';
import { hasFormulas, withFormulas } from './common';
import { ICON, LIST_ROW_H, SheetTabs, StatusBar } from './ui/ui';
import { post } from './vscode';

const rowH = LIST_ROW_H;
const headH = rowH + 4;

function compareValues(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function TableView({ init }: { init: TableViewInit }) {
  const { doc } = init;
  const [active, setActive] = useState(0);
  const [header, setHeader] = useState(true);
  const [formulas, setFormulas] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = doc.sheets[Math.min(active, doc.sheets.length - 1)];
  const isExcel = doc.format === 'excel';

  const all = useMemo(() => (sheet ? (formulas ? withFormulas(sheet) : sheet.rows) : []), [sheet, formulas]);
  const headRow = header && all.length > 0 ? all[0] : null;
  const width = useMemo(() => all.reduce((w, r) => Math.max(w, r.length), 0), [all]);

  // Body rows keep their row number in the file.
  const body = useMemo(() => {
    const start = headRow ? 1 : 0;
    let rows = all.slice(start).map((r, i) => ({ r, n: i + start + 1 }));
    const f = filter.trim().toLowerCase();
    if (f) rows = rows.filter(({ r }) => r.some((v) => v.toLowerCase().includes(f)));
    if (sort) rows = rows.slice().sort((a, b) => sort.dir * compareValues(a.r[sort.col] ?? '', b.r[sort.col] ?? ''));
    return rows;
  }, [all, headRow, filter, sort]);
  useEffect(() => setSel(null), [body]);

  const colName = (c: number) => (headRow ? (headRow[c] ?? '') : isExcel ? columnLetter(c) : `Column ${c + 1}`);
  const widths = useMemo(() => {
    const stride = Math.max(1, Math.floor(all.length / 4000));
    return Array.from({ length: width }, (_, c) => {
      let w = Math.max(colName(c).length + 2, 3);
      for (let i = 0; i < all.length; i += stride) w = Math.max(w, (all[i][c] ?? '').length);
      return Math.min(40, w + 2);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, width, headRow]);
  const tableCh = widths.reduce((a, b) => a + b, 0);
  const numCh = String(all.length).length + 2;

  const virt = useVirtualizer({ count: body.length, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: 12, scrollMargin: headH });

  const clickHeader = (c: number) => setSort((s) => (s?.col !== c ? { col: c, dir: 1 } : s.dir === 1 ? { col: c, dir: -1 } : null));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !body.length) return;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / rowH) - 2);
    const cur = sel ?? { row: 0, col: 0 };
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-page, 0], PageDown: [page, 0] };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const [dr, dc] = moves[e.key];
    const to = { row: Math.max(0, Math.min(body.length - 1, cur.row + dr)), col: Math.max(0, Math.min(width - 1, cur.col + dc)) };
    setSel(to);
    virt.scrollToIndex(to.row, { align: 'auto' });
  };

  const selected = sel ? body[sel.row] : null;
  const rowsLabel = `${filter ? `${body.length.toLocaleString()} of ` : ''}${Math.max(0, all.length - (headRow ? 1 : 0)).toLocaleString()} rows`;

  return (
    <div className="view">
      <div className="pathbars one">
        <div className="pathbar">
          <input className="input" value={doc.label} readOnly title={doc.detail ?? doc.label} />
          <span className="ro-tag">read-only</span>
        </div>
      </div>
      <div className="toolbar">
        <div className="cc-filter">
          <Search size={ICON.md} />
          <input className="input" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        </div>
        <div className="divider-v" />
        <button className={`btn ghost ${header ? 'cc-on' : ''}`} aria-pressed={header} onClick={() => { setHeader((h) => !h); setSort(null); }} title="The first row contains column names">
          Header row
        </button>
        {isExcel && hasFormulas(doc.sheets) && (
          <button className={`btn ghost ${formulas ? 'cc-on' : ''}`} aria-pressed={formulas} onClick={() => setFormulas((f) => !f)} title="Show formulas instead of their results">
            Formulas
          </button>
        )}
        <div className="grow" />
        <button className="btn" onClick={() => post({ type: 'compareWith' })} title="Compare this file with a revision or another file">
          <Diff size={ICON.md} /> Compare with…
        </button>
        {!isExcel && (
          <button className="btn ghost" onClick={() => post({ type: 'openAsText' })} title="Reopen in the text editor">
            <FileText size={ICON.md} /> Open as text
          </button>
        )}
      </div>
      {doc.notes?.length ? <div className="banner cc-notes">{doc.notes.join(' ')}</div> : null}
      {!sheet || all.length === 0 ? (
        <div className="center-state">This sheet is empty.</div>
      ) : (
        <div className="tb-body">
          <div className="tb-main">
            <div
              className="tb-scroller tv-scroller"
              ref={scroller}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onMouseDown={(e) => {
                const t = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
                if (t) setSel({ row: Number(t.dataset.row), col: Number(t.dataset.col) });
              }}
              style={{ '--tb-row': `${rowH}px` } as React.CSSProperties}
            >
              <div className="tb-row tb-head" style={{ height: headH, width: `calc(${numCh + tableCh}ch)` }}>
                <div className="tb-half">
                  <span className="tb-num" style={{ width: `${numCh}ch` }}>#</span>
                  <div className="tb-cells">
                    {widths.map((w, c) => (
                      <span key={c} className="tb-cell tb-hcell tv-sortable" style={{ width: `${w}ch` }} onClick={() => clickHeader(c)} title={`Sort by ${colName(c)}`}>
                        <span className="tb-hname">{colName(c)}</span>
                        {sort?.col === c && (sort.dir === 1 ? <ArrowUp size={ICON.sm} /> : <ArrowDown size={ICON.sm} />)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {body.length === 0 ? (
                <div className="center-state tb-empty">No rows match the filter.</div>
              ) : (
                <div className="tb-rows" style={{ height: virt.getTotalSize(), width: `calc(${numCh + tableCh}ch)` }}>
                  {virt.getVirtualItems().map((it) => {
                    const { r, n } = body[it.index];
                    return (
                      <div key={it.key} className={`tb-row ${sel?.row === it.index ? 'selrow' : ''}`} style={{ transform: `translateY(${it.start - headH}px)`, height: rowH }}>
                        <div className="tb-half">
                          <span className="tb-num" style={{ width: `${numCh}ch` }}>{n}</span>
                          <div className="tb-cells">
                            {widths.map((w, c) => (
                              <span key={c} className={`tb-cell${sel?.row === it.index && sel.col === c ? ' sel' : ''}`} style={{ width: `${w}ch` }} data-row={it.index} data-col={c}>
                                {r[c] ?? ''}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="tb-detail">
        {selected && sel ? (
          <>
            <span className="tb-d-col">{colName(sel.col)}</span>
            <span className="tb-d-rows">Row {selected.n}</span>
            <span className="tb-d-val tv-val" title={selected.r[sel.col] ?? ''}>
              {(selected.r[sel.col] ?? '') === '' ? <em>empty</em> : selected.r[sel.col]}
            </span>
          </>
        ) : (
          <span className="tb-d-hint">Select a cell to see its value in full.</span>
        )}
      </div>
      <SheetTabs tabs={doc.sheets.map((s) => ({ name: s.name }))} active={active} onSelect={(i) => { setActive(i); setSort(null); }} />
      <StatusBar>
        <span>{rowsLabel}</span>
        <span>{width.toLocaleString()} columns</span>
        <span className="grow" />
        {sort && <span>Sorted by {colName(sort.col)} ({sort.dir === 1 ? 'ascending' : 'descending'})</span>}
        <span>{isExcel ? 'Excel workbook' : 'Delimited text'}</span>
      </StatusBar>
    </div>
  );
}
