/**
 * A minimal ZIP writer: stored entries (no compression), UTF-8 names.
 *
 * Space export is the one place the application produces an archive, and the
 * archive holds Markdown — text a few kilobytes long per page. A dependency
 * for deflate would buy little and add one more package to keep patched, so
 * this writes the format directly: a local header and the bytes for each file,
 * then the central directory. Every unzip tool reads stored entries.
 *
 * Pure: no filesystem, no framework, so it is unit-tested byte for byte.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. Must not start with `/` or contain `..`. */
  name: string;
  data: Uint8Array;
  modifiedAt?: Date;
}

/** Past this the classic format needs ZIP64, which this writer does not emit. */
export const MAX_ZIP_ENTRIES = 65_535;
export const MAX_ZIP_BYTES = 0xffff_fffe;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** MS-DOS date and time, the only timestamp the base format carries. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function isSafeZipName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  return !name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

const FLAG_UTF8 = 0x0800;
const VERSION = 20;

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new RangeError(`A ZIP archive holds at most ${MAX_ZIP_ENTRIES} entries`);
  }
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!isSafeZipName(entry.name)) {
      throw new RangeError(`Unsafe archive path: ${entry.name}`);
    }
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const stamp = dosDateTime(entry.modifiedAt ?? new Date(0));

    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x0403_4b50, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x0201_4b50, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
    if (offset > MAX_ZIP_BYTES) throw new RangeError('The archive is too large');
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x0605_4b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
