/**
 * KeyValueList - two-column label / value list (the "Enter HSN code" result table, product
 * facts, side panels).
 *
 *   <KeyValueList items={[
 *     { label: 'Assigned ministry', value: <MinistryPill ministry={...} /> },
 *     { label: "India's exports to world ($ Mn.)", value: fmtUSDMn(p.exports), numeric: true },
 *   ]} />
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Right-aligned tabular figures. */
  numeric?: boolean;
  /** Small trailing note (e.g. a provenance badge). */
  aside?: ReactNode;
}

export interface KeyValueListProps {
  items: ReadonlyArray<KeyValueItem | null | false | undefined>;
  /** 'table' = bordered rows; 'plain' = compact list. */
  variant?: 'table' | 'plain';
  /** Label column width (CSS length, default 42%). */
  labelWidth?: string;
  className?: string;
}

export function KeyValueList({ items, variant = 'table', labelWidth = '42%', className }: KeyValueListProps) {
  const rows = items.filter((x): x is KeyValueItem => Boolean(x));
  return (
    <dl className={clsx(variant === 'table' && 'overflow-hidden rounded-lg border border-line', className)}>
      {rows.map((r, i) => (
        <div
          key={i}
          className={clsx('grid items-center gap-3', variant === 'table' ? 'px-3 py-2 text-[13px]' : 'py-1.5 text-[13px]', variant === 'table' && i > 0 && 'border-t border-line', variant === 'table' && i % 2 === 1 && 'bg-surface-2')}
          style={{ gridTemplateColumns: `${labelWidth} 1fr` }}
        >
          <dt className="font-medium text-ink-2">{r.label}</dt>
          <dd className={clsx('flex min-w-0 flex-wrap items-center gap-2 text-ink', r.numeric && 'atlas-num font-medium')}>
            <span className="min-w-0">{r.value}</span>
            {r.aside ? <span className="ml-auto text-xs text-muted">{r.aside}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
