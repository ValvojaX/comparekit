// Folder compare, after CompareCraft's folder view: a tree with the left and
// right halves around a status seam. Folder comparisons check same-size files
// byte by byte in the background; git comparisons list the changed files.
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronRight, ChevronsDownUp, ChevronsUpDown, File as FileIcon, Folder as FolderIcon, FolderOpen, FolderX, ListFilter, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { formatSize } from '../../src/core/bytes';
import type { FolderRow, FolderStatus } from '../../src/core/folder';
import type { FolderDiffInit } from '../../src/shared/protocol';
import { ICON, LIST_ROW_H, PathBars, Stat, StatusBar, useNavKeys } from './ui/ui';
import { onHostMessage, post } from './vscode';

type Side = 'left' | 'right';
type Filter = 'all' | 'diffs' | 'same' | 'orphans';
const filterLabels: Record<Filter, string> = { all: 'All', diffs: 'Differences', same: 'Same', orphans: 'Orphans' };

interface Counts {
  same: number;
  different: number;
  unknown: number;
  leftOnly: number;
  rightOnly: number;
}
const zero = (): Counts => ({ same: 0, different: 0, unknown: 0, leftOnly: 0, rightOnly: 0 });
const diffCount = (c: Counts) => c.different;

interface Node {
  key: string;
  /** Names on each side (they differ for renames). */
  name: string;
  oldName?: string;
  depth: number;
  row?: FolderRow;
  children: Node[];
  counts: Counts;
  bytes: [number, number];
  /** Present on each side. */
  has: [boolean, boolean];
}

function addTo(c: Counts, s: FolderStatus): void {
  if (s === 'same') c.same++;
  else if (s === 'unknown') c.unknown++;
  else if (s === 'left-only') c.leftOnly++;
  else if (s === 'right-only') c.rightOnly++;
  else c.different++;
}

