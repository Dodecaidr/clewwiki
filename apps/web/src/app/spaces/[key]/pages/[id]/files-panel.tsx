'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { WatchButton } from '@/components/watch-button';
import type { WatchButtonLabels } from '@/components/watch-button';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/field';

export interface FilesPanelVersion {
  version: number;
  url: string;
  /** Ready-made: size, who and when. */
  caption: string;
  note: string | null;
  restoredFrom: number | null;
}

export interface FilesPanelItem {
  fileId: string;
  name: string;
  /** The file's permanent address: always its latest version. */
  url: string;
  latestVersion: number;
  versions: FilesPanelVersion[];
}

export interface FilesPanelLabels {
  heading: string;
  intro: string;
  empty: string;
  choose: string;
  note: string;
  notePlaceholder: string;
  upload: string;
  uploading: string;
  history: string;
  version: string;
  restoredFrom: string;
  restore: string;
  restoreConfirm: string;
  remove: string;
  removeConfirm: string;
  copyLink: string;
  copied: string;
  errorTooLarge: string;
  errorFull: string;
  errorOff: string;
  errorName: string;
  errorGeneric: string;
  watch: WatchButtonLabels;
}

type UploadError = 'tooLarge' | 'full' | 'off' | 'name' | 'generic';

function uploadErrorOf(status: number): UploadError {
  if (status === 413) return 'tooLarge';
  if (status === 409) return 'full';
  if (status === 403) return 'off';
  if (status === 400) return 'name';
  return 'generic';
}

/**
 * The files attached to a page, each in its versions.
 *
 * Choosing a file with a name the page already has uploads its next version;
 * the address of the file does not change, which is what makes a page the
 * place a release is published. Going back restores an old version as a new
 * one. Whoever watches the page finds each new version in their inbox.
 */
export function FilesPanel({
  pageId,
  files,
  labels,
  canUpload,
  canWrite,
  watching,
}: {
  pageId: string;
  files: FilesPanelItem[];
  labels: FilesPanelLabels;
  /** False when uploads are switched off on the instance, or the page cannot be written. */
  canUpload: boolean;
  /** True for somebody who may restore and remove. */
  canWrite: boolean;
  watching: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ name: string; kind: UploadError } | null>(null);

  if (files.length === 0 && !canUpload) return null;

  async function upload(chosen: FileList | null) {
    if (!chosen || chosen.length === 0) return;
    setPending(true);
    setError(null);
    try {
      for (const file of [...chosen]) {
        const query = note.trim() === '' ? '' : `?note=${encodeURIComponent(note.trim())}`;
        let response: Response;
        try {
          response = await fetch(`/api/v1/pages/${pageId}/files/${encodeURIComponent(file.name)}${query}`, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
            credentials: 'same-origin',
          });
        } catch {
          setError({ name: file.name, kind: 'generic' });
          return;
        }
        if (!response.ok) {
          setError({ name: file.name, kind: uploadErrorOf(response.status) });
          return;
        }
      }
      setNote('');
      router.refresh();
    } finally {
      setPending(false);
      if (input.current) input.current.value = '';
    }
  }

  const errorText = (kind: UploadError) =>
    ({
      tooLarge: labels.errorTooLarge,
      full: labels.errorFull,
      off: labels.errorOff,
      name: labels.errorName,
      generic: labels.errorGeneric,
    })[kind];

  return (
    <Card id="files">
      <CardHeader>
        <CardTitle>{files.length > 0 ? `${labels.heading} (${files.length})` : labels.heading}</CardTitle>
        <WatchButton target={{ page_id: pageId }} watching={watching} labels={labels.watch} />
      </CardHeader>
      <CardBody className="grid gap-4">
        <p className="text-sm text-muted-foreground">{files.length > 0 ? labels.intro : labels.empty}</p>

        {files.length > 0 ? (
          <ul className="grid gap-3">
            {files.map((file) => (
              <FileRow key={file.fileId} file={file} labels={labels} canWrite={canWrite} />
            ))}
          </ul>
        ) : null}

        {canUpload ? (
          <div className="grid gap-2 border-t border-border pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{labels.note}</span>
              <Input
                value={note}
                maxLength={1000}
                placeholder={labels.notePlaceholder}
                onChange={(event) => setNote(event.target.value)}
                disabled={pending}
              />
            </label>
            <div>
              <input
                ref={input}
                type="file"
                multiple
                className="sr-only"
                id={`file-input-${pageId}`}
                onChange={(event) => void upload(event.target.files)}
                disabled={pending}
              />
              <Button size="md" disabled={pending} onClick={() => input.current?.click()}>
                {pending ? labels.uploading : labels.choose}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {`${error.name}: ${errorText(error.kind)}`}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function FileRow({ file, labels, canWrite }: { file: FilesPanelItem; labels: FilesPanelLabels; canWrite: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const latest = file.versions[0];

  async function send(path: string, method: 'POST' | 'DELETE', body?: unknown) {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
      if (!response.ok) setFailed(true);
      else router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <li id={`file-${file.fileId}`} className="grid gap-2 rounded-(--radius-base) border border-border px-3 py-2 target:border-foreground/40">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={file.url} className="font-medium break-all underline-offset-2 hover:underline" download>
          {file.name}
        </a>
        <span className="font-mono text-xs text-muted-foreground">{`${labels.version}${file.latestVersion}`}</span>
        {latest ? <span className="text-xs text-muted-foreground">{latest.caption}</span> : null}
        <button
          type="button"
          className="text-xs underline underline-offset-2"
          onClick={() => {
            void navigator.clipboard?.writeText(new URL(file.url, window.location.origin).toString()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? labels.copied : labels.copyLink}
        </button>
      </div>
      {/* A note is somebody's words: rendered as text, never as markup. */}
      {latest?.note ? <p className="text-sm text-muted-foreground">{latest.note}</p> : null}

      {file.versions.length > 1 || canWrite ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">{`${labels.history} (${file.versions.length})`}</summary>
          <ol className="mt-2 grid gap-2">
            {file.versions.map((version) => (
              <li key={version.version} className="grid gap-0.5 text-sm">
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <a href={version.url} className="font-mono text-xs underline underline-offset-2" download>
                    {`${labels.version}${version.version}`}
                  </a>
                  <span className="text-xs text-muted-foreground">{version.caption}</span>
                  {version.restoredFrom !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {labels.restoredFrom.replace('{version}', String(version.restoredFrom))}
                    </span>
                  ) : null}
                  {canWrite && version.version !== file.latestVersion ? (
                    <button
                      type="button"
                      className="text-xs underline underline-offset-2 disabled:opacity-60"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(labels.restoreConfirm.replace('{version}', String(version.version)))) {
                          void send(`/api/v1/files/${file.fileId}/restore`, 'POST', { version: version.version });
                        }
                      }}
                    >
                      {labels.restore}
                    </button>
                  ) : null}
                </span>
                {version.note && version.version !== file.latestVersion ? (
                  <span className="text-xs text-muted-foreground">{version.note}</span>
                ) : null}
              </li>
            ))}
          </ol>
          {canWrite ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={pending}
              onClick={() => {
                if (window.confirm(labels.removeConfirm)) void send(`/api/v1/files/${file.fileId}`, 'DELETE');
              }}
            >
              {labels.remove}
            </Button>
          ) : null}
        </details>
      ) : null}
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          {labels.errorGeneric}
        </span>
      ) : null}
    </li>
  );
}
