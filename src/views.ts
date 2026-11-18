// The "Compare Revisions" view in Source Control: pick two refs (or a ref and
// the working tree) and open the changes between them; recent commits can be
// shown or used as either end.

import * as vscode from 'vscode';
import { compareRevisions } from './commands';
import { openGitChanges } from './folders';
import { gitApi, type Commit, type Repository } from './git/api';
import { EMPTY_TREE, pickRef, WORKING_TREE, type Revision } from './git/revisions';

interface RevisionState {
  from: Revision;
  to: Revision;
  mergeBase: boolean;
}

class RevItem extends vscode.TreeItem {
  constructor(
    readonly role: 'repo' | 'from' | 'to' | 'mode' | 'compare' | 'commits',
    label: string,
    opts: { icon?: string; description?: string; tooltip?: string; command?: string; collapsible?: boolean; context?: string },
  ) {
    super(label, opts.collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (opts.icon) this.iconPath = new vscode.ThemeIcon(opts.icon);
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    if (opts.command) this.command = { command: opts.command, title: label };
    this.contextValue = opts.context ?? `rev-${role}`;
  }
}

class CommitItem extends vscode.TreeItem {
  constructor(readonly commit: Commit) {
    super(commit.message.split('\n', 1)[0] || commit.hash.slice(0, 7));
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.description = [commit.hash.slice(0, 7), commit.authorName, commit.authorDate?.toLocaleDateString()].filter(Boolean).join(' · ');
    this.tooltip = `${commit.hash}\n${commit.authorName ?? ''}${commit.authorDate ? `, ${commit.authorDate.toLocaleString()}` : ''}\n\n${commit.message}`;
    this.contextValue = 'commit';
    this.command = { command: 'comparekit.rev.showCommit', title: 'Show Changes', arguments: [this] };
  }

