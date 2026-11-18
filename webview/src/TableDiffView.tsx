// Table compare: CompareCraft's table view (two halves around a marker seam,
// an overview strip, a cell detail bar and a status bar), with worksheet tabs
// for Excel.
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, FileText, KeyRound, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SheetTable } from '../../src/core/excel';
import { defaultTableOptions, diffTables, type CellStatus, type TableDiff, type TableOptions, type TableRow } from '../../src/core/table';
import type { TableDiffInit } from '../../src/shared/protocol';
import { hasFormulas, withFormulas } from './common';
import { MiniMap, type Mark, type MarkClass } from './ui/MiniMap';
import { Counter, Dialog, ICON, LIST_ROW_H, PathBars, SheetTabs, Stat, StatusBar, useNavKeys, type SheetTab } from './ui/ui';
import { post } from './vscode';

type SideName = 'left' | 'right';

interface SheetPair {
  name: string;
  left: SheetTable | null;
  right: SheetTable | null;
}

function pairSheets(left: SheetTable[], right: SheetTable[]): SheetPair[] {
  const pairs: SheetPair[] = left.map((l) => ({ name: l.name, left: l, right: right.find((r) => r.name === l.name) ?? null }));
  for (const r of right) if (!left.some((l) => l.name === r.name)) pairs.push({ name: r.name, left: null, right: r });
  // A single sheet each with different names (CSV files, renamed sheet): pair them.
  if (left.length === 1 && right.length === 1 && pairs.length === 2) return [{ name: left[0].name, left: left[0], right: right[0] }];
  return pairs;
}

/** Row status, optionally ignoring cells in columns that exist on one side only. */
function rowClass(r: TableRow, ignored: Set<number> | null): MarkClass | null {
  if (r.kind === 'left-only') return 'removed';
  if (r.kind === 'right-only') return 'added';
  if (r.kind !== 'changed') return null;
  if (!ignored?.size) return r.important ? 'changed' : 'unimp';
  let any = false;
  for (let i = 0; i < r.cells.length; i++) {
    if (ignored.has(i) || r.cells[i] === 'same') continue;
    if (r.cells[i] === 'different' || r.cells[i] === 'missing') return 'changed';
    any = true;
  }
  return any ? 'unimp' : null;
}

/** The column header is a row plus --space-1. */
const HEAD_PAD = 4;
const rowH = LIST_ROW_H;
const headH = rowH + HEAD_PAD;

const statusLabel: Record<CellStatus, string> = { same: 'Same', similar: 'Unimportant difference', different: 'Different', missing: 'Missing on one side' };

