// ZIP compare (the folder tree over archive entries), ZIP merge (entry by
// entry) and whole-file merge (pick a version), in CompareCraft's design.
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, File as FileIcon, GitCompareArrows, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryChoice } from '../../src/core/archive';
import { formatSize } from '../../src/core/bytes';
import type { FolderRow } from '../../src/core/folder';
import type { ArchiveDiffInit, ArchiveMergeInit, FileDoc, MergeSideName, WholeMergeInit } from '../../src/shared/protocol';
import { Counter, ICON, LIST_ROW_H, PathBars3, Stat, StatusBar, useNavKeys } from './ui/ui';
import { FolderDiffView } from './FolderDiffView';
import { onHostMessage, post } from './vscode';

const size = (n: number | null) => (n === null ? '—' : formatSize(n));

function useSaveState() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  useEffect(() => onHostMessage((m) => m.type === 'saved' && setState(m.ok ? 'saved' : 'failed')), []);
  return [state, setState] as const;
}

export function ArchiveDiffView({ init }: { init: ArchiveDiffInit }) {
  const rows = useMemo(
    () =>
      init.entries
        .filter((e) => !e.name.endsWith('/'))
        .map((e): FolderRow => ({ path: e.name, status: e.status === 'changed' ? 'different' : e.status, leftSize: e.leftSize, rightSize: e.rightSize })),
    [init],
  );
  return (
    <FolderDiffView
      init={{ view: 'folder-diff', left: init.left, right: init.right, rows, source: 'archive' }}
      onOpen={(name) => post({ type: 'openEntry', name })}
    />
  );
}

const CHOICES: [EntryChoice, string][] = [
  ['ours', 'Ours'],
  ['theirs', 'Theirs'],
  ['base', 'Base'],
  ['delete', 'Delete'],
];

