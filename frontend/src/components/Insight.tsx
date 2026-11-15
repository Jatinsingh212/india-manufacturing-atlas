/**
 * Insight - a "What this means" callout that turns the numbers on a page into plain sentences.
 *
 *   <Insight points={[
 *     <>India is the <b>8th</b> largest tyre supplier, with <b>3.1%</b> of world exports.</>,
 *     'Imports are small: India is a net exporter.',
 *   ]} />
 *
 * Points are rendered as a short list with a coloured tone dot; `tone` per point marks it as a
 * strength (good), a risk (bad) or neutral context. Keep each point to one line of plain language.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Lightbulb } from 'lucide-react';

export type InsightTone = 'good' | 'bad' | 'info';

export interface InsightPoint {
  text: ReactNode;
  tone?: InsightTone;
}

export interface InsightProps {
  points: ReadonlyArray<ReactNode | InsightPoint>;
  title?: ReactNode;
  /** Small print under the list (method / provenance). */
  note?: ReactNode;
  className?: string;
}

const DOT: Record<InsightTone, string> = { good: 'bg-ok', bad: 'bg-bad', info: 'bg-brand' };

function isPoint(p: ReactNode | InsightPoint): p is InsightPoint {
  return typeof p === 'object' && p !== null && 'text' in (p as object);
}

export function Insight({ points, title = 'What this means', note, className }: InsightProps) {
  const items = points.filter((p) => p !== null && p !== undefined && p !== false);
  if (!items.length) return null;
  return (
    <section
      aria-label={typeof title === 'string' ? title : 'What this means'}
      className={clsx(
        'relative overflow-hidden rounded-2xl border border-brand/20 bg-surface p-4 shadow-card sm:p-5',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-brand text-on-brand shadow-sm">
          <Lightbulb className="size-4" aria-hidden />
        </span>
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-brand-ink">{title}</h2>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((p, i) => {
          const point = isPoint(p) ? p : { text: p, tone: 'info' as InsightTone };
          return (
            <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed text-ink">
              <span className={clsx('mt-[0.55em] size-1.5 shrink-0 rounded-full', DOT[point.tone ?? 'info'])} aria-hidden />
              <span>{point.text}</span>
            </li>
          );
        })}
      </ul>
      {note ? <p className="mt-3 text-[12px] text-muted">{note}</p> : null}
    </section>
  );
}
