// Which view handles a file: by extension, by the comparekit.formatAssociations
// setting, or by content (a NUL byte means binary). Everything else is text.

import * as vscode from 'vscode';

export type ViewKind = 'text' | 'table' | 'excel' | 'picture' | 'archive' | 'binary';

const EXTENSIONS: [ViewKind, string[]][] = [
  ['table', ['csv', 'tsv', 'tab', 'psv']],
  ['excel', ['xlsx', 'xlsm']],
  ['picture', ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif']],
  ['archive', ['zip', 'jar', 'war', 'ear', 'apk', 'vsix', 'nupkg', 'whl']],
];

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function extensionOf(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** Simple glob on the file name or path: `*`, `?` and `**`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function associated(path: string): ViewKind | undefined {
  const map = vscode.workspace.getConfiguration('comparekit').get<Record<string, ViewKind>>('formatAssociations', {});
  for (const [glob, kind] of Object.entries(map)) {
    const re = globToRegExp(glob);
    if (re.test(baseName(path)) || re.test(path)) return kind;
  }
  return undefined;
}

export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8000);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

/** Picks the view for a file from its path and, when the extension says nothing, from its first bytes. */
export function detectKind(path: string, head?: Uint8Array): ViewKind {
  const forced = associated(path);
  if (forced) return forced;
  const ext = extensionOf(path);
  for (const [kind, exts] of EXTENSIONS) if (exts.includes(ext)) return kind;
  return head && looksBinary(head) ? 'binary' : 'text';
}