export function ArchiveMergeView({ init }: { init: ArchiveMergeInit }) {
  const [choices, setChoices] = useState<Record<string, EntryChoice | null>>(() => Object.fromEntries(init.entries.map((e) => [e.name, e.auto])));
  const [show, setShow] = useState<'changed' | 'all'>('changed');
  const [current, setCurrent] = useState(-1);
  const [save, setSave] = useSaveState();
  const scroller = useRef<HTMLDivElement>(null);
  const open = init.entries.filter((e) => choices[e.name] === null).length;
  const rows = useMemo(() => init.entries.filter((e) => show === 'all' || e.note !== 'unchanged'), [init, show]);
  const conflictRows = useMemo(() => rows.flatMap((e, i) => (e.auto === null ? [i] : [])), [rows]);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => LIST_ROW_H + 4, overscan: 12 });

  const choose = (name: string, c: EntryChoice) => {
    setChoices((prev) => ({ ...prev, [name]: c }));
    setSave('idle');
  };
  const takeAll = (side: 'ours' | 'theirs') => {
    const next = { ...choices };
    for (const e of init.entries) if (next[e.name] === null) next[e.name] = e.sizes[side] === null ? 'delete' : side;
    setChoices(next);
    setSave('idle');
  };
  const goto = (i: number) => {
    if (i < 0 || i >= conflictRows.length) return;
    setCurrent(i);
    virt.scrollToIndex(conflictRows[i], { align: 'center' });
  };
  const next = () => goto(current + 1 < conflictRows.length ? current + 1 : 0);
  const prev = () => goto(current > 0 ? current - 1 : conflictRows.length - 1);
  useNavKeys(next, prev);
  const resolved = init.entries.filter((e) => e.auto === null && choices[e.name] !== null).length;
  const auto = init.entries.filter((e) => e.auto !== null && e.note !== 'unchanged').length;

  return (
    <div className="view">
      <PathBars3 sides={[['ours', init.ours], ['base', init.base], ['theirs', init.theirs]]} />
      <div className="toolbar">
        <button className="icon-btn" title="Previous conflict (Alt+Up)" onClick={prev} disabled={!conflictRows.length}><ArrowUp size={ICON.lg} /></button>
        <button className="icon-btn" title="Next conflict (Alt+Down)" onClick={next} disabled={!conflictRows.length}><ArrowDown size={ICON.lg} /></button>
        <Counter current={current} total={conflictRows.length} none="No conflicts" />
        <div className="divider-v" />
        <div className="seg" role="group" aria-label="Entries to show">
          <button className={show === 'changed' ? 'on' : ''} onClick={() => setShow('changed')}>Changed</button>
          <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All entries</button>
        </div>
        <div className="divider-v" />
        <button className="btn ghost" onClick={() => takeAll('ours')} disabled={!open}>Take ours for the rest</button>
        <button className="btn ghost" onClick={() => takeAll('theirs')} disabled={!open}>Take theirs for the rest</button>
        <div className="grow" />
        <button className="btn ghost" onClick={() => post({ type: 'save', result: { format: 'whole', take: 'ours' } })} title="Keep our archive unchanged">Keep ours file</button>
        <button className="btn ghost" onClick={() => post({ type: 'save', result: { format: 'whole', take: 'theirs' } })} title="Replace it with their archive">Take theirs file</button>
        <button
          className="btn primary"
          disabled={open > 0 || save === 'saving'}
          title={open ? 'Resolve all conflicts first' : `Write the merged archive to ${init.outputLabel}`}
          onClick={() => {
            setSave('saving');
            post({ type: 'save', result: { format: 'archive', entries: choices as Record<string, EntryChoice> } });
          }}
        >
          <Save size={ICON.md} /> {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : 'Save merge'}
        </button>
      </div>
      <div className="banner info">The archive is written again with the chosen entries; signatures inside it (for example in .jar or .apk files) no longer match.</div>
      {save === 'failed' && <div className="banner">Saving failed.</div>}
      <div className="am-head">
        <span>Entry</span>
        <span>What happened</span>
        <span className="am-num">Base</span>
        <span className="am-num">Ours</span>
        <span className="am-num">Theirs</span>
        <span>Result</span>
      </div>
      <div className="am-scroll" ref={scroller}>
        <div className="am-rows" style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vi) => {
            const e = rows[vi.index];
            const c = choices[e.name];
            const conflict = e.auto === null;
            const isCurrent = current >= 0 && conflictRows[current] === vi.index;
            return (
              <div
                key={e.name}
                className={`am-row ${conflict ? (c === null ? 'conflict' : 'resolved') : ''} ${isCurrent ? 'current' : ''}`}
                style={{ transform: `translateY(${vi.start}px)`, height: LIST_ROW_H + 4 }}
              >
                <span className="am-name" title={e.name}>
                  <FileIcon size={ICON.md} className="fc-icon" />
                  {e.name}
                </span>
                <span className={`am-note ${conflict ? 'conflict' : ''}`}>{e.note}</span>
                <span className="am-num">{size(e.sizes.base)}</span>
                <span className="am-num">{size(e.sizes.ours)}</span>
                <span className="am-num">{size(e.sizes.theirs)}</span>
                <span className="am-result">
                  <span className="seg sm" role="group" aria-label={`Result for ${e.name}`}>
                    {CHOICES.filter(([k]) => k === 'delete' || e.sizes[k as MergeSideName] !== null).map(([k, label]) => (
                      <button key={k} className={`${c === k ? 'on' : ''} ${k === 'delete' ? 'am-del' : ''}`} onClick={() => choose(e.name, k)}>
                        {label}
                      </button>
                    ))}
                  </span>
                  {e.sizes.ours !== null && e.sizes.theirs !== null && (
                    <button className="icon-btn sm" title="Compare ours with theirs" onClick={() => post({ type: 'compareEntry', name: e.name, a: 'ours', b: 'theirs' })}>
                      <GitCompareArrows size={ICON.md} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <StatusBar>
        <Stat swatch="sw-conflict">{open.toLocaleString()} unresolved</Stat>
        <Stat swatch="sw-edited">{resolved.toLocaleString()} resolved by you</Stat>
        <Stat swatch="sw-both">{auto.toLocaleString()} merged automatically</Stat>
        <span className="grow" />
        <span>Result: {init.outputLabel}</span>
      </StatusBar>
    </div>
  );
}

function SideCard(props: { title: string; side: MergeSideName; doc: FileDoc | null; chosen: boolean; onUse(): void }) {
  const { doc } = props;
  return (
    <div className={`wm-card wm-${props.side} ${props.chosen ? 'chosen' : ''}`}>
      <div className="wm-title">
        <span className={`swatch sw-${props.side === 'base' ? 'both' : props.side}`} />
        {props.title}
        {doc && <span className="wm-size">{formatSize(doc.size)}</span>}
      </div>
      {doc ? (
        <>
          <div className="wm-label" title={doc.detail}>{doc.label}</div>
          {doc.image ? (
            <div className="wm-image">
              <img className="pc-img" src={`data:${doc.image.mime};base64,${doc.image.base64}`} alt={props.title} />
            </div>
          ) : (
            <div className="wm-image wm-noimage">
              <FileIcon size={ICON.xl} />
            </div>
          )}
          <button className={`btn ${props.chosen ? 'primary' : ''}`} onClick={props.onUse}>Use {props.title.toLowerCase()}</button>
        </>
      ) : (
        <div className="wm-image wm-noimage cc-hatch">{props.side === 'base' ? 'No common ancestor (added on both sides)' : 'Deleted on this side'}</div>
      )}
    </div>
  );
}

export function WholeMergeView({ init }: { init: WholeMergeInit }) {
  const [save, setSave] = useSaveState();
  const [chosen, setChosen] = useState<MergeSideName | 'delete' | null>(null);
  const use = (take: MergeSideName | 'delete') => {
    setChosen(take);
    setSave('saving');
    post({ type: 'save', result: { format: 'whole', take } });
  };
  const pair = (a: MergeSideName, b: MergeSideName, label: string) =>
    init[a] && init[b] ? (
      <button className="btn ghost" onClick={() => post({ type: 'compareSides', a, b })} title={`Open a compare view of ${a} and ${b}`}>
        <GitCompareArrows size={ICON.md} /> {label}
      </button>
    ) : null;
  return (
    <div className="view">
      <PathBars3 sides={[['ours', init.ours], ['base', init.base], ['theirs', init.theirs]]} />
      <div className="toolbar">
        {pair('ours', 'theirs', 'Ours ↔ Theirs')}
        {pair('base', 'ours', 'Base ↔ Ours')}
        {pair('base', 'theirs', 'Base ↔ Theirs')}
        <div className="grow" />
        <button className="btn ghost danger" onClick={() => use('delete')}><Trash2 size={ICON.md} /> Delete the file</button>
      </div>
      <div className="banner info">{init.kind === 'picture' ? 'Images' : 'Binary files'} can't be merged part by part; pick the version to keep.</div>
      {save === 'failed' && <div className="banner">Saving failed.</div>}
      <div className="wm-cards">
        <SideCard title="Ours" side="ours" doc={init.ours} chosen={chosen === 'ours'} onUse={() => use('ours')} />
        <SideCard title="Base" side="base" doc={init.base} chosen={chosen === 'base'} onUse={() => use('base')} />
        <SideCard title="Theirs" side="theirs" doc={init.theirs} chosen={chosen === 'theirs'} onUse={() => use('theirs')} />
      </div>
      <StatusBar>
        <span>{save === 'saving' ? 'Saving…' : save === 'saved' ? (chosen === 'delete' ? 'File deleted' : `Saved the ${chosen} version`) : 'No version chosen yet'}</span>
        <span className="grow" />
        <span>Result: {init.outputLabel}</span>
      </StatusBar>
    </div>
  );
}
