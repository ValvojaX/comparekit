// Integration checks, run inside VS Code by runTest.ts.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { InitPayload } from '../../src/shared/protocol';
import type { TestState } from '../../src/testState';

const repo = process.env.IT_REPO!;
const uri = (name: string) => vscode.Uri.file(join(repo, name));

async function waitFor<T>(what: string, fn: () => T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function nextPayload(state: TestState, view: InitPayload['view'], action: () => Thenable<unknown>) {
  const before = state.loaded.length;
  await action();
  return waitFor(`a ${view} webview`, () => state.loaded.slice(before).find((l) => l.payload.view === view || l.payload.view === 'error'));
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'vscode-compare')!;
  const api = (await ext.activate()) as { testState: TestState };
  const state = api.testState;
  const git = vscode.extensions.getExtension('vscode.git')!;
  await git.activate();
  // Wait for the git extension to discover the repository and its merge state.
  await waitFor('the git repository', () => {
    const r = git.exports.getAPI(1).repositories[0];
    return r && r.state.mergeChanges.length >= 4 ? r : undefined;
  });

  const results: string[] = [];
  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push(`ok   ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  };

  await test('CSV merge conflict opens the table merge with three sides', async () => {
    const l = await nextPayload(state, 'table-merge', () => vscode.commands.executeCommand('vscodeCompare.resolveConflict', uri('data.csv')));
    assert.equal(l.payload.view, 'table-merge', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'table-merge') return;
    assert.deepEqual(l.payload.base!.sheets[0].rows[1], ['1', 'apple', '5']);
    assert.deepEqual(l.payload.ours!.sheets[0].rows[1], ['1', 'apple', '6']);
    assert.deepEqual(l.payload.theirs!.sheets[0].rows[1], ['1', 'apple', '7']);
    // Save a resolved result and check what lands on disk.
    await l.handlers.onSave!({ type: 'save', result: { format: 'csv', rows: [['id', 'name', 'qty'], ['1', 'apple', '7'], ['2', 'Pear', '3'], ['3', 'plum', '2']] } });
    assert.equal(await readFile(join(repo, 'data.csv'), 'utf8'), 'id,name,qty\n1,apple,7\n2,Pear,3\n3,plum,2\n');
  });

  await test('Excel merge conflict opens the table merge and writes a workbook', async () => {
    const l = await nextPayload(state, 'table-merge', () => vscode.commands.executeCommand('vscodeCompare.resolveConflict', uri('book.xlsx')));
    assert.equal(l.payload.view, 'table-merge', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'table-merge') return;
    assert.equal(l.payload.format, 'excel');
    assert.deepEqual(l.payload.theirs!.sheets[0].rows, [['id', 'qty'], ['1', '5'], ['2', '4'], ['3', '9']]);
    await l.handlers.onSave!({
      type: 'save',
      result: {
        format: 'excel',
        sheets: [
          {
            name: 'Data',
            action: 'merge',
            hasHeader: true,
            table: {
              rows: [['id', 'qty'], ['1', '6'], ['2', '4'], ['3', '9']],
              refs: [
                [null, null],
                [{ side: 'ours', row: 0, col: 0 }, { side: 'ours', row: 0, col: 1 }],
                [{ side: 'theirs', row: 1, col: 0 }, { side: 'theirs', row: 1, col: 1 }],
                [{ side: 'theirs', row: 2, col: 0 }, { side: 'theirs', row: 2, col: 1 }],
              ],
            },
          },
        ],
      },
    });
    const view = await nextPayload(state, 'table-view', () => vscode.commands.executeCommand('vscode.openWith', uri('book.xlsx'), 'vscodeCompare.excelViewer'));
    assert.equal(view.payload.view, 'table-view');
    if (view.payload.view === 'table-view') assert.deepEqual(view.payload.doc.sheets[0].rows, [['id', 'qty'], ['1', '6'], ['2', '4'], ['3', '9']]);
  });

  await test('Compare with revision reads a binary file from HEAD', async () => {
    const side = await nextPayload(state, 'table-diff', () => vscode.commands.executeCommand('vscodeCompare.openChanges', { resourceUri: uri('book.xlsx'), resourceGroupType: 2 }));
    assert.equal(side.payload.view, 'table-diff', JSON.stringify(side.payload).slice(0, 300));
  });

  await test('Text changes open the native diff editor', async () => {
    await vscode.commands.executeCommand('vscodeCompare.openChanges', { resourceUri: uri('notes.txt'), resourceGroupType: 2 });
    const tab = await waitFor('a diff tab', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t : undefined;
    });
    assert.match(tab.label, /notes\.txt/);
  });

  await test('CSV opens in the table viewer on request', async () => {
    const l = await nextPayload(state, 'table-view', () => vscode.commands.executeCommand('vscodeCompare.showAsTable', uri('data.csv')));
    assert.equal(l.payload.view, 'table-view');
  });

  await test('ZIP merge conflict merges entry by entry', async () => {
    const l = await nextPayload(state, 'archive-merge', () => vscode.commands.executeCommand('vscodeCompare.resolveConflict', uri('site.zip')));
    assert.equal(l.payload.view, 'archive-merge', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'archive-merge') return;
    const auto = Object.fromEntries(l.payload.entries.map((e) => [e.name, e.auto]));
    assert.deepEqual(auto, { 'a.txt': 'ours', 'b.txt': null, 'c.txt': 'theirs' });
    await l.handlers.onSave!({ type: 'save', result: { format: 'archive', entries: { 'a.txt': 'ours', 'b.txt': 'theirs', 'c.txt': 'theirs' } } });
    const JSZip = (await import('jszip')).default;
    const z = await JSZip.loadAsync(await readFile(join(repo, 'site.zip')));
    assert.deepEqual(Object.keys(z.files).sort(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(await z.file('b.txt')!.async('string'), 'theirs');
  });

  await test('Image merge conflict offers a whole-file pick', async () => {
    const l = await nextPayload(state, 'whole-merge', () => vscode.commands.executeCommand('vscodeCompare.resolveConflict', uri('logo.png')));
    assert.equal(l.payload.view, 'whole-merge', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'whole-merge') return;
    assert.equal(l.payload.kind, 'picture');
    assert.ok(l.payload.base?.image && l.payload.ours?.image && l.payload.theirs?.image);
    await l.handlers.onSave!({ type: 'save', result: { format: 'whole', take: 'theirs' } });
    assert.match(await readFile(join(repo, 'logo.png'), 'latin1'), /theirs/);
  });

  await test('Archive entries open in a compare view', async () => {
    const l = await nextPayload(state, 'archive-diff', () =>
      vscode.commands.executeCommand('vscodeCompare.openChanges', { resourceUri: uri('site.zip'), resourceGroupType: 2 }),
    );
    assert.equal(l.payload.view, 'archive-diff', JSON.stringify(l.payload).slice(0, 300));
    await l.handlers.onMessage!({ type: 'openEntry', name: 'b.txt' }, async () => true);
    const tab = await waitFor('an entry diff tab', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t : undefined;
    });
    assert.match(tab.label, /b\.txt/);
  });

  await test('Folder compare lists differences and checks same-size contents', async () => {
    const l = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.compareSelected', uri('dirA'), [uri('dirA'), uri('dirB')]));
    assert.equal(l.payload.view, 'folder-diff', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'folder-diff') return;
    const status = Object.fromEntries(l.payload.rows.map((r) => [r.path, r.status]));
    assert.deepEqual(status, { 'sub/diff.txt': 'unknown', 'new.txt': 'right-only', 'only.txt': 'left-only', 'same.txt': 'unknown' });
    const updates: Record<string, string> = {};
    let done = false;
    await l.handlers.onMessage!({ type: 'folderReady' }, async (m) => {
      if (m.type === 'folderRows') {
        for (const r of m.rows) updates[r.path] = r.status;
        if (m.done) done = true;
      }
      return true;
    });
    await waitFor('content checks', () => (done ? true : undefined));
    assert.deepEqual(updates, { 'sub/diff.txt': 'different', 'same.txt': 'same' });
  });

  await test('Compare Branches lists changes since the merge base', async () => {
    const l = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.compareBranches', { from: 'main', to: 'theirs', mergeBase: true }));
    assert.equal(l.payload.view, 'folder-diff', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'folder-diff') return;
    assert.deepEqual(l.payload.rows.map((r) => r.path).sort(), ['book.xlsx', 'data.csv', 'logo.png', 'site.zip']);
    await l.handlers.onMessage!({ type: 'openPath', path: 'data.csv' }, async () => true);
    const diff = await waitFor('the data.csv table diff', () => state.loaded.find((x) => x.payload.view === 'table-diff' && x.payload.right.label.includes('theirs')));
    assert.ok(diff);
  });

  await test('A folder compares with a revision', async () => {
    const l = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.compareWithRevision', uri('dirA'), 'HEAD'));
    assert.equal(l.payload.view, 'folder-diff', JSON.stringify(l.payload).slice(0, 300));
  });

  await test('Compare Branches without the merge base lists changes made on both sides', async () => {
    const l = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.compareBranches', { from: 'main', to: 'theirs', mergeBase: false }));
    assert.equal(l.payload.view, 'folder-diff', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view !== 'folder-diff') return;
    const status = Object.fromEntries(l.payload.rows.map((r) => [r.path, r.status]));
    assert.equal(status['main-only.txt'], 'left-only');
    assert.equal(status['data.csv'], 'different');
  });

  await test('Refs that look like options are refused', async () => {
    const before = state.loaded.length;
    await vscode.commands.executeCommand('vscodeCompare.compareBranches', { from: '--output=x', to: 'HEAD' });
    assert.equal(state.loaded.length, before);
  });

  await test('Select for Compare, then Compare with Selected', async () => {
    await vscode.commands.executeCommand('vscodeCompare.selectForCompare', uri('dirA'));
    const l = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.compareWithSelected', uri('dirB')));
    assert.equal(l.payload.view, 'folder-diff', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view === 'folder-diff') assert.equal(l.payload.left.label, 'dirA');
    await vscode.commands.executeCommand('vscodeCompare.clearSelection');
    const before = state.loaded.length;
    await vscode.commands.executeCommand('vscodeCompare.compareWithSelected', uri('dirB'));
    assert.equal(state.loaded.length, before, 'nothing is compared once the selection is cleared');
  });

  const revisions = state.revisions!;
  await test('Compare Revisions view compares two refs and shows a commit', async () => {
    await revisions.setState({ from: { ref: 'HEAD~1', description: 'HEAD~1' }, to: { ref: 'HEAD', description: 'HEAD' }, mergeBase: false });
    const l = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.rev.compare'));
    assert.equal(l.payload.view, 'folder-diff', JSON.stringify(l.payload).slice(0, 300));
    if (l.payload.view === 'folder-diff') assert.ok(l.payload.rows.some((r) => r.path === 'main-only.txt' && r.status === 'right-only'));
    const children = await revisions.getChildren();
    const commits = children.find((c: object) => 'role' in c && c.role === 'commits')!;
    const [first] = await revisions.getChildren(commits);
    const c = await nextPayload(state, 'folder-diff', () => vscode.commands.executeCommand('vscodeCompare.rev.showCommit', first));
    if (c.payload.view === 'folder-diff') assert.ok(c.payload.rows.some((r) => r.path === 'main-only.txt'));
  });

  console.log(results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error('Integration tests failed');
}
