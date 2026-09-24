import { describe, expect, it } from 'vitest';

import { contentTypeOf, fileNameProblem, normalizeFileName } from '../src/index';

describe('file names', () => {
  it('stores names composed and trimmed', () => {
    expect(normalizeFileName('  Cafe\u0301.pdf ')).toBe('Caf\u00e9.pdf');
  });

  it('accepts ordinary names in any script', () => {
    for (const name of ['release-1.2.0.zip', 'Отчёт Q3.pdf', '設計書.docx', '.env.example', 'a b (1).tar.gz']) {
      expect(fileNameProblem(name)).toBeNull();
    }
  });

  it('refuses names that are paths, empty, too long or deceptive', () => {
    expect(fileNameProblem('')).not.toBeNull();
    expect(fileNameProblem('.')).not.toBeNull();
    expect(fileNameProblem('..')).not.toBeNull();
    expect(fileNameProblem('dir/file.txt')).not.toBeNull();
    expect(fileNameProblem('dir\\file.txt')).not.toBeNull();
    expect(fileNameProblem('line\nbreak')).not.toBeNull();
    expect(fileNameProblem('invoice\u202efdp.exe')).not.toBeNull();
    expect(fileNameProblem('x'.repeat(201))).not.toBeNull();
    expect(fileNameProblem('я'.repeat(200))).toBeNull();
  });
});

describe('content types', () => {
  it('prefers the extension', () => {
    expect(contentTypeOf('Build.ZIP', 'text/html')).toBe('application/zip');
    expect(contentTypeOf('notes.md', null)).toBe('text/markdown');
  });

  it('falls back to a well-formed declared type, without parameters', () => {
    expect(contentTypeOf('artifact', 'Application/X-Custom; charset=utf-8')).toBe('application/x-custom');
  });

  it('labels anything else as bytes', () => {
    expect(contentTypeOf('artifact', 'not a type')).toBe('application/octet-stream');
    expect(contentTypeOf('artifact', 'multipart/form-data; boundary=x')).toBe('application/octet-stream');
    expect(contentTypeOf('.bashrc', undefined)).toBe('application/octet-stream');
  });
});
