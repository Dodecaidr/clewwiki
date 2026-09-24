/**
 * The addresses of files, kept apart from the handlers' helpers so that code
 * which only needs to write a link — an export, an import — does not pull in
 * authentication with them.
 */

/** The stable address of a file: always its latest version. Relative, like an image's. */
export function fileHref(pageId: string, name: string): string {
  // Parentheses escaped as well, so the address is one Markdown destination
  // whatever the name: `a).pdf` would otherwise end the link early.
  return `/api/v1/pages/${pageId}/files/${encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;
}

export function fileVersionHref(fileId: string, version: number): string {
  return `/api/v1/files/${fileId}/content?version=${version}`;
}
