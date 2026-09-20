'use client';

import { useActionState } from 'react';

import { deleteImageAction } from '@/app/pages/image-actions';
import type { ImageActionState } from '@/app/pages/image-actions';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';

const initialState: ImageActionState = {};

export interface ImagePanelItem {
  imageId: string;
  url: string;
  /** Ready-made: type, size, who and when. */
  caption: string;
  /** False when the current text of the page no longer shows it. */
  inUse: boolean;
}

export interface ImagePanelLabels {
  heading: string;
  intro: string;
  unused: string;
  remove: string;
  removeConfirm: string;
  errorNotFound: string;
  errorGeneric: string;
}

/**
 * The images uploaded into a page, with the one thing a person needs to be able
 * to do about them without an API client: take down the screenshot that should
 * not have been uploaded. Collapsed by default — it is housekeeping, not content.
 */
export function ImagePanel({
  images,
  labels,
  readOnly = false,
}: {
  images: ImagePanelItem[];
  labels: ImagePanelLabels;
  /** True for a viewer: the images are listed, and none can be removed. */
  readOnly?: boolean;
}) {
  if (images.length === 0) return null;

  return (
    <Card>
      <details>
        <summary className="cursor-pointer list-none">
          <CardHeader>
            <CardTitle>{`${labels.heading} (${images.length})`}</CardTitle>
          </CardHeader>
        </summary>
        <CardBody className="grid gap-4">
          <p className="text-sm text-muted-foreground">{labels.intro}</p>
          <ul className="grid gap-3">
            {images.map((image) => (
              <ImageRow key={image.imageId} image={image} labels={labels} readOnly={readOnly} />
            ))}
          </ul>
        </CardBody>
      </details>
    </Card>
  );
}

function ImageRow({
  image,
  labels,
  readOnly,
}: {
  image: ImagePanelItem;
  labels: ImagePanelLabels;
  readOnly: boolean;
}) {
  const [state, action, pending] = useActionState(deleteImageAction, initialState);

  return (
    <li className="flex flex-wrap items-center gap-4">
      <a href={image.url} target="_blank" rel="noreferrer" className="shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by this instance behind a session; the optimizer could not fetch it */}
        <img
          src={image.url}
          alt=""
          loading="lazy"
          className="h-16 w-24 rounded-(--radius-base) border border-border bg-secondary object-contain"
        />
      </a>
      <div className="grid min-w-0 flex-1 gap-1 text-sm">
        <span className="text-muted-foreground">{image.caption}</span>
        {image.inUse ? null : <span className="text-xs font-medium text-foreground">{labels.unused}</span>}
        {state.error ? (
          <span role="alert" className="text-xs text-destructive">
            {state.error === 'not_found' ? labels.errorNotFound : labels.errorGeneric}
          </span>
        ) : null}
      </div>
      <form
        hidden={readOnly}
        action={action}
        onSubmit={(event) => {
          if (!window.confirm(labels.removeConfirm)) event.preventDefault();
        }}
      >
        <input type="hidden" name="imageId" value={image.imageId} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {labels.remove}
        </Button>
      </form>
    </li>
  );
}
