import { crc32, isSafeZipName, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from './zip';

/**
 * A ZIP written as it is read: for an archive whose entries are too large to
 * hold, such as a space exported with its files.
 *
 * Stored entries, UTF-8 names, like `createZip`. An entry whose bytes are
 * already in hand is written with its checksum in its header; an entry that is
 * streamed carries flag bit 3 and a data descriptor after its bytes, because
 * its checksum is known only once it has been read. The central directory at
 * the end has every size and checksum, which is what an unzip tool reads.
 *
 * The classic format stops at 4 GiB and 65 535 entries. The writer does not
 * cross either: `fits` says whether an entry of a known size still does, and a
 * caller leaves out — and says it left out — what does not.
 */

export type StreamedZipEntry =
  | { name: string; modifiedAt?: Date; data: Uint8Array }
  | { name: string; modifiedAt?: Date; size: number; open: () => Promise<ReadableStream<Uint8Array> | null> };

const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const VERSION = 20;
/** A central directory entry is 46 bytes and the name; a local header 30 and the name; a descriptor 16. */
const OVERHEAD = 46 + 30 + 16;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc: number, data: Uint8Array): number {
  let value = crc;
  for (const byte of data) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return value;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export class ZipBudget {
  private bytes = 22;
  private entries = 0;

  /**
   * Whether an entry of this name and size still fits the classic format,
   * with `reserve` bytes and one entry kept back for whatever is written last.
   */
  fits(name: string, size: number, reserve = 0): boolean {
    const cost = OVERHEAD + 2 * new TextEncoder().encode(name).length + size;
    return this.entries + 2 <= MAX_ZIP_ENTRIES && this.bytes + cost + reserve <= MAX_ZIP_BYTES;
  }

  take(name: string, size: number): void {
    this.bytes += OVERHEAD + 2 * new TextEncoder().encode(name).length + size;
    this.entries += 1;
  }
}

interface Central {
  name: Uint8Array;
  flags: number;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/**
 * Streams `entries` as one archive. An entry whose `open` answers `null` —
 * bytes missing from the store — is skipped and reported to `onMissing`, before
 * anything of it is written.
 */
export function createZipStream(
  entries: AsyncIterable<StreamedZipEntry>,
  onMissing: (name: string) => void = () => undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const centrals: Central[] = [];
  let offset = 0;

  async function* produce(): AsyncGenerator<Uint8Array> {
    for await (const entry of entries) {
      if (!isSafeZipName(entry.name)) throw new RangeError(`Unsafe archive path: ${entry.name}`);
      if (centrals.length >= MAX_ZIP_ENTRIES) throw new RangeError('The archive has too many entries');
      const name = encoder.encode(entry.name);
      const stamp = dosDateTime(entry.modifiedAt ?? new Date(0));

      let body: ReadableStream<Uint8Array> | null = null;
      if (!('data' in entry)) {
        body = await entry.open();
        if (body === null) {
          onMissing(entry.name);
          continue;
        }
      }
      const known = 'data' in entry ? { crc: crc32(entry.data), size: entry.data.length } : null;
      const flags = FLAG_UTF8 | (known === null ? FLAG_DESCRIPTOR : 0);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x0403_4b50, true);
      lv.setUint16(4, VERSION, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, known?.crc ?? 0, true);
      lv.setUint32(18, known?.size ?? 0, true);
      lv.setUint32(22, known?.size ?? 0, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      const start = offset;
      yield local;
      offset += local.length;

      let crc: number;
      let size: number;
      if ('data' in entry) {
        yield entry.data;
        offset += entry.data.length;
        crc = known!.crc;
        size = known!.size;
      } else {
        const reader = body!.getReader();
        let running = 0xffff_ffff;
        size = 0;
        let finished = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            running = crcUpdate(running, value);
            size += value.byteLength;
            yield value;
          }
          finished = true;
        } finally {
          // A download cancelled half-way ends here too: the file handle or
          // the bucket's socket behind the stream is let go now, not at the
          // next garbage collection.
          if (!finished) await reader.cancel().catch(() => undefined);
        }
        offset += size;
        crc = (running ^ 0xffff_ffff) >>> 0;
        const descriptor = new Uint8Array(16);
        const dv = new DataView(descriptor.buffer);
        dv.setUint32(0, 0x0807_4b50, true);
        dv.setUint32(4, crc, true);
        dv.setUint32(8, size, true);
        dv.setUint32(12, size, true);
        yield descriptor;
        offset += descriptor.length;
      }
      if (offset > MAX_ZIP_BYTES) throw new RangeError('The archive is too large');
      centrals.push({ name, flags, crc, size, offset: start, time: stamp.time, date: stamp.date });
    }

    let centralSize = 0;
    for (const entry of centrals) {
      const central = new Uint8Array(46 + entry.name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x0201_4b50, true);
      cv.setUint16(4, VERSION, true);
      cv.setUint16(6, VERSION, true);
      cv.setUint16(8, entry.flags, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, entry.time, true);
      cv.setUint16(14, entry.date, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.size, true);
      cv.setUint32(24, entry.size, true);
      cv.setUint16(28, entry.name.length, true);
      cv.setUint32(42, entry.offset, true);
      central.set(entry.name, 46);
      centralSize += central.length;
      yield central;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x0605_4b50, true);
    ev.setUint16(8, centrals.length, true);
    ev.setUint16(10, centrals.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    yield end;
  }

  const iterator = produce();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
