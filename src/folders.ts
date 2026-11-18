// Folder comparison views: two folders on disk, or the changes between two git
// refs (optionally limited to one folder). Both show the same tree; clicking
// a file opens it in the matching compare view.

import * as vscode from 'vscode';
import { bytesEqual, compareListings, comparePaths, globMatcher, type FileInfo, type FolderRow } from './core/folder';
import { openCompare } from './compare';
import { Status, type Change, type Repository } from './git/api';
import { EMPTY_TREE, WORKING_TREE } from './git/revisions';
import type { FolderDiffInit } from './shared/protocol';
import { fileSide, gitSide, maxBytes } from './sides';
import { openPanel, type Post } from './webview';

let extensionUri: vscode.Uri;

export function initFolders(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
}

const MAX_FILES = 200_000;

function excludeMatcher(): (path: string) => boolean {
  const config = vscode.workspace.getConfiguration();
  const own = config.get<string[]>('vscodeCompare.folderExclude', []);
  const filesExclude = Object.entries(config.get<Record<string, boolean>>('files.exclude', {}))
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
  return globMatcher([...own, ...filesExclude]);
}

/** Lists files under a folder, skipping excluded paths and symbolic links. */
export async function listFolder(root: vscode.Uri, token?: vscode.CancellationToken): Promise<{ files: FileInfo[]; truncated: boolean }> {
  const excluded = excludeMatcher();
  const files: FileInfo[] = [];
  let truncated = false;
  const walk = async (dir: vscode.Uri, rel: string): Promise<void> => {
    if (token?.isCancellationRequested || truncated) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    const subdirs: Promise<void>[] = [];
    for (const [name, type] of entries) {
      const path = rel ? `${rel}/${name}` : name;
      if (excluded(path) || type & vscode.FileType.SymbolicLink) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) subdirs.push(walk(uri, path));
      else if (type & vscode.FileType.File) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.push({ path, size: (await vscode.workspace.fs.stat(uri)).size });
      }
    }
    await Promise.all(subdirs);
  };
  await walk(root, '');
  return { files, truncated };
}

function relPath(root: vscode.Uri, uri: vscode.Uri): string {
  const r = root.path.endsWith('/') ? root.path : root.path + '/';
  return uri.path.startsWith(r) ? uri.path.slice(r.length) : uri.path;
}

export async function openFolderCompare(left: vscode.Uri, right: vscode.Uri): Promise<void> {
  const name = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
  let rows: FolderRow[] = [];
  let checking: vscode.CancellationTokenSource | undefined;
  const panel = openPanel(
    extensionUri,
    `${name(left)} ↔ ${name(right)}`,
    async (): Promise<FolderDiffInit> => {
      const [l, r] = await Promise.all([listFolder(left), listFolder(right)]);
      rows = compareListings(l.files, r.files);
      const note = l.truncated || r.truncated ? `Only the first ${MAX_FILES.toLocaleString()} files were compared.` : undefined;
      return { view: 'folder-diff', left: { label: name(left), detail: left.fsPath }, right: { label: name(right), detail: right.fsPath }, rows, source: 'folders', note };
    },
    {
      async onMessage(msg, post) {
        if (msg.type === 'folderReady') {
          checking?.cancel();
          checking = new vscode.CancellationTokenSource();
          void checkContents(left, right, rows, post, checking.token);
        }
        if (msg.type === 'openPath') {
          const row = rows.find((x) => x.path === msg.path);
          if (!row) return;
          const l = vscode.Uri.joinPath(left, row.path), r = vscode.Uri.joinPath(right, row.path);
          if (row.status === 'left-only' || row.status === 'right-only') {
            await vscode.commands.executeCommand('vscode.open', row.status === 'left-only' ? l : r, { preview: true });
          } else await openCompare(fileSide(l), fileSide(r));
        }
      },
    },
  );
  panel.onDidDispose(() => checking?.cancel());
}

/** Compares same-size files byte by byte, sending results in batches. */
async function checkContents(left: vscode.Uri, right: vscode.Uri, rows: FolderRow[], post: Post, token: vscode.CancellationToken): Promise<void> {
  const todo = rows.filter((r) => r.status === 'unknown');
  const limit = maxBytes();
  let batch: FolderRow[] = [];
  let last = Date.now();
  const flush = async () => {
    if (batch.length) await post({ type: 'folderRows', rows: batch });
    batch = [];
    last = Date.now();
  };
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !token.isCancellationRequested) {
      const row = todo[next++];
      if ((row.leftSize ?? 0) > limit) {
        // Too large to read fully: leave it as unknown; it can still be opened.
        continue;
      }
      let status: FolderRow['status'];
      try {
        const [a, b] = await Promise.all([vscode.workspace.fs.readFile(vscode.Uri.joinPath(left, row.path)), vscode.workspace.fs.readFile(vscode.Uri.joinPath(right, row.path))]);
        status = bytesEqual(a, b) ? 'same' : 'different';
      } catch {
        continue;
      }
      // The listing stays as loaded; results only go to the page.
      batch.push({ ...row, status });
      if (batch.length >= 200 || Date.now() - last > 300) await flush();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (!token.isCancellationRequested) {
    await flush();
    await post({ type: 'folderRows', rows: [], done: true });
  }
}

