// Binary compare, after CompareCraft's hex view: two byte panes around a
// marker seam, an overview strip, linked hover and a cursor, go to offset.
// Bytes are compared by position and fetched from the host in pages.
import { ArrowDown, ArrowUp, CaseSensitive, Crosshair, FileText } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatSize, fromBase64 } from '../../src/core/bytes';
import type { HexDiffInit } from '../../src/shared/protocol';
import { MiniMap, type Mark } from './ui/MiniMap';
import { CODE_ROW_H, Counter, Dialog, ICON, PathBars, Stat, StatusBar, useNavKeys } from './ui/ui';
import { post, requestBytes } from './vscode';

type SideName = 'left' | 'right';
type PerRow = 8 | 16 | 32;
type Kind = 'same' | 'changed' | 'left-only' | 'right-only';

const PAGE = 64 * 1024;
/** Browsers cap element heights, so very long files use a scaled scroll range. */
const MAX_SCROLL_PX = 8_000_000;
const rowH = CODE_ROW_H;
const headH = rowH + 4;

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');
const asciiChar = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·');
const kindClass: Record<Kind, string> = { same: '', changed: 'k-changed', 'left-only': 'k-removed', 'right-only': 'k-added' };

function parseOffset(text: string): number | null {
  const t = text.trim().replace(/[_\s]/g, '');
  if (!t) return null;
  let m = /^0x([0-9a-f]+)$/i.exec(t) ?? /^([0-9a-f]+)h$/i.exec(t);
  if (m) return parseInt(m[1], 16);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  m = /^([0-9a-f]+)$/i.exec(t);
  return m ? parseInt(m[1], 16) : null;
}

/** Pages of each side's bytes, fetched from the host on demand. */
function usePages(sides: Record<SideName, number>) {
  const pages = useRef(new Map<string, Uint8Array | 'loading'>());
  const [, setTick] = useState(0);
  return useCallback(
    (side: SideName, offset: number): number | undefined => {
      if (offset >= sides[side]) return undefined;
      const page = Math.floor(offset / PAGE);
      const key = `${side}:${page}`;
      const v = pages.current.get(key);
      if (v && v !== 'loading') return v[offset - page * PAGE];
      if (!v) {
        pages.current.set(key, 'loading');
        void requestBytes(side, page * PAGE, PAGE).then((b64) => {
          pages.current.set(key, fromBase64(b64));
          setTick((t) => t + 1);
        });
      }
      return undefined;
    },
    [sides],
  );
}

