'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';

export interface WatchButtonLabels {
  watch: string;
  unwatch: string;
  hint: string;
  error: string;
}

/**
 * Watching a page or a space for new versions of its files: a toggle, whose
 * effect is items in the inbox. A viewer may watch — it changes nothing anybody
 * else sees.
 */
export function WatchButton({
  target,
  watching: initial,
  labels,
}: {
  target: { page_id: string } | { space: string };
  watching: boolean;
  labels: WatchButtonLabels;
}) {
  const [watching, setWatching] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch('/api/v1/watches', {
        method: watching ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
        credentials: 'same-origin',
      });
      if (response.ok) setWatching(!watching);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={watching ? 'secondary' : 'outline'}
        size="sm"
        disabled={pending}
        aria-pressed={watching}
        title={labels.hint}
        onClick={() => void toggle()}
      >
        {watching ? labels.unwatch : labels.watch}
      </Button>
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          {labels.error}
        </span>
      ) : null}
    </span>
  );
}
