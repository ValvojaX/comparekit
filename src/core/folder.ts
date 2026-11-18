// Folder comparison over file listings. Paths are relative and use '/'.

export interface FileInfo {
  path: string;
  size: number;
}

/**
 * `unknown`: same size, content not checked yet. `renamed`: from git, with
 * `oldPath` set. `changed` and `different` mean the same; git says `changed`.
 */
export type FolderStatus = 'same' | 'different' | 'unknown' | 'left-only' | 'right-only' | 'renamed';

export interface FolderRow {
  path: string;
  status: FolderStatus;
  leftSize: number | null;
  rightSize: number | null;
  /** For renames: the path on the left side. */
  oldPath?: string;
}

export function compareListings(left: FileInfo[], right: FileInfo[]): FolderRow[] {
  const r = new Map(right.map((f) => [f.path, f]));
  const rows: FolderRow[] = [];
  for (const f of left) {
    const g = r.get(f.path);
    if (!g) rows.push({ path: f.path, status: 'left-only', leftSize: f.size, rightSize: null });
    else {
      rows.push({ path: f.path, status: f.size === g.size ? 'unknown' : 'different', leftSize: f.size, rightSize: g.size });
      r.delete(f.path);
    }
  }
  for (const g of r.values()) rows.push({ path: g.path, status: 'right-only', leftSize: null, rightSize: g.size });
  return rows.sort((a, b) => comparePaths(a.path, b.path));
}

/** Folder-first ordering: a/b/c sorts before a/z because 'b' is a folder. */
export function comparePaths(a: string, b: string): number {
  const pa = a.split('/'), pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aDir = i < pa.length - 1, bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return pa[i].localeCompare(pb[i], undefined, { sensitivity: 'base', numeric: true }) || (pa[i] < pb[i] ? -1 : 1);
  }
  return pa.length - pb.length;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A glob as used in VS Code settings (`**`, `*`, `?`, `{a,b}`), matched against a relative path. */
export function globMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map((g) => {
    let re = '';
    let depth = 0;
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === '*') {
        if (g[i + 1] === '*') {
          i++;
          if (g[i + 1] === '/') {
            i++;
            re += '(?:.*/)?';
          } else re += '.*';
        } else re += '[^/]*';
      } else if (ch === '?') re += '[^/]';
      else if (ch === '{') {
        depth++;
        re += '(?:';
      } else if (ch === '}' && depth > 0) {
        depth--;
        re += ')';
      } else if (ch === ',' && depth > 0) re += '|';
      else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
  });
  // A pattern without a slash also matches the name at any depth, as in files.exclude.
  return (path) => res.some((re) => re.test(path) || re.test(path.slice(path.lastIndexOf('/') + 1)));
}
