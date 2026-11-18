// Reads a ZIP central directory without decompressing anything, so sizes can be
// checked before a library expands the archive (zip-bomb guard), and archives
// can be listed cheaply.

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  isDirectory: boolean;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  /** Uncompressed / compressed, per entry. */
  maxRatio: number;
}

export const defaultZipLimits: ZipLimits = { maxEntries: 20_000, maxTotalUncompressed: 1024 * 1024 * 1024, maxRatio: 1000 };

export class ZipLimitError extends Error {}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

/** Lists entries from the central directory. Throws if it isn't a readable ZIP. */
export function listZip(bytes: Uint8Array): ZipEntryInfo[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory).');
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    // ZIP64 end of central directory locator sits right before the EOCD.
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('Unsupported ZIP64 archive.');
    const z64 = Number(dv.getBigUint64(loc + 8, true));
    if (dv.getUint32(z64, true) !== 0x06064b50) throw new Error('Unsupported ZIP64 archive.');
    count = Number(dv.getBigUint64(z64 + 32, true));
    cdOffset = Number(dv.getBigUint64(z64 + 48, true));
  }
  const entries: ZipEntryInfo[] = [];
  const decoder = new TextDecoder('utf-8');
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const crc32 = dv.getUint32(p + 16, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field (0x0001) carries the real sizes when the 32-bit ones are 0xffffffff.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = dv.getUint16(e, true);
      const size = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = Number(dv.getBigUint64(q, true));
          q += 8;
        }
        if (compressedSize === 0xffffffff) compressedSize = Number(dv.getBigUint64(q, true));
      }
      e += 4 + size;
    }
    entries.push({ name, compressedSize, uncompressedSize, crc32, isDirectory: name.endsWith('/') });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** Throws ZipLimitError when the archive would expand past the limits. */
export function checkZipLimits(entries: ZipEntryInfo[], limits: ZipLimits = defaultZipLimits): void {
  if (entries.length > limits.maxEntries) throw new ZipLimitError(`Archive has ${entries.length} entries (limit ${limits.maxEntries}).`);
  let total = 0;
  for (const e of entries) {
    total += e.uncompressedSize;
    if (e.uncompressedSize > 1024 * 1024 && e.uncompressedSize / Math.max(1, e.compressedSize) > limits.maxRatio) {
      throw new ZipLimitError(`Entry ${e.name} expands ${Math.round(e.uncompressedSize / Math.max(1, e.compressedSize))}x; refusing to open it.`);
    }
  }
  if (total > limits.maxTotalUncompressed) {
    throw new ZipLimitError(`Archive expands to ${Math.round(total / 1048576)} MB (limit ${Math.round(limits.maxTotalUncompressed / 1048576)} MB).`);
  }
}