function buildTree(rows: FolderRow[]): Node {
  const root: Node = { key: '', name: '', depth: -1, children: [], counts: zero(), bytes: [0, 0], has: [true, true] };
  const dirs = new Map<string, Node>([['', root]]);
  for (const row of rows) {
    const parts = row.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/');
      let d = dirs.get(key);
      if (!d) {
        d = { key, name: parts[i], depth: i, children: [], counts: zero(), bytes: [0, 0], has: [false, false] };
        dirs.set(key, d);
        parent.children.push(d);
      }
      parent = d;
    }
    const has: [boolean, boolean] = [row.status !== 'right-only', row.status !== 'left-only'];
    parent.children.push({
      key: row.path,
      name: parts.at(-1)!,
      oldName: row.oldPath?.split('/').at(-1),
      depth: parts.length - 1,
      row,
      children: [],
      counts: zero(),
      bytes: [row.leftSize ?? 0, row.rightSize ?? 0],
      has,
    });
  }
  const sum = (n: Node) => {
    if (n.row) {
      addTo(n.counts, n.row.status);
      return;
    }
    for (const c of n.children) {
      sum(c);
      for (const k of Object.keys(c.counts) as (keyof Counts)[]) n.counts[k] += c.counts[k];
      n.bytes[0] += c.bytes[0];
      n.bytes[1] += c.bytes[1];
      n.has[0] ||= c.has[0];
      n.has[1] ||= c.has[1];
    }
    // Folders first, then by name, like CompareCraft and VS Code's explorer.
    n.children.sort((a, b) => (!a.row !== !b.row ? (a.row ? 1 : -1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  };
  sum(root);
  return root;
}

interface Glyph {
  ch: string;
  cls: string;
  title: string;
}

function glyphFor(n: Node, checking: boolean): Glyph {
  if (!n.row) {
    if (n.has[0] !== n.has[1]) return n.has[0] ? { ch: '←', cls: 'g-orphan', title: 'Exists only on the left' } : { ch: '→', cls: 'g-orphan', title: 'Exists only on the right' };
    const c = n.counts;
    if (c.different || c.leftOnly || c.rightOnly) return { ch: '≠', cls: c.different ? 'g-diff g-dim' : 'g-orphan g-dim', title: 'Contains differences' };
    if (c.unknown) return { ch: '?', cls: 'g-same', title: checking ? 'Checking contents…' : 'Contains files whose contents were not checked' };
    return { ch: '=', cls: 'g-same', title: 'Everything inside is the same' };
  }
  switch (n.row.status) {
    case 'same':
      return { ch: '≡', cls: 'g-same g-verified', title: 'Contents verified identical' };
    case 'unknown':
      return { ch: '?', cls: 'g-same', title: checking ? 'Same size; checking contents…' : 'Same size; contents not checked (larger than the size limit)' };
    case 'different':
      return { ch: '≠', cls: 'g-diff', title: 'Contents differ' };
    case 'renamed':
      return { ch: '≠', cls: 'g-diff', title: `Renamed from ${n.row.oldPath}` };
    case 'left-only':
      return { ch: '←', cls: 'g-orphan', title: 'Exists only on the left' };
    case 'right-only':
      return { ch: '→', cls: 'g-orphan', title: 'Exists only on the right' };
  }
}

function matches(n: Node, filter: Filter): boolean {
  const s = n.row!.status;
  if (filter === 'all') return true;
  if (filter === 'same') return s === 'same' || s === 'unknown';
  if (filter === 'orphans') return s === 'left-only' || s === 'right-only';
  return s !== 'same' && s !== 'unknown';
}

/** Glob-like quick filter: masks separated by ';', '-' excludes. */
function quickMatcher(text: string): ((path: string) => boolean) | null {
  const masks = text.split(';').map((m) => m.trim()).filter(Boolean);
  if (!masks.length) return null;
  const re = (m: string) => new RegExp(`(^|/)${m.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}($|/)`, 'i');
  const inc = masks.filter((m) => !m.startsWith('-')).map(re);
  const exc = masks.filter((m) => m.startsWith('-')).map((m) => re(m.slice(1)));
  return (p) => (!inc.length || inc.some((r) => r.test(p))) && !exc.some((r) => r.test(p));
}

/** Also shows archive entries; `onOpen` then opens an entry instead of a path. */
export function FolderDiffView({ init, onOpen }: { init: FolderDiffInit; onOpen?: (path: string) => void }) {
  const [rows, setRows] = useState(init.rows);
  const [checking, setChecking] = useState(init.source === 'folders' && init.rows.some((r) => r.status === 'unknown'));
  const [filter, setFilter] = useState<Filter>('all');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [quick, setQuick] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [focusSide, setFocusSide] = useState<Side>('left');
  const [swapped, setSwapped] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = onHostMessage((m) => {
      if (m.type !== 'folderRows') return;
      if (m.rows.length) {
        setRows((prev) => {
          const upd = new Map(m.rows.map((r) => [r.path, r]));
          return prev.map((r) => upd.get(r.path) ?? r);
        });
      }
      if (m.done) setChecking(false);
    });
    if (init.source === 'folders') post({ type: 'folderReady' });
    return off;
  }, [init]);

  // Swapping only mirrors the display; paths sent to the host stay the same.
  const shownRows = useMemo(
    () =>
      swapped
        ? rows.map((r): FolderRow => ({ ...r, status: r.status === 'left-only' ? 'right-only' : r.status === 'right-only' ? 'left-only' : r.status, leftSize: r.rightSize, rightSize: r.leftSize }))
        : rows,
    [rows, swapped],
  );
  const totals = useMemo(() => buildTree(shownRows).counts, [shownRows]);
  const tree = useMemo(() => {
    const q = quickMatcher(quick);
    const kept = shownRows.filter((r) => (!q || q(r.path)) && (filter === 'all' || matches({ row: r } as Node, filter)));
    return buildTree(kept);
  }, [shownRows, filter, quick]);

  const flat = useMemo(() => {
    const out: Node[] = [];
    const walk = (n: Node) => {
      for (const c of n.children) {
        if (!c.row && hideEmpty && c.children.length === 0) continue;
        out.push(c);
        if (!c.row && !collapsed.has(c.key)) walk(c);
      }
    };
    walk(tree);
    return out;
  }, [tree, collapsed, hideEmpty]);

  const virt = useVirtualizer({ count: flat.length, getScrollElement: () => scrollRef.current, estimateSize: () => LIST_ROW_H, overscan: 16 });

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allFolders = () => {
    const out: string[] = [];
    const walk = (n: Node) => n.children.forEach((c) => !c.row && (out.push(c.key), walk(c)));
    walk(tree);
    return out;
  };

  const open = (n: Node) => {
    if (n.row) (onOpen ?? ((path: string) => post({ type: 'openPath', path })))(n.row.path);
    else toggle(n.key);
  };
  const cursorIndex = cursor != null ? flat.findIndex((n) => n.key === cursor) : -1;
  const moveTo = (i: number) => {
    if (i < 0 || i >= flat.length) return;
    setCursor(flat[i].key);
    virt.scrollToIndex(i, { align: 'auto' });
  };

  const isDiff = (n: Node) => !!n.row && n.row.status !== 'same' && n.row.status !== 'unknown';
  const gotoDiff = (dir: 1 | -1) => {
    // Expand everything so differences inside collapsed folders can be reached.
    if (collapsed.size) setCollapsed(new Set());
    const all: Node[] = [];
    const walk = (n: Node) => n.children.forEach((c) => (all.push(c), c.row ? null : walk(c)));
    walk(tree);
    const from = cursor ? all.findIndex((n) => n.key === cursor) : -1;
    for (let i = from + dir; i >= 0 && i < all.length; i += dir) {
      if (isDiff(all[i])) {
        const key = all[i].key;
        setCursor(key);
        requestAnimationFrame(() => {
          const idx = flatRef.current.findIndex((n) => n.key === key);
          if (idx >= 0) virt.scrollToIndex(idx, { align: 'center' });
        });
        return;
      }
    }
  };
  const flatRef = useRef(flat);
  flatRef.current = flat;
  useNavKeys(
    () => gotoDiff(1),
    () => gotoDiff(-1),
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / LIST_ROW_H) - 1);
    const n = cursorIndex >= 0 ? flat[cursorIndex] : null;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(cursorIndex + 1);
        break;
      case 'ArrowUp':
        moveTo(Math.max(0, cursorIndex - 1));
        break;
      case 'PageDown':
        moveTo(Math.min(flat.length - 1, cursorIndex + page));
        break;
      case 'PageUp':
        moveTo(Math.max(0, cursorIndex - page));
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(flat.length - 1);
        break;
      case 'ArrowRight':
        if (n && !n.row && collapsed.has(n.key)) toggle(n.key);
        else if (n && !n.row) moveTo(cursorIndex + 1);
        else setFocusSide('right');
        break;
      case 'ArrowLeft':
        if (n && !n.row && !collapsed.has(n.key)) toggle(n.key);
        else if (n && n.depth > 0) moveTo(flat.findLastIndex((x, i) => i < cursorIndex && x.depth < n.depth));
        else setFocusSide('left');
        break;
      case 'Enter':
        if (n) open(n);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const showSizes = init.source !== 'git';
  const half = (n: Node, side: Side, y: number) => {
    const present = side === 'left' ? n.has[0] : n.has[1];
    if (!present) return <div className="fc-half fc-missing" data-side={side} style={{ backgroundPositionY: -y }} />;
    const kids = !n.row;
    const expanded = kids && !collapsed.has(n.key);
    const Icon = kids ? (expanded ? FolderOpen : FolderIcon) : FileIcon;
    const status = n.row?.status;
    const tone = status === 'different' || status === 'renamed' ? 't-diff' : status === 'left-only' || status === 'right-only' ? 't-orphan' : kids && (n.has[0] !== n.has[1]) ? 't-orphan' : '';
    const showDiff = side === 'left' || !n.has[0];
    const orphans = side === 'left' ? n.counts.leftOnly : n.counts.rightOnly;
    // A renamed file shows its old name on the side it came from.
    const name = n.oldName && (side === 'left') !== swapped ? n.oldName : n.name;
    const size = side === 'left' ? n.row?.leftSize : n.row?.rightSize;
    const bytes = n.bytes[side === 'left' ? 0 : 1];
    const sizeDiff = status === 'different' && n.row!.leftSize != null && n.row!.rightSize != null && n.row!.leftSize !== n.row!.rightSize;
    return (
      <div className="fc-half" data-side={side}>
        <div className="fc-name" style={{ '--depth': n.depth } as CSSProperties}>
          <span className="fc-chev" data-chev={kids ? '' : undefined}>
            {kids && <ChevronRight size={ICON.sm} className={expanded ? 'open' : ''} />}
          </span>
          <Icon size={ICON.md} className={`fc-icon k-${kids ? 'folder' : 'file'}`} aria-hidden />
          <span className={`fc-label ${tone}`}>{name}</span>
          {kids && n.has[0] === n.has[1] && (
            <>
              {showDiff && diffCount(n.counts) > 0 && <span className="fc-badge b-diff" title={`${diffCount(n.counts)} different`}>{diffCount(n.counts)}</span>}
              {orphans > 0 && <span className="fc-badge b-orphan" title={`${orphans} only on the ${side}`}>{orphans}</span>}
            </>
          )}
        </div>
        {showSizes && <div className={`fc-size ${kids ? 'dim' : ''} ${sizeDiff ? 't-diff' : ''}`}>{kids ? formatSize(bytes) : size != null ? formatSize(size) : ''}</div>}
      </div>
    );
  };

  const differences = totals.different + totals.leftOnly + totals.rightOnly;
  const left = swapped ? init.right : init.left;
  const right = swapped ? init.left : init.right;

  return (
    <div className="view">
      <PathBars left={left} right={right} onSwap={() => setSwapped((s) => !s)} />
      <div className="toolbar fc-toolbar">
        <button className="icon-btn" title="Previous difference (Alt+Up)" onClick={() => gotoDiff(-1)} disabled={!differences}><ArrowUp size={ICON.lg} /></button>
        <button className="icon-btn" title="Next difference (Alt+Down)" onClick={() => gotoDiff(1)} disabled={!differences}><ArrowDown size={ICON.lg} /></button>
        <div className="divider-v" />
        <div className="seg" role="group" aria-label="Items to show">
          {(Object.keys(filterLabels) as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)} aria-pressed={filter === f}>
              {filterLabels[f]}
            </button>
          ))}
        </div>
        <button className={`icon-btn ${hideEmpty ? 'on' : ''}`} title="Hide empty folders" aria-pressed={hideEmpty} onClick={() => setHideEmpty((x) => !x)}><FolderX size={ICON.lg} /></button>
        <button className="icon-btn" title="Expand all" onClick={() => setCollapsed(new Set())}><ChevronsUpDown size={ICON.lg} /></button>
        <button className="icon-btn" title="Collapse all" onClick={() => setCollapsed(new Set(allFolders()))}><ChevronsDownUp size={ICON.lg} /></button>
        <div className="divider-v" />
        <div className="fc-quick">
          <ListFilter size={ICON.sm} aria-hidden />
          <input className="input" value={quick} spellCheck={false} placeholder="Filter, e.g. *.ts;-test" aria-label="Name filter" title="Masks separated by semicolons. Prefix with - to exclude." onChange={(e) => setQuick(e.target.value)} />
          {quick && (
            <button className="fc-quick-clear" title="Clear filter" onClick={() => setQuick('')}><X size={ICON.sm} /></button>
          )}
        </div>
      </div>
      {init.note && <div className="banner info">{init.note}</div>}
      {!checking && differences === 0 && totals.unknown === 0 && rows.length > 0 && <div className="banner ok">The two {init.source === 'archive' ? 'archives have identical entries' : 'folders are identical'}.</div>}
      {rows.length === 0 && <div className="banner info">{init.source === 'git' ? 'No files changed.' : init.source === 'archive' ? 'Both archives are empty.' : 'Both folders are empty.'}</div>}
      <div className={`fc-body ${showSizes ? '' : 'fc-nosize'}`}>
        {checking && <div className="fc-busy" aria-label="Checking contents" />}
        <div className="fc-head" role="row">
          {(['left', 'right'] as Side[]).map((s) => [
            s === 'right' && <div key="seam" className="fc-seam-h" />,
            <div key={s} className="fc-half" role="columnheader">
              <span className="fc-hcell fc-h-name">{s === 'left' ? 'Left name' : 'Right name'}</span>
              {showSizes && <span className="fc-hcell fc-h-size">Size</span>}
            </div>,
          ])}
        </div>
        <div className="fc-scroll" ref={scrollRef} tabIndex={0} role="treegrid" aria-label="Folder comparison" onKeyDown={onKeyDown}>
          <div className="fc-rows" style={{ height: virt.getTotalSize() }}>
            <div className="fc-seam-track" aria-hidden />
            {virt.getVirtualItems().map((vi) => {
              const n = flat[vi.index];
              const g = glyphFor(n, checking);
              const selected = cursor === n.key;
              return (
                <div
                  key={n.key}
                  role="row"
                  className={`fc-row ${selected ? `sel cur fs-${focusSide}` : ''}`}
                  style={{ transform: `translateY(${vi.start}px)`, height: LIST_ROW_H }}
                  title={n.row?.oldPath ? `Renamed from ${n.row.oldPath}` : undefined}
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).closest('[data-chev]') && e.button === 0) {
                      e.preventDefault();
                      toggle(n.key);
                      return;
                    }
                    const side = (e.target as HTMLElement).closest('[data-side]')?.getAttribute('data-side') as Side | null;
                    if (side) setFocusSide(side);
                    setCursor(n.key);
                  }}
                  onDoubleClick={(e) => {
                    if (!(e.target as HTMLElement).closest('[data-chev]')) open(n);
                  }}
                >
                  {half(n, 'left', vi.start)}
                  <div className={`fc-seam ${g.cls}`} title={g.title}>{g.ch}</div>
                  {half(n, 'right', vi.start)}
                </div>
              );
            })}
          </div>
          {rows.length > 0 && flat.length === 0 && (
            <div className="fc-empty">
              No items match this filter.
              <button className="btn" onClick={() => { setFilter('all'); setQuick(''); }}>Show all</button>
            </div>
          )}
        </div>
      </div>
      <StatusBar>
        {init.source !== 'git' && <Stat swatch="fc-sw-same">{totals.same.toLocaleString()} same</Stat>}
        <Stat swatch="fc-sw-diff">{totals.different.toLocaleString()} different</Stat>
        <Stat swatch="fc-sw-orphan">{totals.leftOnly.toLocaleString()} only left, {totals.rightOnly.toLocaleString()} only right</Stat>
        {totals.unknown > 0 && <span>{`${checking ? 'Checking' : 'Not checked:'} ${totals.unknown.toLocaleString()} ${totals.unknown === 1 ? 'file' : 'files'}${checking ? '…' : ''}`}</span>}
        <span className="grow" />
        <span>{init.source === 'git' ? 'Changed files from git' : init.source === 'archive' ? 'Entries compared by checksum and size' : 'Same-size files compared byte by byte'}</span>
        <span>Double-click or Enter opens a file</span>
      </StatusBar>
    </div>
  );
}
