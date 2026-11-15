/**
 * Term - a technical word with its plain-language definition one tap or hover away.
 *
 *   <Term k="rca" />                  renders "RCA" with a dotted underline
 *   <Term k="rca">competitiveness</Term>  custom visible text
 *
 * It is a real <button>, so on phones a tap focuses it and opens the definition (the tooltip opens on
 * focus); tapping elsewhere closes it.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { GLOSSARY, type GlossaryKey } from '@/lib/glossary';
import { Tooltip } from './Tooltip';

export interface TermProps {
  k: GlossaryKey;
  children?: ReactNode;
  className?: string;
}

export function Term({ k, children, className }: TermProps) {
  const entry = GLOSSARY[k];
  return (
    <Tooltip
      maxWidth={300}
      content={
        <span className="block text-left">
          <span className="block font-semibold">{entry.term}</span>
          <span className="mt-0.5 block">{entry.short}</span>
          {'read' in entry && entry.read ? <span className="mt-1 block opacity-80">{entry.read}</span> : null}
        </span>
      }
    >
      <button
        type="button"
        className={clsx(
          'cursor-help rounded-sm underline decoration-dotted decoration-1 underline-offset-[3px] decoration-muted',
          'hover:decoration-brand focus-visible:outline-2 focus-visible:outline-brand',
          className,
        )}
        aria-label={`${entry.term}: ${entry.short}`}
      >
        {children ?? entry.term}
      </button>
    </Tooltip>
  );
}
