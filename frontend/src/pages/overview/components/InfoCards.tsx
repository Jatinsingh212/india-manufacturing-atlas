/**
 * InfoCards - the four context cards (A brief about HSN Code, What is the Guidebook, How to use the
 * Guidebook, CBIC Tariff Manual) from GET /api/meta/info. Each card opens a
 * drawer with the markdown body and its reference links.
 */
import { useState } from 'react';
import { BookOpen, ChevronRight, Compass, ExternalLink, FileText, Info, type LucideIcon } from 'lucide-react';
import type { InfoCard } from '@/api/types';
import { Button, Drawer, ErrorState, Markdown, Skeleton } from '@/components';
import { iconByName } from '@/lib/icons';
import { truncate } from '@/lib/format';
import { useInfoCards } from '../api';

const LOCAL_ICONS: Record<string, LucideIcon> = { Info, BookOpen, Compass, FileText };

function infoIcon(name: string | null): LucideIcon {
  return (name && LOCAL_ICONS[name]) || iconByName(name, Info);
}

/** Opening sentences of a markdown body as plain text (the card teaser; CSS clamps it to three lines). */
function teaser(md: string): string {
  const plain = md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*(\d+\.|-)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Whole sentences until the teaser says something (bold lead-ins like "Find a code." are short).
  const sentences = plain.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [plain];
  let out = '';
  for (const sen of sentences) {
    out = `${out}${sen}`;
    if (out.trim().length >= 70) break;
  }
  return truncate(out.trim(), 240);
}

export function InfoCards() {
  const q = useInfoCards();
  const [open, setOpen] = useState<InfoCard | null>(null);

  if (q.isPending) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
    );
  }
  if (q.isError && !q.data) {
    return (
      <div className="rounded-2xl border border-line bg-surface shadow-card">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact title="Guidebook information could not be loaded" />
      </div>
    );
  }
  const cards = q.data ?? [];
  if (!cards.length) return null;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => {
          const Icon = infoIcon(c.icon);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpen(c)}
              className="group flex min-w-0 items-start gap-3 rounded-2xl border border-white/10 bg-[linear-gradient(145deg,#07182f_0%,#0a2141_100%)] p-4 text-left text-on-navy shadow-card ring-1 ring-white/[0.03] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-white/20 hover:shadow-[0_18px_38px_-24px_rgba(7,24,47,0.7)] focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:outline-none"
            >
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.08] text-[#cfe0ff] ring-1 ring-white/10" aria-hidden>
                <Icon className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[14.5px] leading-snug font-semibold text-white">
                  {c.title}
                  <ChevronRight className="size-4 opacity-60 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
                <span className="mt-1.5 line-clamp-3 text-[12px] leading-[1.55] text-on-navy-muted">{teaser(c.body_md)}</span>
              </span>
            </button>
          );
        })}
      </div>

      <Drawer open={open !== null} onClose={() => setOpen(null)} title={open?.title} subtitle="Guidebook on Mapping of HSN Codes" width={520}>
        {open ? (
          <div className="space-y-5">
            <Markdown>{open.body_md}</Markdown>
            {open.links.length ? (
              <div>
                <div className="mb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">References</div>
                <ul className="space-y-1.5">
                  {open.links.map((l) => (
                    <li key={l.url}>
                      <Button href={l.url} variant="link" size="sm" icon={ExternalLink}>
                        {l.label}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
