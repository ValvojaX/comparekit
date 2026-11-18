// ZIP archives compared and merged entry by entry. Entry status comes from the
// central directory (CRC and size), so listing needs no decompression.

import JSZip from 'jszip';
import { checkZipLimits, listZip, type ZipEntryInfo, type ZipLimits } from './zipinfo';

export type EntryStatus = 'same' | 'changed' | 'left-only' | 'right-only';

export interface ArchiveDiffEntry {
  name: string;
  status: EntryStatus;
  leftSize: number | null;
  rightSize: number | null;
}

function files(entries: ZipEntryInfo[]): Map<string, ZipEntryInfo> {
  const m = new Map<string, ZipEntryInfo>();
  for (const e of entries) if (!e.isDirectory) m.set(e.name, e);
  return m;
}

const sameEntry = (a: ZipEntryInfo, b: ZipEntryInfo) => a.crc32 === b.crc32 && a.uncompressedSize === b.uncompressedSize;

export function diffArchives(left: Uint8Array, right: Uint8Array, limits?: ZipLimits): ArchiveDiffEntry[] {
  const l = files(listZip(left));
  const r = files(listZip(right));
  checkZipLimits([...l.values()], limits);
  checkZipLimits([...r.values()], limits);
  const names = [...new Set([...l.keys(), ...r.keys()])].sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const a = l.get(name), b = r.get(name);
    const status: EntryStatus = !a ? 'right-only' : !b ? 'left-only' : sameEntry(a, b) ? 'same' : 'changed';
    return { name, status, leftSize: a?.uncompressedSize ?? null, rightSize: b?.uncompressedSize ?? null };
  });
}

export type ArchiveSide = 'base' | 'ours' | 'theirs';
/** What the merged archive holds for an entry: one side's version, or nothing. */
export type EntryChoice = ArchiveSide | 'delete';

export interface ArchiveMergeEntry {
  name: string;
  sizes: Record<ArchiveSide, number | null>;
  /** Decided without asking; null means a conflict to resolve. */
  auto: EntryChoice | null;
  /** Short reason: "changed on theirs", "deleted on ours, changed on theirs". */
  note: string;
}

export function mergeArchives(base: Uint8Array | null, ours: Uint8Array, theirs: Uint8Array, limits?: ZipLimits): ArchiveMergeEntry[] {
  const b = base ? files(listZip(base)) : new Map<string, ZipEntryInfo>();
  const o = files(listZip(ours));
  const t = files(listZip(theirs));
  for (const m of [b, o, t]) checkZipLimits([...m.values()], limits);
  const names = [...new Set([...o.keys(), ...t.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  const out: ArchiveMergeEntry[] = [];
  for (const name of names) {
    const eb = b.get(name), eo = o.get(name), et = t.get(name);
    const sizes = { base: eb?.uncompressedSize ?? null, ours: eo?.uncompressedSize ?? null, theirs: et?.uncompressedSize ?? null };
    const eq = (x?: ZipEntryInfo, y?: ZipEntryInfo) => (!x && !y) || (!!x && !!y && sameEntry(x, y));
    let auto: EntryChoice | null;
    let note: string;
    if (eq(eo, et)) {
      if (!eo) continue; // deleted on both sides
      auto = 'ours';
      note = eq(eo, eb) ? 'unchanged' : eb ? 'same change on both sides' : 'added on both sides';
    } else if (eq(eo, eb)) {
      auto = et ? 'theirs' : 'delete';
      note = !et ? 'deleted on theirs' : eb ? 'changed on theirs' : 'added on theirs';
    } else if (eq(et, eb)) {
      auto = eo ? 'ours' : 'delete';
      note = !eo ? 'deleted on ours' : eb ? 'changed on ours' : 'added on ours';
    } else {
      auto = null;
      note = !eo ? 'deleted on ours, changed on theirs' : !et ? 'changed on ours, deleted on theirs' : eb ? 'changed on both sides' : 'added on both sides, different';
    }
    out.push({ name, sizes, auto, note });
  }
  return out;
}

async function load(bytes: Uint8Array, limits?: ZipLimits): Promise<JSZip> {
  checkZipLimits(listZip(bytes), limits);
  return JSZip.loadAsync(bytes);
}

/** Reads one entry's bytes. */
export async function readEntry(archive: Uint8Array, name: string, limits?: ZipLimits): Promise<Uint8Array> {
  const zip = await load(archive, limits);
  const f = zip.file(name);
  if (!f) throw new Error(`${name} is not in the archive.`);
  return f.async('uint8array');
}

/** Builds the merged archive. Entries keep their order from ours, then theirs. */
export async function writeArchive(sources: Partial<Record<ArchiveSide, Uint8Array>>, choices: Record<string, EntryChoice>, limits?: ZipLimits): Promise<Uint8Array> {
  const zips: Partial<Record<ArchiveSide, JSZip>> = {};
  for (const side of ['base', 'ours', 'theirs'] as ArchiveSide[]) {
    const bytes = sources[side];
    if (bytes) zips[side] = await load(bytes, limits);
  }
  const order: string[] = [];
  for (const side of ['ours', 'theirs', 'base'] as ArchiveSide[]) {
    zips[side]?.forEach((path, f) => {
      if (!f.dir && !order.includes(path)) order.push(path);
    });
  }
  const out = new JSZip();
  for (const name of order) {
    const choice = choices[name] ?? 'ours';
    if (choice === 'delete') continue;
    const f = zips[choice]?.file(name);
    if (!f) continue;
    out.file(name, await f.async('uint8array'), {
      date: f.date,
      comment: f.comment,
      unixPermissions: f.unixPermissions ?? undefined,
      dosPermissions: f.dosPermissions ?? undefined,
      compression: 'DEFLATE',
    });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' });
}
