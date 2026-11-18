// A side of a comparison: a workspace file, or a file at a git revision.
// Everything is read through VS Code's file system API or the git extension,
// so it works in local, WSL, SSH and container workspaces alike.

import * as vscode from 'vscode';
import { gitApi, type Repository } from './git/api';
import { baseName } from './formats';

export interface Side {
  /** The file this side is about (for git sides: the working tree path). */
  uri: vscode.Uri;
  /** A URI VS Code's text diff editor can open. */
  textUri: vscode.Uri;
  label: string;
  /** Which version this is: 'Working Copy', 'HEAD', a short hash. */
  version: string;
  detail: string;
  readonly: boolean;
  read(): Promise<Uint8Array>;
}

export class TooLargeError extends Error {}

export function maxBytes(): number {
  return vscode.workspace.getConfiguration('vscodeCompare').get<number>('maxFileSizeMB', 50) * 1024 * 1024;
}

function checkSize(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.byteLength > maxBytes()) {
    throw new TooLargeError(`${label} is ${Math.round(bytes.byteLength / 1048576)} MB, over the vscodeCompare.maxFileSizeMB limit.`);
  }
  return bytes;
}

export function fileSide(uri: vscode.Uri, label?: string): Side {
  const name = label ?? baseName(uri.path);
  return {
    uri,
    textUri: uri,
    label: name,
    version: 'Working Copy',
    detail: uri.scheme === 'file' ? uri.fsPath : uri.toString(true),
    readonly: uri.scheme !== 'file' && uri.scheme !== 'vscode-remote' && uri.scheme !== 'vscode-userdata',
    async read() {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxBytes()) throw new TooLargeError(`${name} is ${Math.round(stat.size / 1048576)} MB, over the vscodeCompare.maxFileSizeMB limit.`);
      return vscode.workspace.fs.readFile(uri);
    },
  };
}

/** Labels for git refs: '' is the index, ':1'..':3' are merge stages. */
export function refLabel(ref: string): string {
  switch (ref) {
    case '':
      return 'Index';
    case ':1':
      return 'Base';
    case ':2':
      return 'Ours';
    case ':3':
      return 'Theirs';
    default:
      return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
  }
}

export async function gitSide(repo: Repository, uri: vscode.Uri, ref: string, description?: string): Promise<Side> {
  const api = await gitApi();
  const label = `${baseName(uri.path)} (${description ?? refLabel(ref)})`;
  return {
    uri,
    textUri: api ? api.toGitUri(uri, ref) : uri,
    label,
    version: description ?? refLabel(ref),
    detail: `${vscode.workspace.asRelativePath(uri)} at ${description ?? refLabel(ref)}`,
    readonly: true,
    async read() {
      return checkSize(new Uint8Array(await repo.buffer(ref, uri.fsPath)), label);
    },
  };
}

export async function repositoryFor(uri: vscode.Uri): Promise<Repository | undefined> {
  const api = await gitApi();
  return api?.getRepository(uri) ?? undefined;
}

/** Reads the first bytes, for content sniffing. */
export async function readHead(side: Side): Promise<Uint8Array | undefined> {
  try {
    const bytes = await side.read();
    return bytes.subarray(0, 8000);
  } catch {
    return undefined;
  }
}
