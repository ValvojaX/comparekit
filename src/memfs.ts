// A read-only in-memory file system for content that has no file of its own,
// such as entries inside a ZIP archive, so VS Code's editors can open them.

import * as vscode from 'vscode';

export const MEM_SCHEME = 'vscode-compare-mem';

const files = new Map<string, Uint8Array>();
let counter = 0;
const MAX_FILES = 200;

class MemFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }
  stat(uri: vscode.Uri): vscode.FileStat {
    const data = files.get(uri.path);
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: data.byteLength, permissions: vscode.FilePermission.Readonly };
  }
  readFile(uri: vscode.Uri): Uint8Array {
    const data = files.get(uri.path);
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return data;
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

/** Stores bytes and returns a URI that opens them. Old entries are evicted. */
export function memUri(name: string, data: Uint8Array): vscode.Uri {
  const path = `/${++counter}/${name.replace(/^\/+/, '')}`;
  files.set(path, data);
  while (files.size > MAX_FILES) files.delete(files.keys().next().value!);
  return vscode.Uri.from({ scheme: MEM_SCHEME, path });
}

export function registerMemFs(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(MEM_SCHEME, new MemFs(), { isReadonly: true, isCaseSensitive: true }));
}
