// Byte-level comparison by position, and small helpers shared by binary views.

export interface ByteRange {
  /** Offset of the first differing byte. */
  start: number;
  /** Offset after the last differing byte. */
  end: number;
}

export interface ByteDiff {
  ranges: ByteRange[];
  /** Exact count of differing positions (bytes past the shorter file count too). */
  differentBytes: number;
  /** More ranges existed than the limit; nearby ones were merged. */
  merged: boolean;
}

/**
 * Compares two buffers position by position. Differences closer than `gap`
 * bytes join into one range; past `maxRanges`, the gap doubles until it fits.
 */
export function diffBytes(a: Uint8Array, b: Uint8Array, maxRanges = 50_000, gap = 0): ByteDiff {
  const n = Math.min(a.length, b.length);
  let differentBytes = Math.abs(a.length - b.length);
  const raw: ByteRange[] = [];
  let open: ByteRange | null = null;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      differentBytes++;
      if (open && i - open.end <= gap) open.end = i + 1;
      else {
        open = { start: i, end: i + 1 };
        raw.push(open);
      }
    }
  }
  if (a.length !== b.length) {
    const start = n;
    if (open && start - open.end <= gap) open.end = Math.max(a.length, b.length);
    else raw.push({ start, end: Math.max(a.length, b.length) });
  }
  let ranges = raw;
  let g = Math.max(1, gap);
  while (ranges.length > maxRanges) {
    g *= 2;
    const next: ByteRange[] = [];
    for (const r of ranges) {
      const last = next.at(-1);
      if (last && r.start - last.end <= g) last.end = r.end;
      else next.push({ ...r });
    }
    ranges = next;
  }
  return { ranges, differentBytes, merged: ranges !== raw };
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

export function imageMime(ext: string): string {
  return IMAGE_MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}
