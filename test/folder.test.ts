import { describe, expect, it } from 'vitest';
import { compareListings, comparePaths, globMatcher } from '../src/core/folder';

describe('folders', () => {
  it('pairs files by path and flags size differences', () => {
    const rows = compareListings(
      [
        { path: 'a.txt', size: 1 },
        { path: 'src/x.ts', size: 5 },
        { path: 'gone.md', size: 2 },
      ],
      [
        { path: 'a.txt', size: 1 },
        { path: 'src/x.ts', size: 6 },
        { path: 'new.md', size: 3 },
      ],
    );
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      ['src/x.ts', 'different'],
      ['a.txt', 'unknown'],
      ['gone.md', 'left-only'],
      ['new.md', 'right-only'],
    ]);
  });

  it('sorts folders before files', () => {
    expect(['b.txt', 'a/z.txt', 'a/b/c.txt', 'A.txt'].sort(comparePaths)).toEqual(['a/b/c.txt', 'a/z.txt', 'A.txt', 'b.txt']);
  });

  it('matches exclude globs like files.exclude', () => {
    const m = globMatcher(['**/node_modules', '**/.git', '*.log', 'build/**', '**/*.{tmp,bak}']);
    expect(m('node_modules')).toBe(true);
    expect(m('pkg/node_modules')).toBe(true);
    expect(m('.git')).toBe(true);
    expect(m('logs/app.log')).toBe(true);
    expect(m('build/out/x.js')).toBe(true);
    expect(m('src/a.bak')).toBe(true);
    expect(m('src/app.ts')).toBe(false);
    expect(m('buildings/x')).toBe(false);
  });
});
