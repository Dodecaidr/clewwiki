/**
 * A minimal ZIP reader: the counterpart of the writer the space export uses.
 *
 * Two of the four sources arrive as an archive, so reading one is core to this
 * package rather than a detail of one adapter. It is written here instead of
 * pulled in because the requirements are narrow — stored and deflated entries,
 * no encryption, no ZIP64 — and because an archive is untrusted input: the
 * reader has to decide for itself how many entries it will look at and how many
 * bytes it will let them expand to, which is exactly the decision a general
 * library makes somewhere else.
 *
 * Reading starts at the end-of-central-directory record and walks the central
 * directory, never the stream of local headers. A local header may lie about
 * its sizes (the streaming case sets them to zero and puts them in a trailing
 * descriptor); the central directory is the authoritative copy.
 */

import { inflateRawSync } from 'node:zlib';

import { ImportError } from './limits';
import type { ImportLimits } from './limits';

export interface ZipFile {
  /** Forward-slash path inside the archive, as stored. */
  name: string;
  data: Uint8Array;
  modifiedAt: Date | null;
}

const SIGNATURE_EOCD = 0x0605_4b50;
const SIGNATURE_CENTRAL = 0x0201_4b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;

function findEndOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of at most 65 535, so it is in the
  // last 64 KiB; scanning backwards finds it without reading the whole file.
  const limit = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) === SIGNATURE_EOCD) return offset;
  }
  throw new ImportError('validation', 'The file is not a ZIP archive');
}

/** MS-DOS date and time as a UTC `Date`, or null when the stamp is empty. */
function fromDosDateTime(time: number, date: number): Date | null {
  if (date === 0) return null;
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(
    Date.UTC(year, month - 1, day, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2),
  );
}

/**
 * True for a name that must not be read out of an archive: absolute, escaping
 * its root, or carrying a byte a path never legitimately contains. Archives are
 * uploaded by people who did not necessarily make them, so this is checked
 * before a name is used for anything, including as a map key.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.length > 1024) return false;
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').some((segment) => segment === '.' || segment === '..');
}

export interface ReadZipOptions {
  limits: Pick<ImportLimits, 'expandedBytes' | 'zipEntries'>;
  /** Only entries this returns true for are decompressed. */
  accept?: (name: string) => boolean;
  /** Told the name of every file `accept` turned down, so a caller can count them. */
  onRejected?: (name: string) => void;
  /**
   * Told instead of `onRejected` about a turned-down file this returns true
   * for, with a way to read it later. Nothing is decompressed until `read` is
   * called, and what `read` expands does not count here: the caller that reads
   * it holds it to what is left of the budget.
   */
  defer?: (name: string) => boolean;
  onDeferred?: (entry: DeferredZipFile) => void;
}

/** An archive entry not read yet: its name, what it expands to, and how to read it. */
export interface DeferredZipFile {
  name: string;
  size: number;
  read(): Uint8Array;
}

/**
 * Every file in the archive, directories and rejected names left out.
 *
 * Entries whose name is unsafe are skipped rather than refused: a Notion export
 * that happens to contain one odd path should still import, and nothing here
 * ever writes to a filesystem, so the only thing a traversal name could reach
 * is a map key.
 */
export function readZip(bytes: Uint8Array, options: ReadZipOptions): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  if (count > options.limits.zipEntries) {
    throw new ImportError('validation', `The archive holds more than ${options.limits.zipEntries} entries`, {
      entries: count,
    });
  }

  const decoder = new TextDecoder('utf-8');
  const files: ZipFile[] = [];
  let expanded = 0;

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== SIGNATURE_CENTRAL) {
      throw new ImportError('validation', 'The archive directory is damaged');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const time = view.getUint16(cursor + 12, true);
    const date = view.getUint16(cursor + 14, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ImportError('validation', 'The archive is encrypted');
    }
    // A name without the UTF-8 flag was written in some code page this reader
    // cannot know. Decoding it as UTF-8 is the only sane guess, and it is what
    // every modern writer produces anyway.
    void FLAG_UTF8;

    if (name.endsWith('/')) continue;
    if (!isSafeEntryName(name)) continue;
    if (options.accept && !options.accept(name)) {
      if (options.defer?.(name) === true && options.onDeferred) {
        options.onDeferred({
          name,
          size: uncompressedSize,
          read: () => readEntryData(bytes, view, localOffset, method, compressedSize, uncompressedSize),
        });
      } else {
        options.onRejected?.(name);
      }
      continue;
    }

    expanded += uncompressedSize;
    if (expanded > options.limits.expandedBytes) {
      throw new ImportError('validation', 'The archive expands to more than the size limit allows', {
        expanded_bytes: expanded,
      });
    }

    files.push({
      name,
      data: readEntryData(bytes, view, localOffset, method, compressedSize, uncompressedSize),
      modifiedAt: fromDosDateTime(time, date),
    });
  }

  return files;
}

function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  if (localOffset + 30 > bytes.byteLength) {
    throw new ImportError('validation', 'The archive is truncated');
  }
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > bytes.byteLength) {
    throw new ImportError('validation', 'The archive is truncated');
  }
  const raw = bytes.subarray(start, end);

  if (method === METHOD_STORED) return raw;
  if (method !== METHOD_DEFLATE) {
    throw new ImportError('validation', `The archive uses compression method ${method}`);
  }
  try {
    // `maxOutputLength` is the last line against an entry whose header
    // under-reports what it expands to.
    return new Uint8Array(inflateRawSync(raw, { maxOutputLength: uncompressedSize + 1024 }));
  } catch {
    throw new ImportError('validation', 'An entry in the archive could not be decompressed');
  }
}

/** The bytes of a ZIP entry as text, with the byte-order mark removed. */
export function entryText(file: ZipFile): string {
  return new TextDecoder('utf-8').decode(file.data).replace(/^﻿/, '');
}
