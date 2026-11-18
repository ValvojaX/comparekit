// Webview plumbing: one bundled React app, strict content security policy, and
// typed messages. Webviews get data by message only; they load nothing else.

import * as vscode from 'vscode';
import type { HostMessage, InitPayload, WebviewMessage } from './shared/protocol';
import { testState } from './testState';

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    retainContextWhenHidden: true,
  };
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const n = nonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${n}'`,
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
  ].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="root"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}

export type Post = (m: HostMessage) => Thenable<boolean>;

export interface Handlers {
  onSave?(msg: Extract<WebviewMessage, { type: 'save' }>): Promise<void>;
  onCompareWith?(): void;
  onOpenAsText?(): void;
  /** Messages specific to one view (paging, opening entries). */
  onMessage?(msg: WebviewMessage, post: Post): Promise<void> | void;
}

/**
 * Wires a webview: sends `init` once the page says it's ready (and again if it
 * reloads), and routes the page's messages to handlers.
 */
export interface Connection extends vscode.Disposable {
  /** Loads again and re-sends `init` (after the file changed on disk). */
  reload(): Promise<void>;
}

export function connect(webview: vscode.Webview, load: () => Promise<InitPayload>, handlers: Handlers = {}): Connection {
  const post = (m: HostMessage) => webview.postMessage(m);
  const send = async () => {
    let payload: InitPayload;
    try {
      payload = await load();
    } catch (e) {
      payload = { view: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    testState.loaded.push({ payload, handlers });
    void post({ type: 'init', payload });
  };
  const sub = webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
    switch (msg?.type) {
      case 'ready':
        await send();
        break;
      case 'save':
        if (!handlers.onSave) return;
        try {
          await handlers.onSave(msg);
          void post({ type: 'saved', ok: true });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          void vscode.window.showErrorMessage(`Could not save the merge result: ${message}`);
          void post({ type: 'saved', ok: false, message });
        }
        break;
      case 'compareWith':
        handlers.onCompareWith?.();
        break;
      case 'openAsText':
        handlers.onOpenAsText?.();
        break;
      case 'error':
        void vscode.window.showErrorMessage(String(msg.message));
        break;
      default:
        try {
          await handlers.onMessage?.(msg, post);
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }
    }
  });
  return { dispose: () => sub.dispose(), reload: send };
}

export function openPanel(extensionUri: vscode.Uri, title: string, load: () => Promise<InitPayload>, handlers?: Handlers): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('vscodeCompare.panel', title, vscode.ViewColumn.Active, webviewOptions(extensionUri));
  panel.webview.html = webviewHtml(panel.webview, extensionUri, title);
  const sub = connect(panel.webview, load, handlers);
  panel.onDidDispose(() => sub.dispose());
  return panel;
}
