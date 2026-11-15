/**
 * OverviewHero - the cover of the Atlas, built around one action: search. A short title, one line of
 * intent, a large HSN / product search, and the four questions officials ask most as one-tap chips.
 * Data year and refresh date sit in a quiet footer line (details in a tooltip); the provenance legend
 * lives in the page footer, so it is not repeated here.
 */
import { Link } from 'react-router';
import { Compass, Database, Network, ShieldAlert, Sparkles, Target, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DataFreshnessRow, OverviewResponse } from '@/api/types';
import { HsnSearchBox, Tooltip, useAssistant } from '@/components';
import { fmtDate, fmtNum } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { routes } from '@/lib/routes';

export interface OverviewHeroProps {
  overview: OverviewResponse | undefined;
  builtAt: string | null | undefined;
}

/** Most recent refresh timestamp across sources (ISO strings compare lexically). */
function latestRefresh(rows: DataFreshnessRow[] | undefined): string | null {
  const ts = (rows ?? []).map((r) => r.last_refreshed).filter((v): v is string => Boolean(v));
  return ts.length ? ts.sort().at(-1) ?? null : null;
}

const QUESTIONS: Array<{ label: string; to: string; icon: LucideIcon }> = [
  { label: 'What can we manufacture?', to: '/decisions', icon: Target },
  { label: 'Who owns my product?', to: routes.explore(), icon: Compass },
  { label: 'Where is India strong?', to: routes.analytics('potential'), icon: TrendingUp },
  { label: 'Where do we depend on imports?', to: routes.risk(), icon: ShieldAlert },
  { label: 'How do value chains connect?', to: routes.network(), icon: Network },
];

export function OverviewHero({ overview, builtAt }: OverviewHeroProps) {
  useDocumentTitle('Guidebook on Mapping of HSN Codes');
  const assistant = useAssistant();
  const year = overview?.kpis.latest_year;
  const refreshed = latestRefresh(overview?.data_freshness) ?? builtAt ?? null;
  const freshness = overview?.data_freshness ?? [];
  const total = overview?.kpis.total_codes;

  return (
    <section className="relative isolate overflow-hidden rounded-3xl border border-white/10 bg-[linear-gradient(125deg,#07182f_0%,#0a2142_58%,#0d2b55_100%)] text-on-navy shadow-[0_34px_72px_-42px_rgba(7,24,47,0.9)]">
      <div className="atlas-hero-grid pointer-events-none absolute inset-0 opacity-55" aria-hidden />
      <div className="pointer-events-none absolute -top-36 right-[-8%] size-[520px] rounded-full bg-brand/30 blur-[110px]" aria-hidden />
      <div className="pointer-events-none absolute -bottom-56 left-[18%] size-[420px] rounded-full bg-kpi/15 blur-[110px]" aria-hidden />

      <div className="relative px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-9">
        <div className="flex items-center gap-2.5 text-[10px] font-bold tracking-[0.18em] text-[#9db9f4] uppercase sm:text-[10.5px]">
          <span className="h-px w-6 shrink-0 bg-gradient-to-r from-kpi to-[#6b98ff]" aria-hidden />
          <span>DPIIT · HSN code intelligence</span>
        </div>

        <h1 className="mt-3 max-w-3xl text-[clamp(1.85rem,3.8vw,3rem)] leading-[1.05] font-extrabold tracking-[-0.045em] text-white">
          Guidebook on Mapping of{' '}
          <span className="bg-gradient-to-r from-[#b7ceff] via-white to-[#ffc0df] bg-clip-text text-transparent">HSN Codes</span>
        </h1>
        <p className="mt-2 text-[14px] text-on-navy-muted sm:text-[15px]">
          {typeof total === 'number' ? <><b className="text-white">{fmtNum(total)}</b> Indian product lines. </> : null}
          Who owns each one, what India trades, and where it flows.
        </p>

        <div className="mt-5 max-w-2xl">
          <HsnSearchBox size="lg" placeholder="Search a product or HSN code: car tyres, 6109, 61091000…" className="w-full" />
        </div>

        {/* one swipeable row on phones, wrapping on wider screens */}
        <div className="atlas-scrollbar-none -mx-5 mt-4 flex items-center gap-2 overflow-x-auto px-5 [&>*]:shrink-0 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {QUESTIONS.map(({ label, to, icon: Icon }) => (
            <Link
              key={label}
              to={to}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.07] px-3 text-[12.5px] font-medium text-white transition-colors hover:border-white/25 hover:bg-white/[0.13] active:scale-[0.97]"
            >
              <Icon className="size-3.5 text-[#adc6ff]" aria-hidden />
              {label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => assistant.open()}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-kpi px-3 text-[12.5px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(230,0,126,0.8)] transition-transform hover:brightness-110 active:scale-[0.97]"
          >
            <Sparkles className="size-3.5" aria-hidden /> Ask Atlas
          </button>
        </div>

        {year || refreshed ? (
          <Tooltip
            maxWidth={360}
            content={freshness.length ? (
              <span className="block space-y-0.5">
                {freshness.map((f) => (
                  <span key={f.source_id} className="flex justify-between gap-4">
                    <span>{f.name}</span>
                    <span className="whitespace-nowrap">{fmtDate(f.last_refreshed)}</span>
                  </span>
                ))}
              </span>
            ) : 'Date of the last database build'}
          >
            <span className="mt-5 inline-flex cursor-help items-center gap-1.5 text-[11.5px] text-on-navy-muted">
              <Database className="size-3.5" aria-hidden />
              {year ? <>Trade data {year}</> : null}
              {year && refreshed ? ' · ' : null}
              {refreshed ? <>refreshed {fmtDate(refreshed)}</> : null}
            </span>
          </Tooltip>
        ) : null}
      </div>
    </section>
  );
}
