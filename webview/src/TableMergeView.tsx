// Three-way table merge (CSV and Excel), in CompareCraft's table style: the
// merged result with a marker seam and overview, conflict blocks with their
// choices, and a detail bar for resolving the selected cell.
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, KeyRound, Save, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SheetPlan, SheetTable } from '../../src/core/excel';
import {
  conflictCount,
  defaultMergeOptions,
  materialize,
  mergeTables,
  resolveAll,
  resolveBlock,
  resolveCell,
  type BlockChoice,
  type MergeCell,
  type MergeOptions,
  type MergeRow,
  type Side,
  type TableMerge,
} from '../../src/core/tablemerge';
import type { MergeResult, TableDoc, TableMergeInit } from '../../src/shared/protocol';
import { plural, withFormulas } from './common';
import { MiniMap, type Mark } from './ui/MiniMap';
import { Counter, Dialog, ICON, LIST_ROW_H, PathBars3, SheetTabs, Stat, StatusBar, useNavKeys, type SheetTab } from './ui/ui';
import { onHostMessage, post } from './vscode';

type SheetChoice = 'keep' | 'drop';

interface SheetState {
  name: string;
  merge: TableMerge | null;
  /** Set when one side removed the sheet and the other changed it. */
  choice?: { note: string; keepLabel: string; dropLabel: string; selected: SheetChoice | null; keepPlan: SheetPlan | null; dropPlan: SheetPlan | null };
  /** Decided without asking: added on one side, or removed on one side and untouched on the other. */
  auto?: { note: string; plan: SheetPlan | null };
  oursRows: string[][];
}

const sameRows = (a: string[][], b: string[][]) =>
  a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => v === b[i][j]));

function sheetRows(doc: TableDoc | null, name: string): string[][] | null {
  const s = doc?.sheets.find((x) => x.name === name);
  return s ? (doc!.format === 'excel' ? withFormulas(s) : s.rows) : null;
}

function buildSheets(init: TableMergeInit, opts: MergeOptions): SheetState[] {
  const names: string[] = [];
  const add = (sheets: SheetTable[] | undefined) => sheets?.forEach((s) => !names.includes(s.name) && names.push(s.name));
  add(init.ours?.sheets);
  add(init.theirs?.sheets);
  // CSV: one sheet per side, possibly named differently; treat as the same sheet.
  if (init.format === 'csv') {
    const rows = (d: TableDoc | null) => (d ? d.sheets[0]?.rows ?? [] : []);
    const o = rows(init.ours);
    return [{ name: init.ours?.sheets[0]?.name ?? 'Table', merge: mergeTables(rows(init.base), o, rows(init.theirs), opts), oursRows: o }];
  }
  return names.map((name): SheetState => {
    const b = sheetRows(init.base, name), o = sheetRows(init.ours, name), t = sheetRows(init.theirs, name);
    if (o && t) return { name, merge: mergeTables(b ?? [], o, t, opts), oursRows: o };
    if (o) {
      if (!b) return { name, merge: null, oursRows: o, auto: { note: 'Added on ours.', plan: null } };
      if (sameRows(o, b)) return { name, merge: null, oursRows: o, auto: { note: 'Deleted on theirs.', plan: { name, action: 'delete' } } };
      return {
        name,
        merge: null,
        oursRows: o,
        choice: { note: 'Deleted on theirs, but changed on ours.', keepLabel: 'Keep the sheet', dropLabel: 'Delete the sheet', selected: null, keepPlan: null, dropPlan: { name, action: 'delete' } },
      };
    }
    if (!b) return { name, merge: null, oursRows: [], auto: { note: 'Added on theirs.', plan: { name, action: 'copy', from: 'theirs' } } };
    if (sameRows(t!, b)) return { name, merge: null, oursRows: [], auto: { note: 'Deleted on ours.', plan: null } };
    return {
      name,
      merge: null,
      oursRows: [],
      choice: { note: 'Deleted on ours, but changed on theirs.', keepLabel: 'Restore the sheet from theirs', dropLabel: 'Keep it deleted', selected: null, keepPlan: { name, action: 'copy', from: 'theirs' }, dropPlan: null },
    };
  });
}