function rowFromChange(root: vscode.Uri, c: Change): FolderRow {
  const path = relPath(root, c.renameUri ?? c.uri);
  switch (c.status) {
    case Status.INDEX_ADDED:
    case Status.UNTRACKED:
    case Status.INTENT_TO_ADD:
    case Status.ADDED_BY_US:
    case Status.ADDED_BY_THEM:
      return { path, status: 'right-only', leftSize: null, rightSize: null };
    case Status.INDEX_DELETED:
    case Status.DELETED:
    case Status.DELETED_BY_US:
    case Status.DELETED_BY_THEM:
      return { path: relPath(root, c.originalUri), status: 'left-only', leftSize: null, rightSize: null };
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return { path, status: 'renamed', oldPath: relPath(root, c.originalUri), leftSize: null, rightSize: null };
    default:
      return { path, status: 'different', leftSize: null, rightSize: null };
  }
}

export interface GitCompare {
  repo: Repository;
  /** Left ref. */
  from: string;
  fromLabel: string;
  /** Right ref, or WORKING_TREE. */
  to: string;
  toLabel: string;
  /** Limit to this folder (relative to the repository root). */
  folder?: string;
}

/** Files changed from `from` to `to` (two-dot: what you would get by checking out each). */
export async function changesBetween(repo: Repository, from: string, to: string): Promise<Change[]> {
  if (to === WORKING_TREE) return repo.diffWith(from);
  if (repo.diffBetweenWithStats2) return repo.diffBetweenWithStats2(`${from}..${to}`);
  // Older git extensions only offer `from...to`, which starts at the merge
  // base. That is the same thing when `from` is an ancestor of `to`.
  if (from !== EMPTY_TREE) {
    const [base, fromCommit] = await Promise.all([repo.getMergeBase(from, to), repo.getCommit(from)]);
    if (base && base === fromCommit.hash) return repo.diffBetween(from, to);
  }
  throw new Error(`This version of VS Code's git extension can only list the changes on ${to} since it split off ${from}. Turn on "since it split off" (merge base), or update VS Code.`);
}

export async function openGitChanges(g: GitCompare): Promise<void> {
  const root = g.repo.rootUri;
  const prefix = g.folder ? g.folder.replace(/\/?$/, '/') : '';
  let rows: FolderRow[] = [];
  const title = `${g.folder ? `${g.folder}: ` : ''}${g.fromLabel} ↔ ${g.toLabel}`;
  openPanel(
    extensionUri,
    title,
    async (): Promise<FolderDiffInit> => {
      const changes = await changesBetween(g.repo, g.from, g.to);
      rows = changes
        .map((c) => rowFromChange(root, c))
        .filter((r) => !prefix || r.path.startsWith(prefix) || r.oldPath?.startsWith(prefix))
        .map((r) => (prefix ? { ...r, path: r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path, oldPath: r.oldPath?.startsWith(prefix) ? r.oldPath.slice(prefix.length) : r.oldPath } : r))
        .sort((a, b) => comparePaths(a.path, b.path));
      return {
        view: 'folder-diff',
        left: { label: g.fromLabel, detail: `${g.folder ?? vscode.workspace.asRelativePath(root)} at ${g.fromLabel}` },
        right: { label: g.toLabel, detail: `${g.folder ?? vscode.workspace.asRelativePath(root)} at ${g.toLabel}` },
        rows,
        source: 'git',
        note: g.to === WORKING_TREE ? 'Untracked files are not listed.' : undefined,
      };
    },
    {
      async onMessage(msg) {
        if (msg.type !== 'openPath') return;
        const row = rows.find((x) => x.path === msg.path);
        if (!row) return;
        const uriOf = (p: string) => vscode.Uri.joinPath(root, prefix + p);
        const right = g.to === WORKING_TREE ? fileSide(uriOf(row.path)) : await gitSide(g.repo, uriOf(row.path), g.to, g.toLabel);
        const left = await gitSide(g.repo, uriOf(row.oldPath ?? row.path), g.from, g.fromLabel);
        if (row.status === 'left-only') return void openSingle(left);
        if (row.status === 'right-only') return void openSingle(right);
        await openCompare(left, right);
      },
    },
  );
}

async function openSingle(side: { textUri: vscode.Uri }): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', side.textUri, { preview: true });
}
