/**
 * TradeLevelMark - small "HS4 total" / "Chapter total" badge next to a stage item's exports or imports
 * when the figure is not the item's own HS6 subheading (4-digit items, BACI heading aggregates such as
 * petroleum oils 2710 -> 271000). The tooltip says what was summed. Renders nothing for HS6 figures.
 *
 *   <TradeValue value={item.exports} note={tradeLevelNote(item)} />
 */
import clsx from 'clsx';
import { Badge, Tooltip } from '@/components';
import { fmtUSD, NA_SHORT } from '@/lib/format';
import type { TradeLevelNote } from '../utils';

export function TradeLevelMark({ note, className }: { note: TradeLevelNote | null; className?: string }) {
  if (!note) return null;
  return (
    <Tooltip content={note.long} maxWidth={320}>
      <Badge tone="warning" size="xs" className={clsx('cursor-help', className)}>
        {note.short}
      </Badge>
    </Tooltip>
  );
}

/** A right-aligned US$ figure with the trade-level mark after it (when the figure is an aggregate). */
export function TradeValue({ value, note, muted }: { value: number | null | undefined; note: TradeLevelNote | null; muted?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center justify-end gap-1.5 whitespace-nowrap', muted && 'text-muted')}>
      <span>{fmtUSD(value, { na: NA_SHORT })}</span>
      <TradeLevelMark note={note} />
    </span>
  );
}
