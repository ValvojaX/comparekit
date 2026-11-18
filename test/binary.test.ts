import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { diffArchives, mergeArchives, readEntry, writeArchive } from '../src/core/archive';
import { diffBytes, fromBase64, toBase64 } from '../src/core/bytes';

describe('diffBytes', () => {
  it('finds ranges and counts bytes, including the longer tail', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const b = new Uint8Array([1, 9, 9, 4, 5, 6, 7, 8]);
    const d = diffBytes(a, b);
    expect(d.ranges).toEqual([{ start: 1, end: 3 }, { start: 6, end: 8 }]);
    expect(d.differentBytes).toBe(4);
  });
  it('merges ranges past the limit but keeps the exact count', () => {
    const a = new Uint8Array(1000);
    const b = a.slice();
    for (let i = 0; i < 1000; i += 10) b[i] = 1;
    const d = diffBytes(a, b, 10);
    expect(d.ranges.length).toBeLessThanOrEqual(10);
    expect(d.merged).toBe(true);
    expect(d.differentBytes).toBe(100);
  });
  it('round-trips base64', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('archives', () => {
  it('diffs entries by CRC and size', async () => {
    const d = diffArchives(await zip({ 'a.txt': 'x', 'b.txt': 'y', 'c.txt': 'z' }), await zip({ 'a.txt': 'x', 'b.txt': 'Y', 'd.txt': 'w' }));
    expect(d.map((e) => [e.name, e.status])).toEqual([
      ['a.txt', 'same'],
      ['b.txt', 'changed'],
      ['c.txt', 'left-only'],
      ['d.txt', 'right-only'],
    ]);
  });

  it('merges entries three ways and writes the result', async () => {
    const base = await zip({ 'keep.txt': '1', 'ours.txt': '1', 'theirs.txt': '1', 'both.txt': '1', 'gone.txt': '1' });
    const ours = await zip({ 'keep.txt': '1', 'ours.txt': '2', 'theirs.txt': '1', 'both.txt': 'o', 'new-ours.txt': 'n' });
    const theirs = await zip({ 'keep.txt': '1', 'ours.txt': '1', 'theirs.txt': '2', 'both.txt': 't', 'gone.txt': '1' });
    const m = mergeArchives(base, ours, theirs);
    const by = Object.fromEntries(m.map((e) => [e.name, e.auto]));
    expect(by).toEqual({ 'both.txt': null, 'gone.txt': 'delete', 'keep.txt': 'ours', 'new-ours.txt': 'ours', 'ours.txt': 'ours', 'theirs.txt': 'theirs' });
    const choices = Object.fromEntries(m.map((e) => [e.name, e.auto ?? 'theirs']));
    const out = await writeArchive({ base, ours, theirs }, choices);
    const read = async (n: string) => new TextDecoder().decode(await readEntry(out, n));
    expect(await read('both.txt')).toBe('t');
    expect(await read('theirs.txt')).toBe('2');
    expect(await read('ours.txt')).toBe('2');
    await expect(readEntry(out, 'gone.txt')).rejects.toThrow();
  });
});
