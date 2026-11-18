// Image compare, ported from CompareCraft's picture view: side by side with
// the difference in the middle, difference only, an overlay slider and blend.
// All panes share one zoom and pan.
import { FlipHorizontal2, FlipVertical2, Maximize, Minus, Plus, RotateCcwSquare, RotateCwSquare, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatSize } from '../../src/core/bytes';
import type { PictureDiffInit } from '../../src/shared/protocol';
import { ErrorState, ICON, PathBars, Spinner, Stat, StatusBar } from './ui/ui';
import { defaultPictureOptions, diffPictures, loadImage, prepare, type PictureDiff, type PictureOptions, type Prepared } from './picture';

type LayoutMode = 'side' | 'diff' | 'slider' | 'blend';
interface View {
  s: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

/** Placement of both images on a shared stage given the right image's offset. */
function geometry(lw: number, lh: number, rw: number, rh: number, dx: number, dy: number) {
  const x0 = Math.min(0, dx);
  const y0 = Math.min(0, dy);
  const W = Math.max(lw, rw + dx) - x0;
  const H = Math.max(lh, rh + dy) - y0;
  return { x0, y0, W, H, left: { x: -x0, y: -y0 }, right: { x: dx - x0, y: dy - y0 } };
}

const fmtSigned = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

export function PictureDiffView({ init }: { init: PictureDiffInit }) {
  const [swapped, setSwapped] = useState(false);
  const leftDoc = swapped ? init.right : init.left;
  const rightDoc = swapped ? init.left : init.right;
  const [images, setImages] = useState<[HTMLImageElement, HTMLImageElement] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<PictureOptions>(defaultPictureOptions);
  const [layout, setLayout] = useState<LayoutMode>('side');
  const [manualView, setManualView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [fit, setFit] = useState(true);
  const [split, setSplit] = useState(0.5);
  const [blend, setBlend] = useState(0.5);
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });
  const [diff, setDiff] = useState<PictureDiff | null>(null);
  const [diffOffset, setDiffOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const src = (d: typeof leftDoc) => `data:${d.image!.mime};base64,${d.image!.base64}`;
    Promise.all([loadImage(src(leftDoc), leftDoc.label), loadImage(src(rightDoc), rightDoc.label)]).then(setImages, (e: Error) => setError(e.message));
  }, [leftDoc, rightDoc]);

  // Orientation and scaling change the images themselves; offsets and tolerance only the difference.
  const prepared: Prepared | null = useMemo(
    () => (images ? prepare(images[0], images[1], options) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, options.rotateRight, options.flipH, options.flipV, options.autoScale],
  );
  useEffect(() => {
    if (!prepared) return;
    const t = setTimeout(() => {
      setDiff(diffPictures(prepared, options));
      setDiffOffset({ x: options.offsetX, y: options.offsetY });
    }, 120);
    return () => clearTimeout(t);
  }, [prepared, options]);

  const geo = useMemo(() => (prepared ? geometry(prepared.left.width, prepared.left.height, prepared.right.width, prepared.right.height, options.offsetX, options.offsetY) : null), [prepared, options.offsetX, options.offsetY]);
  const diffGeo = useMemo(() => (prepared ? geometry(prepared.left.width, prepared.left.height, prepared.right.width, prepared.right.height, diffOffset.x, diffOffset.y) : null), [prepared, diffOffset]);

  // Fit to the pane; the fitted view is derived so it follows resizes.
  const fitted = useMemo((): View | null => {
    if (!geo || !paneSize.w || !paneSize.h) return null;
    const pad = 24;
    const s = Math.max(MIN_SCALE, Math.min(8, (paneSize.w - pad) / geo.W, (paneSize.h - pad) / geo.H));
    return { s, x: (paneSize.w - geo.W * s) / 2, y: (paneSize.h - geo.H * s) / 2 };
  }, [geo, paneSize]);
  const view = fit && fitted ? fitted : manualView;

  /** Apply a change to the view, starting from the fitted view if fitting. */
  const change = useCallback(
    (op: (v: View) => View) => {
      const base = fit && fitted ? fitted : null;
      setFit(false);
      setManualView((v) => op(base ?? v));
    },
    [fit, fitted],
  );
  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) =>
      change((v) => {
        const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * factor));
        const cx = px ?? paneSize.w / 2;
        const cy = py ?? paneSize.h / 2;
        return { s, x: cx - ((cx - v.x) * s) / v.s, y: cy - ((cy - v.y) * s) / v.s };
      }),
    [change, paneSize],
  );
  const actualSize = () => zoomAt(1 / view.s);
  const pan = useCallback((dx: number, dy: number) => change((v) => ({ ...v, x: v.x + dx, y: v.y + dy })), [change]);

  const nudge = (dx: number, dy: number) => setOptions((o) => ({ ...o, offsetX: o.offsetX + dx, offsetY: o.offsetY + dy }));
  const resetOffset = () => setOptions((o) => ({ ...o, offsetX: 0, offsetY: 0 }));
  const rotate = (deg: number) => setOptions((o) => ({ ...o, rotateRight: (((o.rotateRight + deg) % 360) + 360) % 360 }));
  const flip = (axis: 'flipH' | 'flipV') => setOptions((o) => ({ ...o, [axis]: !o[axis] }));
  const resetOrientation = () => setOptions((o) => ({ ...o, rotateRight: 0, flipH: false, flipV: false }));
  const oriented = !!(options.rotateRight || options.flipH || options.flipV);
  const set = <K extends keyof PictureOptions>(k: K, val: PictureOptions[K]) => setOptions((o) => ({ ...o, [k]: val }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && /^[1-4]$/.test(e.key)) setLayout((['side', 'diff', 'slider', 'blend'] as const)[Number(e.key) - 1]);
      else if (mod && e.key === '0') setFit(true);
      else if (mod && e.key === '1') actualSize();
      else if (mod && (e.key === '=' || e.key === '+')) zoomAt(1.25);
      else if (mod && e.key === '-') zoomAt(0.8);
      else if (mod && e.key.toLowerCase() === 'r') rotate(e.shiftKey ? -90 : 90);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const total = diff ? diff.samePixels + diff.unimportantPixels + diff.importantPixels : 0;
  const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(n && n / total < 0.001 ? 3 : 2)}%` : '0%');
  const lw = images?.[0].naturalWidth ?? 0, lh = images?.[0].naturalHeight ?? 0;
  const rw = prepared?.right.width ?? 0, rh = prepared?.right.height ?? 0;
  const sizeDiffers = !!images && (lw !== rw || lh !== rh);
  const hasOffset = !!(options.offsetX || options.offsetY);

  const stage = (content: ReactNode) =>
    geo && (
      <div className={`pc-stage ${view.s >= 2 ? 'pixelated' : ''}`} style={{ width: geo.W, height: geo.H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, '--inv': 1 / view.s } as React.CSSProperties}>
        {content}
      </div>
    );
  const img = (src: string, x: number, y: number, w: number, h: number, extra?: React.CSSProperties, cls = '') => (
    <img className={`pc-img ${cls}`} src={src} alt="" draggable={false} style={{ left: x, top: y, width: w, height: h, ...extra }} />
  );
  const leftImg = () => prepared && geo && img(prepared.leftUrl, geo.left.x, geo.left.y, prepared.left.width, prepared.left.height);
  const rightImg = (extra?: React.CSSProperties) => prepared && geo && img(prepared.rightUrl, geo.right.x, geo.right.y, prepared.right.width, prepared.right.height, extra);
  const diffImg = () => diff && geo && diffGeo && img(diff.diffUrl, diffGeo.x0 - geo.x0, diffGeo.y0 - geo.y0, diff.width, diff.height, undefined, 'pc-diff-img');

  const paneProps = { pan, zoomAt, onSize: setPaneSize, onNudge: nudge };
  const sx = geo ? (split * paneSize.w - view.x) / view.s : 0;
  const leftInfo = { w: lw, h: lh }, rightInfo = { w: rw, h: rh };

  return (
    <div className="view">
      <PathBars left={leftDoc} right={rightDoc} onSwap={() => setSwapped((s) => !s)} />
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Layout">
          <button className={layout === 'side' ? 'on' : ''} onClick={() => setLayout('side')} title="Side by side (Alt+1)">Side by side</button>
          <button className={layout === 'diff' ? 'on' : ''} onClick={() => setLayout('diff')} title="Difference only (Alt+2)">Diff</button>
          <button className={layout === 'slider' ? 'on' : ''} onClick={() => setLayout('slider')} title="Overlay slider (Alt+3)">Overlay slider</button>
          <button className={layout === 'blend' ? 'on' : ''} onClick={() => setLayout('blend')} title="Blend (Alt+4)">Blend</button>
        </div>
        <div className="divider-v" />
        <button className={`icon-btn ${fit ? 'on' : ''}`} title="Zoom to fit (Ctrl+0)" onClick={() => setFit(true)}><Maximize size={ICON.lg} /></button>
        <button className="btn ghost pc-one" title="Actual size (Ctrl+1)" onClick={actualSize}>1:1</button>
        <button className="icon-btn" title="Zoom out (Ctrl+-)" onClick={() => zoomAt(0.8)}><Minus size={ICON.lg} /></button>
        <span className="pc-zoom">{Math.round(view.s * 100)}%</span>
        <button className="icon-btn" title="Zoom in (Ctrl+=)" onClick={() => zoomAt(1.25)}><Plus size={ICON.lg} /></button>
        <div className="divider-v" />
        <div className="seg" role="group" aria-label="Difference colors">
          <button className={options.mode === 'tolerance' ? 'on' : ''} onClick={() => set('mode', 'tolerance')} title="Gray matches, blue is within tolerance, red is beyond it">Tolerance</button>
          <button className={options.mode === 'range' ? 'on' : ''} onClick={() => set('mode', 'range')} title="Brighter yellow means a larger difference">Mismatch range</button>
        </div>
        <label className="pc-range" title="Largest per-channel difference treated as unimportant">
          <span className="label">Tolerance</span>
          <input type="range" min={0} max={255} value={options.tolerance} onChange={(e) => set('tolerance', Number(e.target.value))} />
          <span className="pc-num">{options.tolerance}</span>
        </label>
        <button className={`btn ghost ${options.ignoreUnimportant ? 'cc-on' : ''}`} aria-pressed={options.ignoreUnimportant} disabled={options.mode !== 'tolerance'} onClick={() => set('ignoreUnimportant', !options.ignoreUnimportant)}>Ignore unimportant</button>
        <div className="divider-v" />
        <button className="icon-btn" title="Rotate the right image counter-clockwise (Ctrl+Shift+R)" onClick={() => rotate(-90)}><RotateCcwSquare size={ICON.lg} /></button>
        <button className="icon-btn" title="Rotate the right image clockwise (Ctrl+R)" onClick={() => rotate(90)}><RotateCwSquare size={ICON.lg} /></button>
        <button className={`icon-btn ${options.flipH ? 'on' : ''}`} aria-pressed={options.flipH} title="Flip the right image horizontally" onClick={() => flip('flipH')}><FlipHorizontal2 size={ICON.lg} /></button>
        <button className={`icon-btn ${options.flipV ? 'on' : ''}`} aria-pressed={options.flipV} title="Flip the right image vertically" onClick={() => flip('flipV')}><FlipVertical2 size={ICON.lg} /></button>
        {oriented && (
          <button className="btn ghost pc-offset" onClick={resetOrientation} title="Reset rotation and flips">
            {[options.rotateRight ? `${options.rotateRight}°` : '', options.flipH ? 'flipped H' : '', options.flipV ? 'flipped V' : ''].filter(Boolean).join(', ')} <X size={ICON.sm} />
          </button>
        )}
        <div className="divider-v" />
        <button className={`btn ghost ${options.autoScale ? 'cc-on' : ''}`} aria-pressed={options.autoScale} onClick={() => set('autoScale', !options.autoScale)} title="Scale the smaller image to the larger one's size">Scale to match</button>
        {layout === 'blend' && (
          <label className="pc-range" title="Opacity of the right image">
            <span className="label">Blend</span>
            <input type="range" min={0} max={100} value={Math.round(blend * 100)} onChange={(e) => setBlend(Number(e.target.value) / 100)} />
            <span className="pc-num">{Math.round(blend * 100)}%</span>
          </label>
        )}
        <div className="grow" />
        {hasOffset && (
          <button className="btn ghost pc-offset" onClick={resetOffset} title="Reset the right image's offset">
            Offset {fmtSigned(options.offsetX)}, {fmtSigned(options.offsetY)} <X size={ICON.sm} />
          </button>
        )}
      </div>
      {diff?.identical && <div className="banner ok">The images are identical.</div>}
      {diff && !diff.identical && diff.equivalent && <div className="banner info">The images differ only within the tolerance of {options.tolerance}.</div>}
      {sizeDiffers && (
        <div className="banner">
          The images have different sizes: {lw}×{lh} and {rw}×{rh}.
          <button className="btn" onClick={() => set('autoScale', !options.autoScale)}>{options.autoScale ? 'Compare at original size' : 'Scale to match'}</button>
        </div>
      )}
      {error ? (
        <ErrorState error={error} />
      ) : !prepared || !geo ? (
        <Spinner label="Comparing images" />
      ) : (
        <div className={`pc-body pc-${layout}`}>
          {layout === 'side' && (
            <>
              <Pane key="side-l" {...paneProps} measure label={<PaneLabel side="Left" info={leftInfo} />}>{stage(leftImg())}</Pane>
              <Pane key="side-d" {...paneProps} nudgeable label={<span>Difference{hasOffset ? '' : <span className="pc-hint"> · arrow keys nudge the right image</span>}</span>}>{stage(diffImg())}</Pane>
              <Pane key="side-r" {...paneProps} label={<PaneLabel side="Right" info={rightInfo} />}>{stage(rightImg())}</Pane>
            </>
          )}
          {layout === 'diff' && (
            <Pane key="diff" {...paneProps} measure nudgeable label={<span>Difference</span>}>{stage(diffImg())}</Pane>
          )}
          {layout === 'slider' && (
            <Pane
              key="slider"
              {...paneProps}
              measure
              nudgeable
              label={<PaneLabel side="Left" info={leftInfo} />}
              overlay={
                <>
                  <SplitHandle split={split} onSplit={setSplit} />
                  <div className="pc-label pc-label-right"><PaneLabel side="Right" info={rightInfo} /></div>
                </>
              }
            >
              {stage(
                <>
                  {leftImg()}
                  <div className="pc-clip" style={{ clipPath: `inset(0 0 0 ${Math.max(0, sx)}px)` }}>{rightImg()}</div>
                </>,
              )}
            </Pane>
          )}
          {layout === 'blend' && (
            <Pane key="blend" {...paneProps} measure nudgeable label={<span>Left with right at {Math.round(blend * 100)}%</span>}>
              {stage(
                <>
                  {leftImg()}
                  {rightImg({ opacity: blend })}
                </>,
              )}
            </Pane>
          )}
        </div>
      )}
      <StatusBar>
        {diff ? (
          <>
            <Stat swatch="pc-sw-same">{diff.samePixels.toLocaleString()} same</Stat>
            <Stat swatch="pc-sw-unimp">{diff.unimportantPixels.toLocaleString()} unimportant</Stat>
            <Stat swatch="pc-sw-important">{diff.importantPixels.toLocaleString()} important ({pct(diff.importantPixels)})</Stat>
            <span>Max delta {diff.maxDelta}</span>
          </>
        ) : (
          <span>Comparing…</span>
        )}
        <span className="grow" />
        <span>Left {lw}×{lh}, {formatSize(leftDoc.size)}</span>
        <span>Right {rw}×{rh}, {formatSize(rightDoc.size)}</span>
      </StatusBar>
    </div>
  );
}

function PaneLabel({ side, info }: { side: string; info: { w: number; h: number } }) {
  return (
    <span>
      {side} <span className="pc-hint">{info.w}×{info.h}</span>
    </span>
  );
}

/** A pannable, zoomable viewport. All panes share one view so they stay in sync. */
function Pane(props: {
  pan: (dx: number, dy: number) => void;
  zoomAt: (factor: number, px?: number, py?: number) => void;
  onSize: (s: { w: number; h: number }) => void;
  onNudge: (dx: number, dy: number) => void;
  measure?: boolean;
  nudgeable?: boolean;
  label: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pan, zoomAt, onSize, measure } = props;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !measure) return;
    const report = () => el.clientWidth && el.clientHeight && onSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [measure, onSize]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 33 : 1)), e.clientX - r.left, e.clientY - r.top);
      } else if (e.shiftKey && !e.deltaX) pan(-e.deltaY, 0);
      else pan(-e.deltaX, -e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pan, zoomAt]);

  return (
    <div
      className={`pc-pane ${props.nudgeable ? 'nudgeable' : ''}`}
      ref={ref}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.pc-handle')) return;
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        let lx = e.clientX;
        let ly = e.clientY;
        const el = e.currentTarget;
        el.classList.add('dragging');
        const move = (ev: PointerEvent) => {
          pan(ev.clientX - lx, ev.clientY - ly);
          lx = ev.clientX;
          ly = ev.clientY;
        };
        const up = () => {
          el.classList.remove('dragging');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onKeyDown={(e) => {
        if (!props.nudgeable || e.altKey || e.ctrlKey || e.metaKey) return;
        const step = e.shiftKey ? 10 : 1;
        const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
        if (d) {
          e.preventDefault();
          props.onNudge(d[0], d[1]);
        }
      }}
      title={props.nudgeable ? 'Drag to pan, Ctrl+wheel to zoom, arrow keys move the right image' : 'Drag to pan, Ctrl+wheel to zoom'}
    >
      {props.children}
      {props.overlay}
      <div className="pc-label">{props.label}</div>
    </div>
  );
}

/** The overlay slider's handle: a vertical seam that reveals the right image. */
function SplitHandle({ split, onSplit }: { split: number; onSplit: (f: number) => void }) {
  return (
    <div
      className="pc-handle"
      style={{ left: `${split * 100}%` }}
      role="slider"
      aria-label="Split position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split * 100)}
      onPointerDown={(e) => {
        e.stopPropagation();
        const pane = e.currentTarget.parentElement!;
        const r = pane.getBoundingClientRect();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => onSplit(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    >
      <div className="pc-grip">
        <span />
        <span />
      </div>
    </div>
  );
}
