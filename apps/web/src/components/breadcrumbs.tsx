import Link from 'next/link';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Space › parent › page. Plain links; the last crumb is the current location
 * and is not a link.
 */
export function Breadcrumbs({ items, label }: { items: Crumb[]; label: string }) {
  return (
    <nav aria-label={label} className="text-xs text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <span aria-hidden>›</span> : null}
            {item.href && index < items.length - 1 ? (
              <Link href={item.href} className="truncate hover:text-foreground hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current={index === items.length - 1 ? 'page' : undefined} className="truncate">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
