// Building blocks shared by every view, following CompareCraft's design
// system: path bars, status bar, dialogs, empty states and the theme switch.
import { ArrowLeftRight, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import type { FileDoc } from '../../../src/shared/protocol';

/** Icon sizes for lucide icons (--icon-*). */
export const ICON = { sm: 12, md: 14, lg: 16, xl: 20 } as const;

/** Code rows use the editor font size (10-20px); row heights follow it. */
function codeSize(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size'));
  return Number.isFinite(px) ? Math.min(20, Math.max(10, px)) : 13;
}
export const CODE_SIZE = codeSize();
export const LIST_ROW_H = Math.round(CODE_SIZE * 1.55) + 2;
export const CODE_ROW_H = Math.round(CODE_SIZE * 1.55);

export interface SideInfo {
  label: string;
  detail?: string;
}

export const sideOf = (d: FileDoc | SideInfo | null | undefined): SideInfo | null => (d ? { label: d.label, detail: d.detail } : null);

function PathBar({ tag, side, readonly, actions }: { tag: string; side: SideInfo | null; readonly?: boolean; actions?: ReactNode }) {
  return (
    <div className="pathbar">
      <span className="side-tag" title={`${tag} side`}>{tag[0].toUpperCase()}</span>
      <input className="input" value={side?.label ?? '(none)'} readOnly title={side?.detail ?? side?.label} />
      {readonly && <span className="ro-tag">read-only</span>}
      {actions}
    </div>
  );
}

/** The bar above a two-way view: left path, swap button, right path. */
export function PathBars(props: { left: SideInfo | null; right: SideInfo | null; onSwap?: () => void; leftActions?: ReactNode; rightActions?: ReactNode }) {
  return (
    <div className="pathbars">
      <PathBar tag="left" side={props.left} actions={props.leftActions} />
      <div className="swap">
        {props.onSwap && (
          <button className="icon-btn" title="Swap sides" onClick={props.onSwap}>
            <ArrowLeftRight size={ICON.lg} />
          </button>
        )}
      </div>
      <PathBar tag="right" side={props.right} actions={props.rightActions} />
    </div>
  );
}

/** Three paths, for merge views. */
export function PathBars3(props: { sides: [string, SideInfo | null][] }) {
  return (
    <div className="pathbars three">
      {props.sides.map(([tag, side]) => (
        <PathBar key={tag} tag={tag} side={side} />
      ))}
    </div>
  );
}

export function StatusBar({ children }: { children: ReactNode }) {
  return <div className="statusbar">{children}</div>;
}

export function Stat({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="stat">
      <span className={`swatch ${swatch}`} />
      {children}
    </span>
  );
}

export function Dialog(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`dialog dialog-${props.size ?? 'md'}`} role="dialog" aria-modal="true">
        <header>
          <span className="dialog-title">{props.title}</span>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            <X size={ICON.lg} />
          </button>
        </header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center-state">
      <div>
        <span className="spinner" /> {label && <span className="state-label">{label}</span>}
      </div>
    </div>
  );
}

export function ErrorState({ error }: { error: string }) {
  return (
    <div className="center-state">
      <div className="err">{error}</div>
    </div>
  );
}

/** "3 of 12" next to the previous/next buttons. */
export function Counter({ current, total, none = 'No differences' }: { current: number; total: number; none?: string }) {
  return <span className="cc-counter">{total ? `${current >= 0 ? (current + 1).toLocaleString() : '–'} of ${total.toLocaleString()}` : none}</span>;
}

export interface SheetTab {
  name: string;
  /** Marker after the name: a change dot, a conflict count. */
  badge?: string;
  tone?: 'changed' | 'conflict' | 'missing';
  title?: string;
}

/** Worksheet tabs at the bottom of Excel views, like a spreadsheet. */
export function SheetTabs(props: { tabs: SheetTab[]; active: number; onSelect(i: number): void }) {
  if (props.tabs.length <= 1) return null;
  return (
    <div className="cc-sheets" role="tablist">
      {props.tabs.map((t, i) => (
        <button
          key={t.name + i}
          role="tab"
          aria-selected={i === props.active}
          className={`cc-sheet ${i === props.active ? 'on' : ''} ${t.tone ?? ''}`}
          onClick={() => props.onSelect(i)}
          title={t.title}
        >
          {t.name}
          {t.badge ? <span className="cc-sheet-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Next/previous difference: Alt+Down/Up, F7/Shift+F7 (VS Code's diff keys) and F8/Shift+F8 (CompareCraft's). */
export function useNavKeys(next: () => void, prev: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const f = e.key === 'F7' || e.key === 'F8';
      if ((e.altKey && e.key === 'ArrowDown') || (f && !e.shiftKey)) {
        e.preventDefault();
        next();
      } else if ((e.altKey && e.key === 'ArrowUp') || (f && e.shiftKey)) {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);
}
