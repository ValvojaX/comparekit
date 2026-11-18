// Quick pick of git revisions for a file: HEAD, index, branches, tags and the
// file's own history. Any other ref expression can be typed in.

import * as vscode from 'vscode';
import { RefType, type Repository } from './api';

export interface Revision {
  /** Passed to `git show <ref>:<path>`; '' is the index. */
  ref: string;
  /** Short human label, e.g. "main" or "a1b2c3d Fix import". */
  description: string;
}

interface RevisionItem extends vscode.QuickPickItem {
  revision?: Revision;
}

function relativeDate(d: Date | undefined): string {
  if (!d) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  const units: [number, string][] = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [secs, name] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function subject(message: string): string {
  return message.split('\n', 1)[0];
}

/**
 * Refs that are safe to pass to git as an argument: no leading '-', so they
 * can't be read as an option, and only characters that appear in ref names
 * and revision expressions such as HEAD~3 or main@{1}.
 */
export function isSafeRef(ref: string): boolean {
  return /^[\w./~^@{}][\w./~^@{}-]*$/.test(ref);
}

/** git's empty tree object: the "parent" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The working tree, as a pseudo-ref for pickers. Never passed to git. */
export const WORKING_TREE = '<working-tree>';

export interface PickOptions {
  title: string;
  /** Show this file's history. */
  file?: vscode.Uri;
  /** Offer the working tree as a choice. */
  workingTree?: boolean;
  /** Offer the index. Default: true. */
  index?: boolean;
}

export async function pickRevision(repo: Repository, uri: vscode.Uri | undefined, title: string): Promise<Revision | undefined> {
  return pickRef(repo, { title, file: uri });
}

export async function pickRef(repo: Repository, opts: PickOptions): Promise<Revision | undefined> {
  const uri = opts.file;
  const title = opts.title;
  const qp = vscode.window.createQuickPick<RevisionItem>();
  qp.title = title;
  qp.placeholder = 'Pick a revision, or type a branch, tag, commit or expression such as HEAD~3';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;

  const head = repo.state.HEAD;
  const fixed: RevisionItem[] = [
    {
      label: '$(git-commit) HEAD',
      description: head?.name ? `${head.name}${head.commit ? ` · ${head.commit.slice(0, 7)}` : ''}` : head?.commit?.slice(0, 7),
      revision: { ref: 'HEAD', description: 'HEAD' },
    },
    ...(opts.index === false ? [] : [{ label: '$(diff) Index', description: 'staged version', revision: { ref: '', description: 'Index' } }]),
  ];
  if (opts.workingTree) fixed.unshift({ label: '$(edit) Working Tree', description: 'files on disk', revision: { ref: WORKING_TREE, description: 'Working Tree' } });
  qp.items = fixed;
  qp.show();

  const [refs, history] = await Promise.all([
    (repo.getRefs ? repo.getRefs({ sort: 'committerdate' }) : Promise.resolve(repo.state.refs)).catch(() => repo.state.refs),
    uri ? repo.log({ path: uri.fsPath, maxEntries: 100 }).catch(() => []) : Promise.resolve([]),
  ]);
  const branches = refs.filter((r) => r.type === RefType.Head && r.name);
  const remotes = refs.filter((r) => r.type === RefType.RemoteHead && r.name && !r.name.endsWith('/HEAD'));
  const tags = refs.filter((r) => r.type === RefType.Tag && r.name);
  const refItem = (icon: string) => (r: (typeof refs)[number]): RevisionItem => ({
    label: `$(${icon}) ${r.name}`,
    description: r.commit?.slice(0, 7),
    revision: { ref: r.name!, description: r.name! },
  });
  const sep = (label: string): RevisionItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const base: RevisionItem[] = [
    ...fixed,
    ...(history.length ? [sep('File history'), ...history.map((c): RevisionItem => ({
      label: `$(git-commit) ${c.hash.slice(0, 7)} ${subject(c.message)}`,
      description: [c.authorName, relativeDate(c.authorDate)].filter(Boolean).join(' · '),
      revision: { ref: c.hash, description: `${c.hash.slice(0, 7)} ${subject(c.message)}`.slice(0, 60) },
    }))] : []),
    ...(branches.length ? [sep('Branches'), ...branches.map(refItem('git-branch'))] : []),
    ...(remotes.length ? [sep('Remote branches'), ...remotes.map(refItem('cloud'))] : []),
    ...(tags.length ? [sep('Tags'), ...tags.map(refItem('tag'))] : []),
  ];
  qp.items = base;
  qp.busy = false;

  qp.onDidChangeValue((value) => {
    const v = value.trim();
    const exact = base.some((i) => i.revision?.ref === v);
    // No leading '-': the ref ends up in a git argument and must not read as an option.
    qp.items = v && !exact && isSafeRef(v)
      ? [{ label: `$(edit) Use "${v}"`, alwaysShow: true, revision: { ref: v, description: v } }, ...base]
      : base;
  });

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.revision);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}