  get revision(): Revision {
    return { ref: this.commit.hash, description: `${this.commit.hash.slice(0, 7)} ${this.commit.message.split('\n', 1)[0]}`.slice(0, 60) };
  }
}

type RevNode = RevItem | CommitItem;

export class RevisionsViewProvider implements vscode.TreeDataProvider<RevNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private repo: Repository | undefined;
  private repoCount = 0;
  private watch: vscode.Disposable | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly memento: vscode.Memento) {
    void this.init();
  }

  private async init(): Promise<void> {
    const api = await gitApi();
    if (!api) return;
    const update = () => {
      this.repoCount = api.repositories.length;
      if (!this.repo || !api.repositories.includes(this.repo)) this.useRepo(api.repositories[0]);
      else this.changed.fire();
    };
    api.onDidOpenRepository(update);
    api.onDidCloseRepository(update);
    update();
  }

  private useRepo(repo: Repository | undefined): void {
    this.repo = repo;
    this.watch?.dispose();
    // Commits and HEAD change with every commit, checkout and fetch; refresh at most every second.
    this.watch = repo?.state.onDidChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.changed.fire(), 1000);
    });
    this.changed.fire();
  }

  private key(): string {
    return `revisions:${this.repo?.rootUri.toString() ?? ''}`;
  }

  get state(): RevisionState {
    return this.memento.get<RevisionState>(this.key(), {
      from: { ref: 'HEAD', description: 'HEAD' },
      to: { ref: WORKING_TREE, description: 'Working Tree' },
      mergeBase: true,
    });
  }

  async setState(patch: Partial<RevisionState>): Promise<void> {
    await this.memento.update(this.key(), { ...this.state, ...patch });
    this.changed.fire();
  }

  getTreeItem(node: RevNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: RevNode): Promise<RevNode[]> {
    const repo = this.repo;
    if (!repo) return [];
    if (node instanceof RevItem && node.role === 'commits') {
      const commits = await repo.log({ maxEntries: 50 }).catch(() => []);
      return commits.map((c) => new CommitItem(c));
    }
    if (node) return [];
    const { from, to, mergeBase } = this.state;
    const items: RevNode[] = [];
    if (this.repoCount > 1) {
      items.push(new RevItem('repo', 'Repository', { icon: 'repo', description: vscode.workspace.asRelativePath(repo.rootUri), command: 'comparekit.rev.pickRepo' }));
    }
    items.push(
      new RevItem('from', 'From', { icon: 'git-branch', description: from.description, tooltip: 'Shown on the left. Click to choose a branch, tag or commit.', command: 'comparekit.rev.pickFrom' }),
      new RevItem('to', 'To', { icon: to.ref === WORKING_TREE ? 'edit' : 'git-branch', description: to.description, tooltip: 'Shown on the right. Click to choose a branch, tag, commit or the working tree.', command: 'comparekit.rev.pickTo' }),
    );
    const mode = new RevItem('mode', 'Only changes made on "To"', {
      description: to.ref === WORKING_TREE ? 'not used with the working tree' : 'since it split off "From", like a pull request',
      tooltip: 'Compare "To" with the commit where it split off "From" (the merge base), so changes made on "From" since then are left out.',
    });
    mode.checkboxState = mergeBase ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    items.push(
      mode,
      new RevItem('compare', 'Compare', { icon: 'git-compare', description: `${from.description} ↔ ${to.description}`, command: 'comparekit.rev.compare' }),
      new RevItem('commits', 'Recent Commits', { icon: 'history', collapsible: true, description: repo.state.HEAD?.name }),
    );
    return items;
  }

  async pickRepo(): Promise<void> {
    const api = await gitApi();
    const pick = await vscode.window.showQuickPick(
      (api?.repositories ?? []).map((r) => ({ label: vscode.workspace.asRelativePath(r.rootUri), repo: r })),
      { title: 'Compare revisions in which repository?' },
    );
    if (pick) this.useRepo(pick.repo);
  }

  async pick(end: 'from' | 'to'): Promise<void> {
    if (!this.repo) return;
    const rev = await pickRef(this.repo, {
      title: end === 'from' ? 'Compare Revisions: "From", shown on the left' : 'Compare Revisions: "To", shown on the right',
      index: false,
      workingTree: end === 'to',
    });
    if (rev) await this.setState({ [end]: rev });
  }

  async swap(): Promise<void> {
    const { from, to } = this.state;
    if (from.ref === WORKING_TREE || to.ref === WORKING_TREE) {
      void vscode.window.showInformationMessage('The working tree can only be on the right ("To").');
      return;
    }
    await this.setState({ from: to, to: from });
  }

  async compare(): Promise<void> {
    if (!this.repo) {
      void vscode.window.showWarningMessage('No git repository is open.');
      return;
    }
    const { from, to, mergeBase } = this.state;
    await compareRevisions(this.repo, from, to, mergeBase);
  }

  async showCommit(item: CommitItem): Promise<void> {
    if (!this.repo) return;
    const c = item.commit;
    const parent = c.parents[0] ?? EMPTY_TREE;
    await openGitChanges({
      repo: this.repo,
      from: parent,
      fromLabel: c.parents[0] ? c.parents[0].slice(0, 7) : 'empty',
      to: c.hash,
      toLabel: item.revision.description,
    });
  }

  async compareWithWorkingTree(item: CommitItem): Promise<void> {
    if (!this.repo) return;
    await compareRevisions(this.repo, item.revision, { ref: WORKING_TREE, description: 'Working Tree' }, false);
  }
}

export function registerViews(context: vscode.ExtensionContext): RevisionsViewProvider {
  const revisions = new RevisionsViewProvider(context.workspaceState);
  const tree = vscode.window.createTreeView('comparekit.revisionsView', { treeDataProvider: revisions });
  const reg = (id: string, fn: (...args: never[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await (fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    });
  context.subscriptions.push(
    tree,
    tree.onDidChangeCheckboxState((e) => {
      for (const [item, checked] of e.items) {
        if (item instanceof RevItem && item.role === 'mode') void revisions.setState({ mergeBase: checked === vscode.TreeItemCheckboxState.Checked });
      }
    }),
    reg('comparekit.rev.pickRepo', () => revisions.pickRepo()),
    reg('comparekit.rev.pickFrom', () => revisions.pick('from')),
    reg('comparekit.rev.pickTo', () => revisions.pick('to')),
    reg('comparekit.rev.swap', () => revisions.swap()),
    reg('comparekit.rev.compare', () => revisions.compare()),
    reg('comparekit.rev.showCommit', (item: CommitItem) => revisions.showCommit(item)),
    reg('comparekit.rev.compareWithWorkingTree', (item: CommitItem) => revisions.compareWithWorkingTree(item)),
    reg('comparekit.rev.setFrom', (item: CommitItem) => revisions.setState({ from: item.revision })),
    reg('comparekit.rev.setTo', (item: CommitItem) => revisions.setState({ to: item.revision })),
  );
  return revisions;
}