function openConflicts(s: SheetState): number {
  return (s.merge ? conflictCount(s.merge) : 0) + (s.choice && s.choice.selected === null ? 1 : 0);
}


type DisplayRow =
  | { type: 'row'; item: number }
  | { type: 'banner'; item: number }
  | { type: 'side'; item: number; side: Side; row: number; first: boolean };

const BLOCK_CHOICES: [BlockChoice, string][] = [
  ['ours', 'Ours'],
  ['theirs', 'Theirs'],
  ['ours-then-theirs', 'Both, ours first'],
  ['theirs-then-ours', 'Both, theirs first'],
  ['base', 'Base'],
];

const rowH = LIST_ROW_H;
const headH = rowH + 4;
type Mk = 'conflict' | 'resolved' | 'ours' | 'theirs' | 'both' | null;
/** Overview colours: conflicts red, our changes teal, theirs violet, both amber. */
const markOf: Record<Exclude<Mk, null>, Mark['cls']> = { conflict: 'removed', resolved: 'unimp', ours: 'added', theirs: 'missing', both: 'changed' };

export function TableMergeView({ init }: { init: TableMergeInit }) {
  const [opts, setOpts] = useState<MergeOptions>(defaultMergeOptions);
  const [sheets, setSheets] = useState(() => buildSheets(init, defaultMergeOptions));
  const [version, setVersion] = useState(0);
  const [active, setActive] = useState(0);
  const [current, setCurrent] = useState(-1);
  const [sel, setSel] = useState<{ pos: number; col: number } | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [resetNote, setResetNote] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const bump = () => {
    setVersion((v) => v + 1);
    setSaveState('idle');
  };

  useEffect(() => onHostMessage((m) => m.type === 'saved' && setSaveState(m.ok ? 'saved' : 'failed')), []);

  const changeOpts = (next: MergeOptions) => {
    const hadResolutions = sheets.some((s) => s.merge?.items.some((i) => (i.type === 'block' ? i.choice !== null : i.cells.some((c) => c.resolved))));
    setOpts(next);
    setSheets(buildSheets(init, next));
    setResetNote(hadResolutions);
    setSel(null);
    bump();
  };

  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const merge = sheet.merge;
  const total = sheets.reduce((n, s) => n + openConflicts(s), 0);

  const display = useMemo(() => {
    const out: DisplayRow[] = [];
    merge?.items.forEach((item, i) => {
      if (item.type === 'row') out.push({ type: 'row', item: i });
      else {
        out.push({ type: 'banner', item: i });
        for (const side of ['ours', 'theirs', 'base'] as Side[]) item[side].forEach((row, k) => out.push({ type: 'side', item: i, side, row, first: k === 0 }));
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merge, version]);

  const baseValue = (row: MergeRow, c: number) => {
    const col = merge!.columns[c];
    return row.base !== null && col.base !== null ? (merge!.bodies.base[row.base][col.base] ?? '') : null;
  };
  /** Where a cell's value came from, when it isn't the base value. */
  const cellKind = (row: MergeRow, cell: MergeCell, c: number): Mk => {
    if (cell.conflict) return cell.resolved ? 'resolved' : 'conflict';
    const b = baseValue(row, c);
    if (b === cell.value && row.base !== null) return null;
    if (cell.src?.side === 'theirs' && (row.base !== null || row.ours === null)) return 'theirs';
    if (cell.src?.side === 'ours' && (row.base !== null || row.theirs === null)) return 'ours';
    return null;
  };

  /** One marker per display row. */
  const marks = useMemo((): Mk[] => {
    if (!merge) return [];
    return display.map((d) => {
      const item = merge.items[d.item];
      if (item.type === 'block') return item.choice ? 'resolved' : 'conflict';
      let k: Mk = null;
      for (let c = 0; c < item.cells.length; c++) {
        const m = cellKind(item, item.cells[c], c);
        if (m === 'conflict') return 'conflict';
        if (m === 'resolved') k = 'resolved';
        else if (m && k !== 'resolved') k = k && k !== m ? 'both' : m;
      }
      return k;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, merge, version]);
  const overview = useMemo(() => {
    const out: Mark[] = [];
    marks.forEach((m, i) => {
      if (!m) return;
      const cls = markOf[m];
      const last = out[out.length - 1];
      if (last && last.end === i && last.cls === cls) last.end = i + 1;
      else out.push({ start: i, end: i + 1, cls });
    });
    return out;
  }, [marks]);

  /** Positions of unresolved conflicts: block banners and rows with a conflicting cell. */
  const conflictRows = useMemo(() => {
    if (!merge) return [];
    return display.flatMap((d, i) => {
      const item = merge.items[d.item];
      if (d.type === 'banner') return item.type === 'block' && item.choice === null ? [i] : [];
      return d.type === 'row' && item.type === 'row' && item.cells.some((c) => c.conflict && !c.resolved) ? [i] : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, merge, version]);

  // Column widths in ch, from the header and a sample of the values.
  const widths = useMemo(() => {
    if (!merge) return [];
    const items = merge.items;
    const stride = Math.max(1, Math.floor(items.length / 4000));
    return merge.columns.map((col, c) => {
      let w = Math.max(col.name.length + 2, 3);
      for (let i = 0; i < items.length; i += stride) {
        const it = items[i];
        if (it.type === 'row') w = Math.max(w, (it.cells[c]?.value ?? '').length);
      }
      return Math.min(40, w + 2);
    });
  }, [merge]);
  const tableCh = widths.reduce((a, b) => a + b, 0);
  const numCh = 7;

  const virt = useVirtualizer({ count: display.length, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: 12, scrollMargin: headH });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientHeight && setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [merge]);

  const switchSheet = (i: number) => {
    setActive(i);
    setCurrent(-1);
    setSel(null);
  };
  const goto = (i: number) => {
    if (i < 0 || i >= conflictRows.length) return;
    setCurrent(i);
    const pos = conflictRows[i];
    virt.scrollToIndex(pos, { align: 'center' });
    const item = merge!.items[display[pos].item];
    if (item.type === 'row') setSel({ pos, col: Math.max(0, item.cells.findIndex((c) => c.conflict && !c.resolved)) });
    else setSel(null);
  };
  const next = () => {
    if (!conflictRows.length) {
      // Move on to the next sheet with conflicts.
      const n = sheets.findIndex((s, i) => i !== active && openConflicts(s) > 0);
      if (n >= 0) switchSheet(n);
      return;
    }
    const from = conflictRows.findIndex((p) => p > (current >= 0 ? conflictRows[current] : -1));
    goto(from >= 0 ? from : 0);
  };
  const prev = () => {
    if (!conflictRows.length) return next();
    const cur = current >= 0 ? conflictRows[current] : display.length;
    const from = conflictRows.findLastIndex((p) => p < cur);
    goto(from >= 0 ? from : conflictRows.length - 1);
  };
  useNavKeys(next, prev);

  const takeAll = (side: 'ours' | 'theirs') => {
    for (const s of sheets) {
      if (s.merge) resolveAll(s.merge, side);
      if (s.choice && s.choice.selected === null) s.choice.selected = side === 'ours' ? (s.oursRows.length ? 'keep' : 'drop') : s.oursRows.length ? 'drop' : 'keep';
    }
    bump();
  };

  const save = () => {
    let result: MergeResult;
    if (init.format === 'csv') {
      result = { format: 'csv', rows: materialize(sheets[0].merge!).rows };
    } else {
      const plans: SheetPlan[] = [];
      for (const s of sheets) {
        if (s.merge) {
          const table = materialize(s.merge);
          if (!sameRows(table.rows, s.oursRows)) plans.push({ name: s.name, action: 'merge', hasHeader: s.merge.hasHeader, table });
        } else if (s.auto?.plan) plans.push(s.auto.plan);
        else if (s.choice) {
          const plan = s.choice.selected === 'keep' ? s.choice.keepPlan : s.choice.dropPlan;
          if (plan) plans.push(plan);
        }
      }
      result = { format: 'excel', sheets: plans };
    }
    setSaveState('saving');
    post({ type: 'save', result });
  };

  const tabs: SheetTab[] = sheets.map((s) => {
    const n = openConflicts(s);
    return n ? { name: s.name, badge: String(n), tone: 'conflict', title: plural(n, 'conflict') } : { name: s.name };
  });

  const counts = useMemo(() => {
    const c = { conflict: 0, resolved: 0, ours: 0, theirs: 0, both: 0 };
    for (const s of sheets) {
      if (!s.merge) continue;
      for (const item of s.merge.items) {
        if (item.type === 'block') c[item.choice ? 'resolved' : 'conflict']++;
        else for (const cell of item.cells) if (cell.conflict) c[cell.resolved ? 'resolved' : 'conflict']++;
      }
    }
    for (const m of marks) if (m === 'ours' || m === 'theirs' || m === 'both') c[m]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, marks, version]);

  const curPos = current >= 0 ? conflictRows[current] : -1;
  const lineNo = (n: number | null) => (n === null ? null : n + (merge?.hasHeader ? 2 : 1));

  const renderRow = (pos: number) => {
    const d = display[pos];
    const item = merge!.items[d.item];
    if (d.type === 'banner' && item.type === 'block') {
      const describe = `${plural(item.ours.length, 'row')} on ours, ${plural(item.theirs.length, 'row')} on theirs`;
      return (
        <div className={`mg-banner ${item.choice ? 'resolved' : ''}`}>
          <span className="mg-banner-text">{item.choice ? 'Resolved' : 'Conflict'}: {describe}</span>
          <span className="seg sm" role="group" aria-label="Use">
            {BLOCK_CHOICES.filter(([c]) => c !== 'base' || item.base.length > 0).map(([c, label]) => (
              <button
                key={c}
                className={item.choice === c ? 'on' : ''}
                onClick={() => {
                  resolveBlock(merge!, d.item, item.choice === c ? null : c);
                  bump();
                }}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      );
    }
    if (d.type === 'side' && item.type === 'block') {
      const used = item.choice === d.side || ((item.choice === 'ours-then-theirs' || item.choice === 'theirs-then-ours') && d.side !== 'base');
      return (
        <div className={`tb-half mg-side mg-${d.side} ${item.choice && !used ? 'unused' : ''}`}>
          <span className="tb-num" style={{ width: `${numCh}ch` }} title={`${d.side} row ${d.row + 1}`}>{d.first ? d.side : ''}</span>
          <div className="tb-cells">
            {widths.map((w, c) => {
              const ci = merge!.columns[c][d.side];
              return (
                <span key={c} className={`tb-cell ${ci === null ? 's-nocol' : ''}`} style={{ width: `${w}ch` }}>
                  {ci === null ? '' : (merge!.bodies[d.side][d.row][ci] ?? '')}
                </span>
              );
            })}
          </div>
        </div>
      );
    }
    if (item.type !== 'row') return null;
    const num = item.ours !== null ? String(lineNo(item.ours)) : item.theirs !== null ? `T${lineNo(item.theirs)}` : '';
    return (
      <div className="tb-half">
        <span className="tb-num" style={{ width: `${numCh}ch` }} title={item.ours === null ? 'Row from theirs' : 'Row number on ours'}>{num}</span>
        <div className="tb-cells">
          {item.cells.map((cell, c) => {
            const k = cellKind(item, cell, c);
            const selected = sel?.pos === pos && sel.col === c;
            return (
              <span
                key={c}
                className={`tb-cell ${k ? `mg-${k}` : ''}${selected ? ' sel' : ''}`}
                style={{ width: `${widths[c]}ch` }}
                data-pos={pos}
                data-col={c}
                title={cell.conflict && !cell.resolved ? 'Conflict: select it and choose a value below' : undefined}
              >
                {cell.value}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  const selItem = sel && merge && display[sel.pos] ? merge.items[display[sel.pos].item] : null;
  const selRow = selItem?.type === 'row' && display[sel!.pos].type === 'row' ? selItem : null;

  return (
    <div className="view">
      <PathBars3 sides={[['ours', init.ours], ['base', init.base], ['theirs', init.theirs]]} />
      <div className="toolbar">
        <button className="icon-btn" title="Previous conflict (Alt+Up)" onClick={prev} disabled={total === 0}><ArrowUp size={ICON.lg} /></button>
        <button className="icon-btn" title="Next conflict (Alt+Down)" onClick={next} disabled={total === 0}><ArrowDown size={ICON.lg} /></button>
        <Counter current={current} total={conflictRows.length} none={total ? `${total} in other sheets` : 'No conflicts'} />
        <div className="divider-v" />
        <button className="btn ghost" onClick={() => takeAll('ours')} disabled={total === 0} title="Resolve every open conflict with the ours version">Take ours for the rest</button>
        <button className="btn ghost" onClick={() => takeAll('theirs')} disabled={total === 0} title="Resolve every open conflict with the theirs version">Take theirs for the rest</button>
        <div className="divider-v" />
        {merge && (
          <button className="btn ghost" onClick={() => setOptionsOpen(true)}><SlidersHorizontal size={ICON.md} /> Options</button>
        )}
        {merge && merge.keyColumns.length > 0 && (
          <span className="tb-keys" title={merge.autoKey ? 'Detected automatically' : 'Chosen in Options'}>
            <KeyRound size={ICON.sm} /> {merge.keyColumns.map((k) => merge.columns[k]?.name).join(', ')}
            {merge.autoKey ? ' (detected)' : ''}
          </span>
        )}
        <div className="grow" />
        {init.ours && <button className="btn ghost" onClick={() => post({ type: 'save', result: { format: 'whole', take: 'ours' } })} title="Write the ours file unchanged">Keep ours file</button>}
        {init.theirs && <button className="btn ghost" onClick={() => post({ type: 'save', result: { format: 'whole', take: 'theirs' } })} title="Write the theirs file unchanged">Take theirs file</button>}
        <button className="btn primary" onClick={save} disabled={total > 0 || saveState === 'saving'} title={total > 0 ? 'Resolve all conflicts first' : `Write the merged result to ${init.outputLabel}`}>
          <Save size={ICON.md} /> {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save merge'}
        </button>
      </div>
      {resetNote && (
        <div className="banner info">
          Changing the merge options started the merge over; earlier choices were cleared.
          <button className="btn sm" onClick={() => setResetNote(false)}>Dismiss</button>
        </div>
      )}
      {init.format === 'excel' && <div className="banner info">Formatting comes from ours. Charts, pivot tables and macros may not survive the rewrite; keep a copy if the workbook has them.</div>}
      {saveState === 'failed' && <div className="banner">Saving failed.</div>}
      {merge ? (
        <div className="tb-body">
          <div className="tb-main">
            <div
              className="tb-scroller tv-scroller"
              ref={scroller}
              tabIndex={0}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              onMouseDown={(e) => {
                const t = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]');
                if (t) setSel({ pos: Number(t.dataset.pos), col: Number(t.dataset.col) });
              }}
              style={{ '--tb-row': `${rowH}px` } as React.CSSProperties}
              aria-label="Merged table"
            >
              <div className="tb-row tb-head" style={{ height: headH, width: `calc(${numCh + tableCh}ch + var(--marker-seam-w))` }}>
                <div className="tb-seam" />
                <div className="tb-half">
                  <span className="tb-num" style={{ width: `${numCh}ch` }}>#</span>
                  <div className="tb-cells">
                    {merge.columns.map((c, i) => {
                      const added = c.ours === null ? 'theirs' : c.theirs === null && c.base === null ? 'ours' : null;
                      return (
                        <span key={i} className={`tb-cell tb-hcell ${added ? `mg-${added}` : ''}`} style={{ width: `${widths[i]}ch` }} title={added ? `Column added on ${added}` : c.name}>
                          {merge.keyColumns.includes(i) && <KeyRound size={ICON.sm} className="tb-key" />}
                          <span className="tb-hname">{c.name}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="tb-rows" style={{ height: virt.getTotalSize(), width: `calc(${numCh + tableCh}ch + var(--marker-seam-w))` }}>
                {virt.getVirtualItems().map((it) => {
                  const m = marks[it.index];
                  return (
                    <div key={it.key} className={`tb-row ${sel?.pos === it.index ? 'selrow' : ''}`} style={{ transform: `translateY(${it.start - headH}px)`, height: rowH }}>
                      <div
                        className={`tb-seam ${it.index === curPos ? 'current' : ''}`}
                        onMouseDown={() => {
                          const i = conflictRows.indexOf(it.index);
                          if (i >= 0) goto(i);
                        }}
                      >
                        {m && <span className={`tb-mark mg-mark-${m}`} />}
                      </div>
                      {renderRow(it.index)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <MiniMap total={display.length} marks={overview} viewStart={scrollTop / rowH} viewSize={(viewH - headH) / rowH} onJump={(p) => virt.scrollToOffset(Math.max(0, p * rowH - viewH / 2))} />
        </div>
      ) : (
        <SheetDecision
          sheet={sheet}
          onChoose={(c) => {
            sheet.choice!.selected = c;
            bump();
          }}
        />
      )}
      {merge && (
        <CellDetail
          key={sel ? `${sel.pos}:${sel.col}:${version}` : 'none'}
          merge={merge}
          row={selRow}
          col={sel?.col ?? 0}
          onResolve={(choice) => {
            resolveCell(merge, display[sel!.pos].item, sel!.col, choice);
            bump();
          }}
        />
      )}
      <SheetTabs tabs={tabs} active={active} onSelect={switchSheet} />
      {optionsOpen && merge && (
        <MergeOptionsDialog
          opts={opts}
          merge={merge}
          onClose={() => setOptionsOpen(false)}
          onApply={(o) => {
            setOptionsOpen(false);
            changeOpts(o);
          }}
        />
      )}
      <StatusBar>
        <Stat swatch="sw-conflict">{counts.conflict.toLocaleString()} unresolved</Stat>
        <Stat swatch="sw-edited">{counts.resolved.toLocaleString()} resolved</Stat>
        <Stat swatch="sw-ours">{plural(counts.ours, 'row')} changed by ours</Stat>
        <Stat swatch="sw-theirs">{counts.theirs.toLocaleString()} by theirs</Stat>
        {counts.both > 0 && <Stat swatch="sw-both">{counts.both.toLocaleString()} by both</Stat>}
        <span className="grow" />
        {merge && <span>{merge.keyColumns.length ? `Rows matched by ${merge.keyColumns.map((k) => merge.columns[k]?.name).join(', ')}` : 'Rows matched by content'}</span>}
        <span>Result: {init.outputLabel}</span>
      </StatusBar>
    </div>
  );
}

function SheetDecision({ sheet, onChoose }: { sheet: SheetState; onChoose(c: SheetChoice): void }) {
  if (sheet.auto) return <div className="center-state">{sheet.auto.note} Nothing to resolve.</div>;
  const c = sheet.choice!;
  return (
    <div className="center-state">
      <div>
        <p>{c.note}</p>
        <div className="seg" role="group">
          <button className={c.selected === 'keep' ? 'on' : ''} onClick={() => onChoose('keep')}>{c.keepLabel}</button>
          <button className={c.selected === 'drop' ? 'on' : ''} onClick={() => onChoose('drop')}>{c.dropLabel}</button>
        </div>
      </div>
    </div>
  );
}

/** The bottom bar: the selected cell's versions, and how to resolve a conflict. */
function CellDetail(props: { merge: TableMerge; row: MergeRow | null; col: number; onResolve(c: Side | { edited: string }): void }) {
  const cell = props.row?.cells[props.col];
  const [text, setText] = useState(cell?.value ?? '');
  if (!props.row || !cell) {
    return (
      <div className="tb-detail">
        <span className="tb-d-hint">Select a cell to see where its value came from; conflicts are resolved here.</span>
      </div>
    );
  }
  const name = props.merge.columns[props.col]?.name;
  if (!cell.conflict) {
    return (
      <div className="tb-detail">
        <span className="tb-d-col">{name}</span>
        <span className="tb-d-val mg-val">{cell.value === '' ? <em>empty</em> : cell.value}</span>
        <span className="tb-d-status">{cell.src ? `From ${cell.src.side}` : ''}</span>
      </div>
    );
  }
  const option = (side: Side, label: string) => (
    <span className={`mg-choice mg-${side} ${cell.resolved === side ? 'on' : ''}`}>
      <span className="mg-choice-label">{label}</span>
      <span className="tb-d-val">{cell.conflict![side] === '' ? <em>empty</em> : cell.conflict![side]}</span>
      <button className={`btn sm ${cell.resolved === side ? 'primary' : ''}`} onClick={() => props.onResolve(side)}>Use</button>
    </span>
  );
  return (
    <div className="tb-detail mg-detail">
      <span className="tb-d-col">{name}</span>
      {option('ours', 'Ours')}
      {option('base', 'Base')}
      {option('theirs', 'Theirs')}
      <span className="mg-edit">
        <input className="input mono" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && props.onResolve({ edited: text })} aria-label="Value to use" />
        <button className={`btn sm ${cell.resolved === 'edited' ? 'primary' : ''}`} onClick={() => props.onResolve({ edited: text })}>Set</button>
      </span>
      <span className="tb-d-status">{cell.resolved ? `Resolved: ${cell.resolved}` : 'Conflict'}</span>
    </div>
  );
}

function MergeOptionsDialog(props: { opts: MergeOptions; merge: TableMerge; onClose(): void; onApply(o: MergeOptions): void }) {
  const [o, setO] = useState<MergeOptions>({ ...props.opts, keyColumns: props.opts.keyColumns.length ? props.opts.keyColumns : [] });
  const toggleKey = (i: number) => setO({ ...o, autoKey: false, keyColumns: o.keyColumns.includes(i) ? o.keyColumns.filter((k) => k !== i) : [...o.keyColumns, i].sort((a, b) => a - b) });
  return (
    <Dialog
      title="Merge options"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={() => setO(defaultMergeOptions)}>Reset</button>
          <span className="tb-grow" />
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={() => props.onApply(o)}>Apply</button>
        </>
      }
    >
      <div className="hint">Applying starts the merge over, so choices made so far are cleared.</div>
      <h4>Format</h4>
      <label className="check">
        <input type="checkbox" checked={o.hasHeader} onChange={(e) => setO({ ...o, hasHeader: e.target.checked, keyColumns: [], autoKey: true })} />
        The first row contains column names
      </label>
      <label className="check">
        <input type="checkbox" checked={o.alignColumnsByName} disabled={!o.hasHeader} onChange={(e) => setO({ ...o, alignColumnsByName: e.target.checked, keyColumns: [], autoKey: true })} />
        Match columns by name instead of position
      </label>
      <h4>Key columns</h4>
      <div className="hint">
        Rows with the same key values are merged with each other, even if they moved. With none chosen, an id column is detected when there is one
        {props.merge.autoKey && props.merge.keyColumns.length ? ` (now: ${props.merge.keyColumns.map((k) => props.merge.columns[k]?.name).join(', ')})` : ''}; otherwise rows are matched by content.
      </div>
      <div className="tb-keylist">
        {props.merge.columns.map((c, i) => (
          <label key={i} className={`tb-keychip ${o.keyColumns.includes(i) ? 'on' : ''}`}>
            <input type="checkbox" checked={o.keyColumns.includes(i)} onChange={() => toggleKey(i)} />
            {c.name || `Column ${i + 1}`}
          </label>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={o.autoKey && o.keyColumns.length === 0} disabled={o.keyColumns.length > 0} onChange={(e) => setO({ ...o, autoKey: e.target.checked })} />
        Detect an id column when no key is chosen
      </label>
    </Dialog>
  );
}