export function HexDiffView({ init }: { init: HexDiffInit }) {
  const [swapped, setSwapped] = useState(false);
  const docs = { left: swapped ? init.right : init.left, right: swapped ? init.left : init.right };
  // Byte requests name the host's sides, which don't swap.
  const hostSide = (s: SideName): SideName => (swapped ? (s === 'left' ? 'right' : 'left') : s);
  const sizes = useMemo(() => ({ left: init.left.size, right: init.right.size }), [init]);
  const getHost = usePages(sizes);
  const byteAt = (s: SideName, off: number) => getHost(hostSide(s), off);
  const size = { left: docs.left.size, right: docs.right.size };
  const total = Math.max(size.left, size.right);

  const [perRow, setPerRow] = useState<PerRow>(16);
  const [showAscii, setShowAscii] = useState(true);
  const [current, setCurrent] = useState(-1);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [realTop, setRealTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const realTopRef = useRef(0);
  const ignoreScroll = useRef(false);

  // Differences: the ranges from the host, which also cover bytes past the shorter file.
  const hunks = init.ranges;
  const shorter = Math.min(size.left, size.right);
  const kindAt = (v: number): Kind => {
    if (v >= size.left) return 'right-only';
    if (v >= size.right) return 'left-only';
    let lo = 0, hi = hunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hunks[mid].end <= v) lo = mid + 1;
      else if (hunks[mid].start > v) hi = mid - 1;
      else return 'changed';
    }
    return 'same';
  };
  const marks: Mark[] = useMemo(() => {
    const out: Mark[] = hunks.filter((h) => h.start < shorter).map((h) => ({ start: h.start, end: Math.min(h.end, shorter), cls: 'changed' }));
    if (total > shorter) out.push({ start: shorter, end: total, cls: size.left > size.right ? 'removed' : 'added' });
    return out;
  }, [hunks, shorter, total, size.left, size.right]);

  const totalRows = Math.ceil(total / perRow);
  const bodyH = Math.max(rowH, viewH - headH);
  const contentH = totalRows * rowH;
  const spacerRows = Math.min(contentH, MAX_SCROLL_PX);
  const maxReal = Math.max(0, contentH - bodyH);
  const maxSpacer = Math.max(0, spacerRows - bodyH);
  const scale = maxSpacer > 0 ? maxReal / maxSpacer : 1;

  const setTop = useCallback(
    (top: number) => {
      const t = Math.max(0, Math.min(maxReal, top));
      realTopRef.current = t;
      setRealTop(t);
      const el = scroller.current;
      if (el) {
        ignoreScroll.current = true;
        el.scrollTop = t / scale;
      }
    },
    [maxReal, scale],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientHeight && setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the visible position stable when the row geometry changes.
  const prevPerRow = useRef(perRow);
  useEffect(() => {
    if (prevPerRow.current !== perRow) {
      const firstV = Math.floor(realTopRef.current / rowH) * prevPerRow.current;
      prevPerRow.current = perRow;
      setTop(Math.floor(firstV / perRow) * rowH);
    }
  }, [perRow, setTop]);

  // Wheel scrolling in the scaled range would jump many rows; do it ourselves.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (scale <= 1.001 || e.ctrlKey) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? rowH : e.deltaMode === 2 ? bodyH : 1;
      setTop(realTopRef.current + e.deltaY * k);
      if (e.deltaX) el.scrollLeft += e.deltaX * k;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scale, bodyH, setTop]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !el.clientHeight) return;
    if (ignoreScroll.current) {
      ignoreScroll.current = false;
      return;
    }
    const t = Math.min(maxReal, el.scrollTop * scale);
    realTopRef.current = t;
    setRealTop(t);
  };

  const firstRow = Math.floor(realTop / rowH);
  const offsetY = -(realTop - firstRow * rowH);
  const visibleCount = Math.ceil(bodyH / rowH) + 1;

  const scrollToV = useCallback(
    (v: number, mode: 'center' | 'nearest' = 'center') => {
      const y = Math.floor(v / perRow) * rowH;
      if (mode === 'nearest') {
        if (y < realTopRef.current) setTop(y);
        else if (y + rowH > realTopRef.current + bodyH) setTop(y + rowH - bodyH);
      } else setTop(y - bodyH / 3);
    },
    [perRow, bodyH, setTop],
  );

  const has = hunks.length > 0;
  const goto = (i: number) => {
    if (i < 0 || i >= hunks.length) return;
    setCurrent(i);
    setCursor(hunks[i].start);
    scrollToV(hunks[i].start);
  };
  const visibleHunk = () => hunks.findIndex((h) => h.end > firstRow * perRow);
  const next = () => {
    if (!has) return;
    const from = current >= 0 ? current + 1 : Math.max(0, visibleHunk());
    if (from < hunks.length) goto(from);
  };
  const prev = () => {
    if (!has) return;
    const from = current >= 0 ? current - 1 : visibleHunk() - 1;
    if (from >= 0) goto(from);
  };
  useNavKeys(next, prev);

  const moveCursor = (delta: number) => {
    if (!total) return;
    const v = Math.max(0, Math.min(total - 1, (cursor ?? firstRow * perRow) + delta));
    setCursor(v);
    scrollToV(v, 'nearest');
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      setGotoOpen(true);
      return;
    }
    const page = Math.max(1, visibleCount - 2) * perRow;
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow, PageUp: -page, PageDown: page };
    if (e.key in map) {
      e.preventDefault();
      moveCursor(map[e.key]);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const base = cursor ?? firstRow * perRow;
      const v = e.ctrlKey ? (e.key === 'Home' ? 0 : total - 1) : e.key === 'Home' ? base - (base % perRow) : Math.min(total - 1, base - (base % perRow) + perRow - 1);
      setCursor(v);
      scrollToV(v, 'nearest');
    }
  };

  const curHunk = current >= 0 ? hunks[current] : undefined;
  const offW = Math.max(8, Math.ceil(Math.log2(Math.max(total, 2)) / 4));
  const focusV = hover ?? cursor;

  const rowSide = (side: SideName, row: number) => {
    const bytes: React.ReactNode[] = [];
    const text: React.ReactNode[] = [];
    const v0 = row * perRow;
    for (let i = 0; i < perRow; i++) {
      const v = v0 + i;
      const grp = i % 8 === 7 && i < perRow - 1 ? ' grp' : '';
      if (v >= total) {
        bytes.push(<span key={i} className={`hx-b${grp}`} />);
        text.push(<span key={i} className="hx-a" />);
        continue;
      }
      const state = (v === hover ? ' hover' : '') + (v === cursor ? ' cursor' : '');
      if (v >= size[side]) {
        bytes.push(<span key={i} className={`hx-b gap cc-hatch${grp}${state}`} data-v={v} />);
        text.push(<span key={i} className={`hx-a gap cc-hatch${state}`} data-v={v} />);
        continue;
      }
      const b = byteAt(side, v);
      const kind = kindAt(v);
      // Merged (approximate) ranges can contain equal bytes; show those as equal.
      const other = side === 'left' ? 'right' : 'left';
      const k = init.merged && kind === 'changed' && b !== undefined && byteAt(other, v) === b ? 'k-approx' : kindClass[kind];
      const zero = b === 0 && kind === 'same' ? ' zero' : '';
      bytes.push(
        <span key={i} className={`hx-b ${k}${grp}${state}${zero}`} data-v={v}>
          {b === undefined ? '··' : hex(b, 2)}
        </span>,
      );
      text.push(
        <span key={i} className={`hx-a ${k}${state}`} data-v={v}>
          {b === undefined ? ' ' : asciiChar(b)}
        </span>,
      );
    }
    return (
      <div className="hx-side">
        <span className="hx-off" style={{ width: `${offW + 2}ch` }}>{v0 < size[side] ? hex(v0, offW) : ''}</span>
        <span className="hx-bytes">{bytes}</span>
        {showAscii && <span className="hx-ascii">{text}</span>}
      </div>
    );
  };

  const rowKind = (row: number): Kind => {
    let kind: Kind = 'same';
    for (let v = row * perRow; v < Math.min(total, (row + 1) * perRow); v++) {
      const k = kindAt(v);
      if (k === 'same') continue;
      if (k === 'changed' || (kind !== 'same' && kind !== k)) return 'changed';
      kind = k;
    }
    return kind;
  };

  const rows: number[] = [];
  for (let r = firstRow; r < Math.min(totalRows, firstRow + visibleCount); r++) rows.push(r);

  const focusPart = (label: string, side: SideName) => {
    if (focusV == null || focusV >= size[side]) return <span>{label} —</span>;
    const b = byteAt(side, focusV);
    const val = b === undefined ? '…' : `${hex(b, 2)} (${b}${b >= 0x20 && b < 0x7f ? ` '${String.fromCharCode(b)}'` : ''})`;
    return (
      <span className="hx-stat-mono">
        {label} 0x{hex(focusV, 1)} · {focusV.toLocaleString()} = {val}
      </span>
    );
  };

  return (
    <div className="view">
      <PathBars left={docs.left} right={docs.right} onSwap={() => setSwapped((s) => !s)} />
      <div className="toolbar">
        <button className="icon-btn" title="Previous difference (Alt+Up)" onClick={prev} disabled={!has}><ArrowUp size={ICON.lg} /></button>
        <button className="icon-btn" title="Next difference (Alt+Down)" onClick={next} disabled={!has}><ArrowDown size={ICON.lg} /></button>
        <Counter current={current} total={hunks.length} />
        <div className="divider-v" />
        <span className="label">Bytes per row</span>
        <div className="seg" role="group" aria-label="Bytes per row">
          {([8, 16, 32] as PerRow[]).map((n) => (
            <button key={n} className={perRow === n ? 'on' : ''} onClick={() => setPerRow(n)}>{n}</button>
          ))}
        </div>
        <div className="divider-v" />
        <button className={`icon-btn ${showAscii ? 'on' : ''}`} title="Show text column" aria-pressed={showAscii} onClick={() => setShowAscii((x) => !x)}><CaseSensitive size={ICON.lg} /></button>
        <button className="btn ghost" title="Go to offset (Ctrl+G)" onClick={() => setGotoOpen(true)}><Crosshair size={ICON.md} /> Go to offset</button>
        <div className="grow" />
        <button className="btn ghost" onClick={() => post({ type: 'openAsText' })}><FileText size={ICON.md} /> Open as text</button>
      </div>
      {init.differentBytes === 0 && <div className="banner ok">The files are identical.</div>}
      {init.merged && (
        <div className="banner" role="status">
          There are too many differences to list individually, so nearby differences were merged into approximate ranges.
        </div>
      )}
      {!total ? (
        <div className="center-state">Both files are empty.</div>
      ) : (
        <div className="hx-body">
          <div
            className="hx-scroller"
            ref={scroller}
            onScroll={onScroll}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onMouseMove={(e) => {
              const t = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
              const v = t ? Number(t.dataset.v) : null;
              if (v !== hover) setHover(v);
            }}
            onMouseLeave={() => setHover(null)}
            onMouseDown={(e) => {
              const t = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
              if (t) setCursor(Number(t.dataset.v));
            }}
            style={{ '--hx-row': `${rowH}px` } as React.CSSProperties}
            aria-label="Byte comparison"
          >
            <div className="hx-spacer" style={{ height: spacerRows + headH }}>
              <div className="hx-layer" style={{ height: viewH }}>
                <div className="hx-row hx-head" style={{ height: headH }}>
                  <HeadSide offW={offW} perRow={perRow} ascii={showAscii} label="Left" />
                  <div className="hx-seam" />
                  <HeadSide offW={offW} perRow={perRow} ascii={showAscii} label="Right" />
                </div>
                <div className="hx-rows" style={{ transform: `translateY(${offsetY}px)` }}>
                  {rows.map((row) => {
                    const v0 = row * perRow;
                    const inCurrent = !!curHunk && curHunk.start < v0 + perRow && curHunk.end > v0;
                    const kind = rowKind(row);
                    return (
                      <div key={row} className="hx-row">
                        {rowSide('left', row)}
                        <div
                          className={`hx-seam ${inCurrent ? 'current' : ''}`}
                          onMouseDown={
                            kind !== 'same'
                              ? () => {
                                  const i = hunks.findIndex((h) => h.start < v0 + perRow && h.end > v0);
                                  if (i >= 0) goto(i);
                                }
                              : undefined
                          }
                        >
                          {kind !== 'same' && <span className={`hx-mark ${kindClass[kind]}`} />}
                        </div>
                        {rowSide('right', row)}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <MiniMap total={total} marks={marks} viewStart={firstRow * perRow} viewSize={(bodyH / rowH) * perRow} onJump={(v) => setTop((v / perRow) * rowH - bodyH / 2)} />
        </div>
      )}
      {gotoOpen && (
        <GotoDialog
          sizes={size}
          onClose={() => setGotoOpen(false)}
          onGo={(v) => {
            setCursor(v);
            scrollToV(v);
            setGotoOpen(false);
          }}
        />
      )}
      <StatusBar>
        <Stat swatch="hx-sw-diff">
          {init.differentBytes.toLocaleString()} different {init.differentBytes === 1 ? 'byte' : 'bytes'}
        </Stat>
        <span>Positional</span>
        <span>{formatSize(size.left)} ↔ {formatSize(size.right)}</span>
        <span className="grow" />
        {focusV != null && (
          <>
            {focusPart('Left', 'left')}
            {focusPart('Right', 'right')}
          </>
        )}
      </StatusBar>
    </div>
  );
}

function HeadSide({ offW, perRow, ascii, label }: { offW: number; perRow: number; ascii: boolean; label: string }) {
  const cols = [];
  for (let i = 0; i < perRow; i++) cols.push(<span key={i} className={`hx-b ${i % 8 === 7 && i < perRow - 1 ? 'grp' : ''}`}>{hex(i, 2)}</span>);
  return (
    <div className="hx-side">
      <span className="hx-off" style={{ width: `${offW + 2}ch` }}>{label}</span>
      <span className="hx-bytes">{cols}</span>
      {ascii && <span className="hx-ascii hx-ascii-head" style={{ width: `${perRow}ch` }}>Text</span>}
    </div>
  );
}

function GotoDialog(props: { sizes: Record<SideName, number>; onClose: () => void; onGo: (offset: number) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const size = Math.max(props.sizes.left, props.sizes.right);
  const go = () => {
    const off = parseOffset(text);
    if (off == null) return setErr('Enter a decimal offset or a hex offset such as 0x1F00.');
    if (off >= size) return setErr(`The longer file is ${size.toLocaleString()} bytes long.`);
    props.onGo(off);
  };
  return (
    <Dialog
      title="Go to offset"
      onClose={props.onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={go}>Go</button>
        </>
      }
    >
      <div className="field">
        <span>Offset</span>
        <input
          className="input mono"
          autoFocus
          value={text}
          placeholder="0x1F00 or 7936"
          onChange={(e) => {
            setText(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
      </div>
      <div className="hint">{err ? <span className="hx-err">{err}</span> : `Valid range 0 – 0x${hex(Math.max(0, size - 1), 1)}`}</div>
    </Dialog>
  );
}
