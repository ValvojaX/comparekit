// Read-only table viewers for Excel (default) and CSV/TSV (opt-in).

import * as vscode from 'vscode';
import type { InitPayload, TableFormat } from './shared/protocol';
import { fileSide } from './sides';
import { loadTable } from './tables';
import { connect, webviewHtml, webviewOptions } from './webview';

class TableViewer implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly format: TableFormat,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const uri = document.uri;
    panel.webview.options = webviewOptions(this.extensionUri);
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, uri.path);
    const load = async (): Promise<InitPayload> => ({ view: 'table-view', doc: await loadTable(fileSide(uri), this.format) });
    const conn = connect(panel.webview, load, {
      onCompareWith: () => void vscode.commands.executeCommand('vscodeCompare.compareWith', uri),
      onOpenAsText: () => void vscode.commands.executeCommand('vscode.openWith', uri, 'default'),
    });
    const disposables: vscode.Disposable[] = [conn];
    if (uri.scheme === 'file') {
      const folder = vscode.Uri.joinPath(uri, '..');
      const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, name));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void conn.reload(), 300);
      };
      disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));
    }
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }
}

export function registerViewers(context: vscode.ExtensionContext): void {
  const options = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('vscodeCompare.excelViewer', new TableViewer(context.extensionUri, 'excel'), options),
    vscode.window.registerCustomEditorProvider('vscodeCompare.csvViewer', new TableViewer(context.extensionUri, 'csv'), options),
  );
}
