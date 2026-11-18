// Command handlers: they work out the two (or three) sides and hand them to
// the dispatcher in compare.ts.

import * as vscode from 'vscode';
import { openCompare, openMerge } from './compare';
import { baseName } from './formats';
import { detectKind } from './formats';
import { openFolderCompare, openGitChanges } from './folders';
import { gitApi, Status, type Change, type Repository } from './git/api';
import { isSafeRef, pickRef, pickRevision, WORKING_TREE, type Revision } from './git/revisions';
import { fileSide, gitSide, refLabel, repositoryFor } from './sides';

let selected: vscode.Uri | undefined;
let selectionItem: vscode.StatusBarItem | undefined;

/** The file a command applies to: its argument, or the active editor's file. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const withUri = arg as { resourceUri?: vscode.Uri } | undefined;
  if (withUri?.resourceUri instanceof vscode.Uri) return withUri.resourceUri;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (tab instanceof vscode.TabInputText || tab instanceof vscode.TabInputCustom) return tab.uri;
  if (tab instanceof vscode.TabInputTextDiff) return tab.modified;
  return vscode.window.activeTextEditor?.document.uri;
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

export async function compareFiles(left: vscode.Uri, right: vscode.Uri): Promise<void> {
  const [ld, rd] = await Promise.all([isDirectory(left), isDirectory(right)]);
  if (ld || rd) {
    if (ld !== rd) {
      void vscode.window.showWarningMessage('A file can only be compared with a file, and a folder with a folder.');
      return;
    }
    await openFolderCompare(left, right);
    return;
  }
  await openCompare(fileSide(left), fileSide(right));
}

async function noRepository(uri: vscode.Uri): Promise<undefined> {
  void vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(uri)} is not in a git repository.`);
  return undefined;
}

/** `ref` skips the picker (for keybindings and scripts). */
async function compareWithRevision(arg: unknown, ref?: string): Promise<void> {
  const uri = targetUri(arg);
  if (!uri) return;
  if (typeof ref === 'string' && ref !== '' && !isSafeRef(ref)) throw new Error(`"${ref}" is not a valid git revision.`);
  const repo = (await repositoryFor(uri)) ?? (await noRepository(uri));
  if (!repo) return;
  if (await isDirectory(uri)) {
    const rev = typeof ref === 'string' ? { ref, description: ref } : await pickRef(repo, { title: `Compare folder ${vscode.workspace.asRelativePath(uri)} with...` });
    if (!rev) return;
    const folder = uri.path.slice(repo.rootUri.path.replace(/\/$/, '').length + 1);
    await openGitChanges({ repo, from: rev.ref, fromLabel: rev.description, to: WORKING_TREE, toLabel: 'Working Tree', folder: folder || undefined });
    return;
  }
  const rev = typeof ref === 'string' ? { ref, description: ref } : await pickRevision(repo, uri, `Compare ${vscode.workspace.asRelativePath(uri)} with...`);
  if (!rev) return;
  await openCompare(await gitSide(repo, uri, rev.ref, rev.description), fileSide(uri));
}

interface TargetItem extends vscode.QuickPickItem {
  run(): Promise<void>;
}

async function compareWith(arg: unknown): Promise<void> {
  const uri = targetUri(arg);
  if (!uri) {
    void vscode.window.showInformationMessage('Open a file first, then compare it.');
    return;
  }
  const repo = await repositoryFor(uri);
  const items: TargetItem[] = [];
  if (repo) {
    items.push(
      { label: '$(git-commit) HEAD', description: 'last commit', run: async () => openCompare(await gitSide(repo, uri, 'HEAD'), fileSide(uri)) },
      { label: '$(diff) Index', description: 'staged version', run: async () => openCompare(await gitSide(repo, uri, ''), fileSide(uri)) },
      { label: '$(history) Revision...', description: 'branch, tag or commit', run: () => compareWithRevision(uri) },
    );
  }
  if (selected && selected.toString() !== uri.toString()) {
    items.push({ label: `$(file) ${vscode.workspace.asRelativePath(selected)}`, description: 'selected for compare', run: () => compareFiles(selected!, uri) });
  }
  items.push({
    label: '$(folder-opened) Another File...',
    run: async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', defaultUri: vscode.Uri.joinPath(uri, '..') });
      if (picked?.[0]) await compareFiles(picked[0], uri);
    },
  });
  if (uri.scheme === 'file' && detectKind(uri.path) === 'text') {
    items.push({
      label: '$(clippy) Clipboard',
      run: async () => {
        await vscode.window.showTextDocument(uri);
        await vscode.commands.executeCommand('workbench.files.action.compareWithClipboard');
      },
    });
  }
  const pick = await vscode.window.showQuickPick(items, { title: `Compare ${vscode.workspace.asRelativePath(uri)} with...` });
  await pick?.run();
}