export function TableDiffView({ init }: { init: TableDiffInit }) {
  const [swapped, setSwapped] = useState(false);
  const leftDoc = swapped ? init.right : init.left;
  const rightDoc = swapped ? init.left : init.right;
  const sheets = useMemo(() => pairSheets(leftDoc.sheets, rightDoc.sheets), [leftDoc, rightDoc]);
  const [active, setActive] = useState(0);
  const [formulas, setFormulas] = useState(false);
  const [options, setOptions] = useState<TableOptions>(defaultTableOptions);
  const showFormulaToggle = init.left.format === 'excel' && hasFormulas(sheets.flatMap((s) => [s.left, s.right]));
  const rowsOf = useCallback((s: SheetTable | null) => (s ? (formulas ? withFormulas(s) : s.rows) : []), [formulas]);
  const diffs = useMemo(() => sheets.map((s) => diffTables(rowsOf(s.left), rowsOf(s.right), options)), [sheets, options, rowsOf]);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const diff: TableDiff = diffs[Math.min(active, sheets.length - 1)];

  const [diffsOnly, setDiffsOnly] = useState(false);
  const [ignoreUnmatched, setIgnoreUnmatched] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sx, setSx] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const barL = useRef<HTMLDivElement>(null);
  const barR = useRef<HTMLDivElement>(null);

  const ignored = useMemo(() => {
    if (!ignoreUnmatched) return null;
    return new Set(diff.columns.flatMap((c, i) => (c.left == null || c.right == null ? [i] : [])));
  }, [diff, ignoreUnmatched]);
  const classes = useMemo(() => diff.rows.map((r) => rowClass(r, ignored)), [diff, ignored]);
  const counts = useMemo(() => {
    const c = { changed: 0, unimp: 0, removed: 0, added: 0 };
    for (const k of classes) if (k && k !== 'missing') c[k]++;
    return c;
  }, [classes]);

  /** Indexes into diff.rows that are displayed. */
  const shown = useMemo(() => {
    const out: number[] = [];
    classes.forEach((k, i) => {
      if (!diffsOnly || k) out.push(i);
    });
    return out;
  }, [classes, diffsOnly]);

  /** Runs of differing rows (positions in `shown`), for the overview. */
  const runs = useMemo(() => {
    const out: Mark[] = [];
    shown.forEach((ri, pos) => {
      const cls = classes[ri];
      if (!cls) return;
      const last = out[out.length - 1];
      if (last && last.end === pos && last.cls === cls) last.end = pos + 1;
      else out.push({ start: pos, end: pos + 1, cls });
    });
    return out;
  }, [shown, classes]);
  /** Positions (in `shown`) of every differing row, for navigation. */
  const diffPos = useMemo(() => runs.flatMap((r) => Array.from({ length: r.end - r.start }, (_, k) => r.start + k)), [runs]);

  // Column widths in ch, from the headers and a sample of the values.
  const widths = useMemo(() => {
    const n = Math.max(diff.leftRows.length, diff.rightRows.length);
    const stride = Math.max(1, Math.floor(n / 4000));
    return diff.columns.map((c) => {
      let w = Math.max(c.name.length + (options.keyColumns.includes(c.left ?? -1) ? 3 : 0), 3);
      const measure = (rows: string[][], idx: number | null) => {
        if (idx == null) return;
        for (let i = 0; i < rows.length; i += stride) w = Math.max(w, (rows[i][idx] ?? '').length);
      };
      measure(diff.leftRows, c.left);
      measure(diff.rightRows, c.right);
      if (c.right != null) w = Math.max(w, (diff.rightHeader[c.right] ?? '').length);
      return Math.min(40, w + 2);
    });
  }, [diff, options.keyColumns]);
  const tableCh = widths.reduce((a, b) => a + b, 0);
  const numCh = String(Math.max(diff.leftRows.length, diff.rightRows.length) + 1).length + 2;
  /** Row numbers as in the file: the header is row 1. */
  const lineOf = (i: number) => i + (options.hasHeader && (diff.leftHeader.length || diff.rightHeader.length) ? 2 : 1);

  const virt = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH,
    overscan: 12,
    scrollMargin: headH,
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientHeight && setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Horizontal scrolling: the two scrollbars and shift/trackpad wheel share one offset.
  const syncBars = (x: number, from?: HTMLDivElement | null) => {
    for (const b of [barL.current, barR.current]) if (b && b !== from && Math.abs(b.scrollLeft - x) > 0.5) b.scrollLeft = x;
    setSx(x);
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (!dx || !barL.current) return;
      e.preventDefault();
      barL.current.scrollLeft += dx;
      syncBars(barL.current.scrollLeft, barL.current);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const has = diffPos.length > 0;
  const firstDiffCol = (r: TableRow) => Math.max(0, r.cells.findIndex((c) => c !== 'same'));
  const goto = (i: number) => {
    if (i < 0 || i >= diffPos.length) return;
    setCurrent(i);
    const pos = diffPos[i];
    const el = scroller.current;
    const y = pos * rowH;
    // Only scroll when the row is outside the middle of the view.
    if (!el || y < el.scrollTop + el.clientHeight * 0.15 || y > el.scrollTop + el.clientHeight * 0.85) virt.scrollToIndex(pos, { align: 'center' });
    setSel({ row: pos, col: firstDiffCol(diff.rows[shown[pos]]) });
  };
  const visibleRun = () => diffPos.findIndex((p) => p >= Math.floor(scrollTop / rowH));
  const next = () => {
    if (!has) return;
    const from = current >= 0 ? current + 1 : Math.max(0, visibleRun());
    if (from < diffPos.length) goto(from);
  };
  const prev = () => {
    if (!has) return;
    const from = current >= 0 ? current - 1 : visibleRun() - 1;
    if (from >= 0) goto(from);
  };
  useNavKeys(next, prev);
  useEffect(() => {
    setSel(null);
    setCurrent(-1);
  }, [diffsOnly, diff]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !shown.length) return;
    const cols = diff.columns.length;
    const page = Math.max(1, Math.floor(viewH / rowH) - 2);
    const cur = sel ?? { row: Math.floor(scrollTop / rowH), col: 0 };
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-page, 0], PageDown: [page, 0] };
    let to: { row: number; col: number } | null = null;
    if (e.key in moves) {
      const [dr, dc] = moves[e.key];
      to = { row: Math.max(0, Math.min(shown.length - 1, cur.row + dr)), col: Math.max(0, Math.min(cols - 1, cur.col + dc)) };
    } else if (e.key === 'Home') to = { row: 0, col: cur.col };
    else if (e.key === 'End') to = { row: shown.length - 1, col: cur.col };
    if (!to) return;
    e.preventDefault();
    setSel(to);
    virt.scrollToIndex(to.row, { align: 'auto' });
    revealColumn(to.col);
  };

  /** Scroll horizontally so a column is visible. */
  const revealColumn = (col: number) => {
    const bar = barL.current;
    if (!bar) return;
    const ch = bar.scrollWidth / Math.max(1, tableCh);
    const x0 = widths.slice(0, col).reduce((a, b) => a + b, 0) * ch;
    const x1 = x0 + widths[col] * ch;
    let x = bar.scrollLeft;
    if (x0 < x) x = x0;
    else if (x1 > x + bar.clientWidth) x = x1 - bar.clientWidth;
    if (x !== bar.scrollLeft) {
      bar.scrollLeft = x;
      syncBars(bar.scrollLeft, bar);
    }
  };

  const selRow = sel ? diff.rows[shown[sel.row]] : null;
  const selCol = sel ? diff.columns[sel.col] : null;
  const cellValue = (side: SideName, r: TableRow | null, colIdx: number | null) => {
    if (!r || colIdx == null) return null;
    const ri = side === 'left' ? r.left : r.right;
    if (ri == null) return null;
    return (side === 'left' ? diff.leftRows : diff.rightRows)[ri]?.[colIdx] ?? '';
  };

  const curPos = current >= 0 ? diffPos[current] : -1;
  const items = virt.getVirtualItems();
  const keyCols = options.keyColumns;
  const keyNames = keyCols.map((k) => diff.leftHeader[k] ?? `#${k + 1}`);

  const renderHalf = (side: SideName, r: TableRow, pos: number) => {
    const ri = side === 'left' ? r.left : r.right;
    const rows = side === 'left' ? diff.leftRows : diff.rightRows;
    const orphan = ri == null;
    const tint = r.kind === 'left-only' ? 'tint-removed' : r.kind === 'right-only' ? 'tint-added' : '';
    return (
      <div className={`tb-half ${orphan ? 'cc-hatch' : tint}`}>
        <span className="tb-num" style={{ width: `${numCh}ch` }}>{ri != null ? lineOf(ri) : ''}</span>
        <div className="tb-clip">
          <div className="tb-cells" style={{ transform: `translateX(${-sx}px)` }}>
            {!orphan &&
              diff.columns.map((c, ci) => {
                const idx = side === 'left' ? c.left : c.right;
                const st = r.kind === 'changed' && !ignored?.has(ci) ? r.cells[ci] : 'same';
                const selected = sel?.row === pos && sel.col === ci;
                return (
                  <span key={ci} className={`tb-cell s-${idx == null ? 'nocol' : st}${selected ? ' sel' : ''}`} style={{ width: `${widths[ci]}ch` }} data-row={pos} data-col={ci}>
                    {idx != null ? (rows[ri][idx] ?? '') : ''}
                  </span>
                );
              })}
          </div>
        </div>
      </div>
    );
  };

  const renderHead = (side: SideName) => (
    <div className="tb-half">
      <span className="tb-num" style={{ width: `${numCh}ch` }}>#</span>
      <div className="tb-clip">
        <div className="tb-cells" style={{ transform: `translateX(${-sx}px)` }}>
          {diff.columns.map((c, ci) => {
            const idx = side === 'left' ? c.left : c.right;
            const name = idx == null ? c.name : ((side === 'left' ? diff.leftHeader : diff.rightHeader)[idx] ?? c.name);
            const isKey = c.left != null && keyCols.includes(c.left);
            return (
              <span key={ci} className={`tb-cell tb-hcell ${idx == null ? 'missing-col cc-hatch' : ''}`} style={{ width: `${widths[ci]}ch` }} title={idx == null ? `${c.name} only exists on the ${side === 'left' ? 'right' : 'left'}` : name}>
                {isKey && <KeyRound size={ICON.sm} className="tb-key" />}
                <span className="tb-hname">{name}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );

  const unmatched = diff.columns.filter((c) => c.left == null || c.right == null).length;
  const oneSided = !sheet.left || !sheet.right;
  const summary = oneSided || counts.changed + counts.removed + counts.added > 0 ? null : diff.rows.every((r) => r.kind === 'same') ? 'identical' : 'equivalent';
  const tabs: SheetTab[] = sheets.map((s, i) => {
    if (!s.left || !s.right) return { name: s.name, badge: s.left ? 'left only' : 'right only', tone: 'missing' };
    return diffs[i].equivalent ? { name: s.name } : { name: s.name, badge: '●', tone: 'changed', title: 'Has differences' };
  });
  const notes = [...(init.left.notes ?? []), ...(init.right.notes ?? [])];

  return (
    <div className="view">
      <PathBars
        left={leftDoc}
        right={rightDoc}
        onSwap={() => setSwapped((s) => !s)}
        rightActions={
          <button className="icon-btn" title="Open both as text in VS Code's diff editor" onClick={() => post({ type: 'openAsText' })}>
            <FileText size={ICON.lg} />
          </button>
        }
      />
      <div className="toolbar">
        <button className="icon-btn" title="Previous different row (Alt+Up)" onClick={prev} disabled={!has}><ArrowUp size={ICON.lg} /></button>
        <button className="icon-btn" title="Next different row (Alt+Down)" onClick={next} disabled={!has}><ArrowDown size={ICON.lg} /></button>
        <Counter current={current} total={diffPos.length} />
        <div className="divider-v" />
        <div className="seg" role="group" aria-label="Rows to show">
          <button className={!diffsOnly ? 'on' : ''} onClick={() => setDiffsOnly(false)}>All rows</button>
          <button className={diffsOnly ? 'on' : ''} onClick={() => setDiffsOnly(true)}>Differences only</button>
        </div>
        <div className="divider-v" />
        <button className={`btn ghost ${options.ignoreCase ? 'cc-on' : ''}`} aria-pressed={options.ignoreCase} onClick={() => setOptions({ ...options, ignoreCase: !options.ignoreCase })}>Ignore case</button>
        <button className={`btn ghost ${options.trimWhitespace ? 'cc-on' : ''}`} aria-pressed={options.trimWhitespace} onClick={() => setOptions({ ...options, trimWhitespace: !options.trimWhitespace })}>Trim whitespace</button>
        {unmatched > 0 && (
          <button className={`btn ghost ${ignoreUnmatched ? 'cc-on' : ''}`} aria-pressed={ignoreUnmatched} onClick={() => setIgnoreUnmatched((x) => !x)} title="Columns that exist on only one side">
            Ignore unmatched columns
          </button>
        )}
        {showFormulaToggle && (
          <button className={`btn ghost ${formulas ? 'cc-on' : ''}`} aria-pressed={formulas} onClick={() => setFormulas((f) => !f)} title="Compare formulas instead of their results">
            Formulas
          </button>
        )}
        <button className="btn ghost" onClick={() => setOptionsOpen(true)}><SlidersHorizontal size={ICON.md} /> Options</button>
        <div className="grow" />
        {keyNames.length > 0 && <span className="tb-keys"><KeyRound size={ICON.sm} /> {keyNames.join(', ')}</span>}
      </div>
      {notes.length > 0 && <div className="banner cc-notes">{notes.join(' ')}</div>}
      {oneSided && <div className="banner info">This sheet only exists on the {sheet.left ? 'left' : 'right'}.</div>}
      {summary === 'identical' && <div className="banner ok">The tables are identical.</div>}
      {summary === 'equivalent' && <div className="banner info">The tables differ only in ways your options treat as unimportant.</div>}
      <div className="tb-body">
        <div className="tb-main">
          <div
            className="tb-scroller"
            ref={scroller}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onMouseDown={(e) => {
              const t = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
              if (t) setSel({ row: Number(t.dataset.row), col: Number(t.dataset.col) });
            }}
            style={{ '--tb-row': `${rowH}px` } as React.CSSProperties}
            aria-label="Table comparison"
          >
            <div className="tb-row tb-head" style={{ height: headH }}>
              {renderHead('left')}
              <div className="tb-seam" />
              {renderHead('right')}
            </div>
            {shown.length === 0 ? (
              <div className="center-state tb-empty">{diffsOnly ? 'No different rows.' : 'Both tables are empty.'}</div>
            ) : (
              <div className="tb-rows" style={{ height: virt.getTotalSize() }}>
                {items.map((it) => {
                  const r = diff.rows[shown[it.index]];
                  const cls = classes[shown[it.index]];
                  return (
                    <div key={it.key} className={`tb-row ${sel?.row === it.index ? 'selrow' : ''}`} style={{ transform: `translateY(${it.start - headH}px)`, height: rowH }}>
                      {renderHalf('left', r, it.index)}
                      <div
                        className={`tb-seam ${it.index === curPos ? 'current' : ''}`}
                        onMouseDown={() => {
                          const i = diffPos.indexOf(it.index);
                          if (i >= 0) goto(i);
                        }}
                      >
                        {cls && <span className={`tb-mark m-${cls}`} />}
                      </div>
                      {renderHalf('right', r, it.index)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="tb-hbars">
            <div className="tb-hbar" ref={barL} onScroll={(e) => syncBars(e.currentTarget.scrollLeft, e.currentTarget)} style={{ marginLeft: `${numCh}ch` }}>
              <div style={{ width: `${tableCh}ch` }} />
            </div>
            <div className="tb-seam tb-seam-bar" />
            <div className="tb-hbar" ref={barR} onScroll={(e) => syncBars(e.currentTarget.scrollLeft, e.currentTarget)} style={{ marginLeft: `${numCh}ch` }}>
              <div style={{ width: `${tableCh}ch` }} />
            </div>
          </div>
        </div>
        <MiniMap total={shown.length} marks={runs} viewStart={scrollTop / rowH} viewSize={(viewH - headH) / rowH} onJump={(p) => virt.scrollToOffset(Math.max(0, p * rowH - viewH / 2))} />
      </div>
      <div className="tb-detail">
        {selRow && selCol ? (
          <>
            <span className="tb-d-col">{selCol.name}</span>
            <span className="tb-d-rows">
              Row {selRow.left != null ? lineOf(selRow.left) : '—'} ↔ {selRow.right != null ? lineOf(selRow.right) : '—'}
            </span>
            <DetailValue side="left" value={cellValue('left', selRow, selCol.left)} />
            <span className="tb-d-arrow">→</span>
            <DetailValue side="right" value={cellValue('right', selRow, selCol.right)} />
            <span className="tb-d-status">
              {selRow.kind === 'left-only' ? 'Only in left' : selRow.kind === 'right-only' ? 'Only in right' : statusLabel[selRow.cells[sel!.col]]}
            </span>
          </>
        ) : (
          <span className="tb-d-hint">Select a cell to see both values in full.</span>
        )}
      </div>
      <SheetTabs
        tabs={tabs}
        active={active}
        onSelect={(i) => {
          setActive(i);
          setCurrent(-1);
        }}
      />
      {optionsOpen && (
        <OptionsDialog
          options={options}
          diff={diff}
          onClose={() => setOptionsOpen(false)}
          onApply={(o) => {
            setOptions(o);
            setOptionsOpen(false);
          }}
        />
      )}
      <StatusBar>
        <span>{diff.rows.length.toLocaleString()} rows compared</span>
        <Stat swatch="tb-sw-diff">{counts.changed.toLocaleString()} different</Stat>
        {counts.unimp > 0 && <Stat swatch="tb-sw-unimp">{counts.unimp.toLocaleString()} unimportant</Stat>}
        <Stat swatch="tb-sw-removed">{counts.removed.toLocaleString()} only in left</Stat>
        <Stat swatch="tb-sw-added">{counts.added.toLocaleString()} only in right</Stat>
        <span className="grow" />
        <span>{keyNames.length ? `Matched by ${keyNames.join(', ')}` : 'Matched by row content'}</span>
      </StatusBar>
    </div>
  );
}

function DetailValue({ side, value }: { side: SideName; value: string | null }) {
  return (
    <span className={`tb-d-val ${side}`} title={value ?? undefined}>
      {value == null ? <em>none</em> : value === '' ? <em>empty</em> : value}
    </span>
  );
}

function OptionsDialog(props: { options: TableOptions; diff: TableDiff; onClose: () => void; onApply: (o: TableOptions) => void }) {
  const [o, setO] = useState<TableOptions>(props.options);
  const leftCols = props.diff.leftHeader.length ? props.diff.leftHeader : props.diff.columns.filter((c) => c.left != null).map((c) => c.name);
  const toggleKey = (i: number) => setO({ ...o, keyColumns: o.keyColumns.includes(i) ? o.keyColumns.filter((k) => k !== i) : [...o.keyColumns, i].sort((a, b) => a - b) });
  return (
    <Dialog
      title="Table comparison options"
      onClose={props.onClose}
      size="md"
      footer={
        <>
          <button className="btn" onClick={() => setO(defaultTableOptions)}>Reset</button>
          <span className="tb-grow" />
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={() => props.onApply(o)}>Apply</button>
        </>
      }
    >
      <h4>Format</h4>
      <label className="check">
        <input type="checkbox" checked={o.hasHeader} onChange={(e) => setO({ ...o, hasHeader: e.target.checked, keyColumns: [] })} />
        The first row contains column names
      </label>
      <label className="check">
        <input type="checkbox" checked={o.alignColumnsByName} disabled={!o.hasHeader} onChange={(e) => setO({ ...o, alignColumnsByName: e.target.checked })} />
        Match columns by name instead of position
      </label>
      <h4>Key columns</h4>
      <div className="hint">Rows with the same key values are compared with each other, even if they moved. Leave empty to match rows by content.</div>
      <div className="tb-keylist">
        {leftCols.map((name, i) => (
          <label key={i} className={`tb-keychip ${o.keyColumns.includes(i) ? 'on' : ''}`}>
            <input type="checkbox" checked={o.keyColumns.includes(i)} onChange={() => toggleKey(i)} />
            {name || `Column ${i + 1}`}
          </label>
        ))}
      </div>
      <h4>Values</h4>
      <label className="check">
        <input type="checkbox" checked={o.ignoreCase} onChange={(e) => setO({ ...o, ignoreCase: e.target.checked })} />
        Ignore case
      </label>
      <label className="check">
        <input type="checkbox" checked={o.trimWhitespace} onChange={(e) => setO({ ...o, trimWhitespace: e.target.checked })} />
        Ignore leading and trailing whitespace
      </label>
      <div className="field">
        <span>Numeric tolerance</span>
        <input className="input mono" type="number" min={0} step="any" value={o.numericTolerance} onChange={(e) => setO({ ...o, numericTolerance: Math.max(0, Number(e.target.value) || 0) })} />
      </div>
      <div className="hint">Numbers that differ by no more than this are treated as an unimportant difference.</div>
    </Dialog>
  );
}
