// Messages between the extension host and the webview. Both sides import this
// file; it must not import vscode or Node modules.

import type { ArchiveDiffEntry, ArchiveMergeEntry, EntryChoice } from '../core/archive';
import type { ByteRange } from '../core/bytes';
import type { SheetPlan, SheetTable } from '../core/excel';
import type { FolderRow } from '../core/folder';

export type TableFormat = 'csv' | 'excel';

export interface TableDoc {
  label: string;
  /** Longer description (path, commit), shown as a tooltip. */
  detail?: string;
  format: TableFormat;
  sheets: SheetTable[];
  notes?: string[];
}

export interface TableDiffInit {
  view: 'table-diff';
  left: TableDoc;
  right: TableDoc;
}

export interface TableViewInit {
  view: 'table-view';
  doc: TableDoc;
}

export interface TableMergeInit {
  view: 'table-merge';
  format: TableFormat;
  /** A side is null when the file doesn't exist there (added, or deleted). */
  base: TableDoc | null;
  ours: TableDoc | null;
  theirs: TableDoc | null;
  outputLabel: string;
}

export interface ErrorInit {
  view: 'error';
  message: string;
}

/** A file shown by name and size; images also carry their bytes. */
export interface FileDoc {
  label: string;
  detail?: string;
  size: number;
  image?: { mime: string; base64: string };
}

export interface PictureDiffInit {
  view: 'picture-diff';
  left: FileDoc;
  right: FileDoc;
}

/** Bytes are fetched page by page with `readBytes`. */
export interface HexDiffInit {
  view: 'hex-diff';
  left: FileDoc;
  right: FileDoc;
  ranges: ByteRange[];
  differentBytes: number;
  merged: boolean;
}

export interface ArchiveDiffInit {
  view: 'archive-diff';
  left: FileDoc;
  right: FileDoc;
  entries: ArchiveDiffEntry[];
}

/** Merge by picking one whole file: images and other binary files. */
export interface WholeMergeInit {
  view: 'whole-merge';
  kind: 'picture' | 'binary';
  base: FileDoc | null;
  ours: FileDoc | null;
  theirs: FileDoc | null;
  outputLabel: string;
}

export interface ArchiveMergeInit {
  view: 'archive-merge';
  base: FileDoc | null;
  ours: FileDoc;
  theirs: FileDoc;
  entries: ArchiveMergeEntry[];
  outputLabel: string;
}

export interface FolderDiffInit {
  view: 'folder-diff';
  left: { label: string; detail?: string };
  right: { label: string; detail?: string };
  rows: FolderRow[];
  /** 'folders': same-size files are checked after load; 'git' and 'archive': statuses are final. */
  source: 'folders' | 'git' | 'archive';
  note?: string;
}

export type InitPayload =
  | TableDiffInit
  | TableViewInit
  | TableMergeInit
  | PictureDiffInit
  | HexDiffInit
  | ArchiveDiffInit
  | WholeMergeInit
  | ArchiveMergeInit
  | FolderDiffInit
  | ErrorInit;

export type MergeSideName = 'base' | 'ours' | 'theirs';

export type HostMessage =
  | { type: 'init'; payload: InitPayload }
  | { type: 'saved'; ok: boolean; message?: string }
  | { type: 'bytes'; id: number; base64: string }
  /** Folder compare: rows whose status changed after a content check. */
  | { type: 'folderRows'; rows: FolderRow[]; done?: boolean };

export type MergeResult =
  | { format: 'csv'; rows: string[][] }
  | { format: 'excel'; sheets: SheetPlan[] }
  /** Take one side's file as it is, or delete the file. */
  | { format: 'whole'; take: 'base' | 'ours' | 'theirs' | 'delete' }
  /** Each archive entry taken from one side, or dropped. */
  | { format: 'archive'; entries: Record<string, EntryChoice> };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'save'; result: MergeResult }
  | { type: 'compareWith' }
  | { type: 'openAsText' }
  | { type: 'error'; message: string }
  /** Hex view paging. */
  | { type: 'readBytes'; id: number; side: 'left' | 'right'; offset: number; length: number }
  /** Archive diff: compare one entry of both archives. */
  | { type: 'openEntry'; name: string }
  /** Archive merge: compare an entry across two sides. */
  | { type: 'compareEntry'; name: string; a: MergeSideName; b: MergeSideName }
  /** Folder compare: the page is showing rows; start content checks. */
  | { type: 'folderReady' }
  /** Folder compare: open one file pair. */
  | { type: 'openPath'; path: string }
  /** Merge views: compare two whole sides. */
  | { type: 'compareSides'; a: MergeSideName; b: MergeSideName };