/** Remembers a file or folder for "Compare with Selected", shown in the status bar until cleared. */
async function setSelection(uri: vscode.Uri | undefined): Promise<void> {
  selected = uri;
  await vscode.commands.executeCommand('setContext', 'comparekit.hasSelection', !!uri);
  if (!selectionItem) return;
  if (!uri) {
    selectionItem.hide();
    return;
  }
  selectionItem.text = `$(diff) ${baseName(uri.path)}`;
  selectionItem.tooltip = `Selected for compare: ${vscode.workspace.asRelativePath(uri)}
Right-click another file or folder and choose Compare Kit → Compare with Selected. Click to clear.`;
  selectionItem.show();
}

async function selectForCompare(arg: unknown): Promise<void> {
  await setSelection(targetUri(arg));
}

async function compareWithSelected(arg: unknown): Promise<void> {
  const uri = targetUri(arg);
  if (uri && selected) await compareFiles(selected, uri);
}

async function compareSelected(arg: unknown, all?: vscode.Uri[]): Promise<void> {
  const uris = all && all.length === 2 ? all : undefined;
  if (!uris) {
    void vscode.window.showInformationMessage('Select exactly two files or two folders.');
    return;
  }
  await compareFiles(uris[0], uris[1]);
  void arg;
}

function findChange(changes: readonly Change[], uri: vscode.Uri): Change | undefined {
  return changes.find((c) => c.uri.toString() === uri.toString() || c.renameUri?.toString() === uri.toString());
}

/** Source Control "Open Changes": the change in its group, in the matching view. */
async function openChanges(...args: unknown[]): Promise<void> {
  const state = args[0] as { resourceUri?: vscode.Uri; resourceGroupType?: number } | undefined;
  const uri = targetUri(state);
  if (!uri) return;
  const repo = (await repositoryFor(uri)) ?? (await noRepository(uri));
  if (!repo) return;
  const staged = findChange(repo.state.indexChanges, uri);
  const unstaged = findChange(repo.state.workingTreeChanges, uri);
  // The git extension's resource group types: 1 = index, 2 = working tree, 3 = untracked.
  const inIndexGroup = state?.resourceGroupType === 1 || (state?.resourceGroupType === undefined && staged && !unstaged);
  const missing = (what: string) => void vscode.window.showInformationMessage(`${vscode.workspace.asRelativePath(uri)} ${what}.`);

  if (inIndexGroup && staged) {
    if (staged.status === Status.INDEX_ADDED) return missing('is new in the index; there is no earlier version to compare with');
    if (staged.status === Status.INDEX_DELETED) return missing('is deleted in the index');
    await openCompare(await gitSide(repo, staged.originalUri, 'HEAD'), await gitSide(repo, uri, ''));
    return;
  }
  if (unstaged?.status === Status.UNTRACKED || unstaged?.status === Status.INTENT_TO_ADD) return missing('is untracked; there is no earlier version to compare with');
  if (unstaged?.status === Status.DELETED) return missing('is deleted in the working tree');
  const left = staged ? await gitSide(repo, uri, '') : await gitSide(repo, unstaged?.originalUri ?? uri, 'HEAD');
  await openCompare(left, fileSide(uri));
}

/** Source Control merge group: VS Code's merge editor for text, ours otherwise. */
async function resolveConflict(...args: unknown[]): Promise<void> {
  const uri = targetUri(args[0]);
  if (!uri) return;
  const repo = (await repositoryFor(uri)) ?? (await noRepository(uri));
  if (!repo) return;
  const change = findChange(repo.state.mergeChanges, uri);
  const status = change?.status ?? Status.BOTH_MODIFIED;
  const has = {
    base: ![Status.BOTH_ADDED, Status.ADDED_BY_US, Status.ADDED_BY_THEM].includes(status),
    ours: ![Status.DELETED_BY_US, Status.ADDED_BY_THEM, Status.BOTH_DELETED].includes(status),
    theirs: ![Status.DELETED_BY_THEM, Status.ADDED_BY_US, Status.BOTH_DELETED].includes(status),
  };
  const side = async (present: boolean, ref: string) => (present ? gitSide(repo, uri, ref, refLabel(ref)) : null);
  const [base, ours, theirs] = await Promise.all([side(has.base, ':1'), side(has.ours, ':2'), side(has.theirs, ':3')]);
  const opened = await openMerge({ base, ours, theirs, output: uri, afterSave: () => repo.add([uri.fsPath]) });
  if (!opened) await vscode.commands.executeCommand('git.openMergeEditor', uri);
}

export async function pickRepository(): Promise<Repository | undefined> {
  const api = await gitApi();
  const repos = api?.repositories ?? [];
  if (repos.length <= 1) {
    if (!repos.length) void vscode.window.showWarningMessage('No git repository is open.');
    return repos[0];
  }
  const active = targetUri(undefined);
  const byActive = active && api!.getRepository(active);
  if (byActive) return byActive;
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: vscode.workspace.asRelativePath(r.rootUri), repo: r })),
    { title: 'Compare branches in which repository?' },
  );
  return pick?.repo;
}

interface BranchArgs {
  from?: string;
  /** A ref, or omitted for the working tree. */
  to?: string;
  mergeBase?: boolean;
}

