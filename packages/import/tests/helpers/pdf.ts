/**
 * A PDF small enough to build in a test.
 *
 * The PDF adapter's whole job is inference from font sizes and coordinates, so
 * the fixture has to control both. Generating it here rather than committing a
 * binary keeps what the test asserts visible in the test: this heading is 18pt,
 * that paragraph is 11pt, this table's columns start at x = 72 and x = 300.
 */

export interface TextRun {
  text: string;
  x: number;
  y: number;
  size: number;
  /** `F1` is Helvetica, `F2` is Courier — the monospaced one. */
  font?: 'F1' | 'F2';
}

/** Escapes a string for a PDF literal. */
function pdfString(value: string): string {
  return value.replace(/[\\()]/g, (char) => `\\${char}`);
}

function contentStream(runs: readonly TextRun[]): string {
  const parts = ['BT'];
  for (const run of runs) {
    parts.push(`/${run.font ?? 'F1'} ${run.size} Tf`);
    parts.push('1 0 0 1 ' + run.x + ' ' + run.y + ' Tm');
    parts.push(`(${pdfString(run.text)}) Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

/** A one-page-per-array PDF with Helvetica and Courier available. */
export function buildPdf(pages: ReadonlyArray<readonly TextRun[]>): Uint8Array {
  const objects: string[] = [];
  const pageCount = Math.max(pages.length, 1);
  // 1 catalog, 2 pages, then per page: a page object and a content stream,
  // then the two fonts.
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const contentIds = pages.map((_, index) => 4 + index * 2);
  const fontHelvetica = 3 + pageCount * 2;
  const fontCourier = fontHelvetica + 1;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);

  pages.forEach((runs, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontHelvetica} 0 R /F2 ${fontCourier} 0 R >> >> ` +
        `/Contents ${contentIds[index]} 0 R >>`,
    );
    const stream = contentStream(runs);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(body + xref + trailer, 'latin1'));
}
