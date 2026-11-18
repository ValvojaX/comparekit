// The subset of the built-in git extension's API (vscode.git, API version 1)
// this extension uses. See extensions/git/src/api/git.d.ts in the VS Code repo.

import * as vscode from 'vscode';

export enum RefType {
  Head = 0,
  RemoteHead = 1,
  Tag = 2,
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface Branch extends Ref {
  readonly upstream?: { name: string; remote: string };
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
}

export enum Status {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18,
}

export interface Change {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: Status;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly refs: Ref[];
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly onDidChange: vscode.Event<void>;
}

export interface LogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
  getRefs?(query: { pattern?: string; count?: number; sort?: 'alphabetically' | 'committerdate' }): Promise<Ref[]>;
  log(options?: LogOptions): Promise<Commit[]>;
  /** `git show <ref>:<path>` as bytes. `ref` '' reads the index, ':1'..':3' merge stages. */
  buffer(ref: string, path: string): Promise<Buffer>;
  /** Changes between two refs, as `git diff ref1...ref2`: from their merge base to ref2. */
  diffBetween(ref1: string, ref2: string): Promise<Change[]>;
  /** `git diff --raw <range>`; newer VS Code versions only. */
  diffBetweenWithStats2?(range: string, path?: string): Promise<Change[]>;
  getCommit(ref: string): Promise<Commit>;
  /** Changes between a ref and the working tree (tracked files). */
  diffWith(ref: string): Promise<Change[]>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  add(paths: string[]): Promise<void>;
}

export interface API {
  readonly repositories: Repository[];
  getRepository(uri: vscode.Uri): Repository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}

let cached: API | undefined;

export async function gitApi(): Promise<API | undefined> {
  if (cached) return cached;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) return undefined;
  cached = exports.getAPI(1);
  return cached;
}