/** With `args.from`, the pickers are skipped (for keybindings and scripts). */
async function compareBranches(args?: BranchArgs): Promise<void> {
  const repo = await pickRepository();
  if (!repo) return;
  const given = args && typeof args.from === 'string';
  for (const r of given ? [args!.from, args!.to] : []) {
    if (typeof r === 'string' && !isSafeRef(r)) throw new Error(`"${r}" is not a valid git revision.`);
  }
  const from = given ? { ref: args.from!, description: args.from! } : await pickRef(repo, { title: 'Compare Branches (1/2): the base, shown on the left', index: false });
  if (!from) return;
  const to = given
    ? args!.to
      ? { ref: args!.to, description: args!.to }
      : { ref: WORKING_TREE, description: 'Working Tree' }
    : await pickRef(repo, { title: `Compare Branches (2/2): compare ${from.description} with...`, index: false, workingTree: true });
  if (!to) return;
  let mergeBase = false;
  if (to.ref !== WORKING_TREE) {
    const mode = given ? { mergeBase: !!args!.mergeBase } : await vscode.window.showQuickPick(
      [
        { label: `Changes on ${to.description} since it branched from ${from.description}`, description: 'like a pull request', mergeBase: true },
        { label: `All differences between ${from.description} and ${to.description}`, description: 'includes changes made on both', mergeBase: false },
      ],
      { title: 'What to compare' },
    );
    if (!mode) return;
    mergeBase = mode.mergeBase;
  }
  await compareRevisions(repo, from, to, mergeBase);
}

/** Opens the changes between two refs (or a ref and the working tree). */
export async function compareRevisions(repo: Repository, from: Revision, to: Revision, mergeBase: boolean): Promise<void> {
  let left = from.ref;
  if (mergeBase && to.ref !== WORKING_TREE) {
    const base = await repo.getMergeBase(from.ref, to.ref);
    if (!base) {
      void vscode.window.showWarningMessage(`${from.description} and ${to.description} have no common ancestor.`);
      return;
    }
    left = base;
  }
  const fromLabel = left === from.ref ? from.description : `${from.description} (merge base ${left.slice(0, 7)})`;
  await openGitChanges({ repo, from: left, fromLabel, to: to.ref, toLabel: to.description });
}

async function compareFolders(): Promise<void> {
  const pick = async (title: string) => (await vscode.window.showOpenDialog({ title, canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select' }))?.[0];
  const left = await pick('Compare Folders: pick the left folder');
  if (!left) return;
  const right = await pick('Compare Folders: pick the right folder');
  if (right) await compareFiles(left, right);
}

/** Timeline items from the git extension carry the commit (`ref`) and its parent (`previousRef`). */
interface GitTimelineItem {
  ref?: string;
  previousRef?: string;
  label?: string | { label: string };
}

async function timelineCompare(item: GitTimelineItem | undefined, uri: vscode.Uri | undefined, withPrevious: boolean): Promise<void> {
  if (!item?.ref || !uri) return;
  const repo = (await repositoryFor(uri)) ?? (await noRepository(uri));
  if (!repo) return;
  const short = item.ref.slice(0, 7);
  const subject = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
  const at = await gitSide(repo, uri, item.ref, `${short} ${subject}`.trim().slice(0, 60));
  if (withPrevious) {
    const parent = item.previousRef || `${item.ref}^`;
    await openCompare(await gitSide(repo, uri, parent, parent.slice(0, 7)), at);
  } else {
    await openCompare(at, fileSide(uri));
  }
}

async function showAsTable(arg: unknown): Promise<void> {
  const uri = targetUri(arg);
  if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'comparekit.csvViewer');
}

export function registerCommands(context: vscode.ExtensionContext): void {
  selectionItem = vscode.window.createStatusBarItem('comparekit.selection', vscode.StatusBarAlignment.Left, 50);
  selectionItem.name = 'Compare Kit: Selected for Compare';
  selectionItem.command = 'comparekit.clearSelection';
  context.subscriptions.push(selectionItem);
  const reg = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }
      }),
    );
  reg('comparekit.compareWith', compareWith);
  reg('comparekit.compareWithRevision', compareWithRevision);
  reg('comparekit.selectForCompare', selectForCompare);
  reg('comparekit.clearSelection', () => setSelection(undefined));
  reg('comparekit.compareWithSelected', compareWithSelected);
  reg('comparekit.compareSelected', compareSelected);
  reg('comparekit.openChanges', openChanges);
  reg('comparekit.resolveConflict', resolveConflict);
  reg('comparekit.showAsTable', showAsTable);
  reg('comparekit.compareBranches', compareBranches);
  reg('comparekit.compareFolders', compareFolders);
  reg('comparekit.timelineCompareWorking', (item: GitTimelineItem, uri: vscode.Uri) => timelineCompare(item, uri, false));
  reg('comparekit.timelineComparePrevious', (item: GitTimelineItem, uri: vscode.Uri) => timelineCompare(item, uri, true));
}
