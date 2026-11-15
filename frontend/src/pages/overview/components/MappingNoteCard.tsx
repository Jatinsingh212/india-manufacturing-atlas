/**
 * MappingNoteCard - "About this mapping": the source and coverage of the official DPIIT Guidebook
 * mapping (16.12.2025 revision), the live count of lines per mapping source, and the data-freshness list.
 */
import { DatabaseZap, ShieldQuestion } from 'lucide-react';
import type { DataFreshnessRow, MappingSource, OverviewResponse } from '@/api/types';
import { Button, Card, ProvenanceDot } from '@/components';
import { fmtDate, fmtNum, fmtPct } from '@/lib/format';
import { routes } from '@/lib/routes';
import { mappingProvenance, MAPPING_SOURCE_LABELS } from '@/pages/explore/shared';

const SOURCE_ORDER: Array<MappingSource | string> = ['dpiit_guidebook', 'official_upload', 'manual', 'rule', 'unmapped', 'residual'];

/** Freshness rows may carry the connector status (beyond SPEC 6.2). */
type FreshnessRow = DataFreshnessRow & { status?: string | null };

/** Last refresh date, or why there is none (a government API without credentials is "not configured"). */
function freshnessText(f: FreshnessRow): string {
  if (f.last_refreshed) return fmtDate(f.last_refreshed);
  if (f.status === 'not_configured') return 'Not configured';
  if (f.status === 'error') return 'Refresh failed';
  return 'Not refreshed yet';
}

export interface MappingNoteCardProps {
  mappingSources: Array<{ source: MappingSource | string; codes: number }>;
  mappingByLevel: OverviewResponse['mapping_by_level'];
  freshness: FreshnessRow[];
}

export function MappingNoteCard({ mappingSources, mappingByLevel, freshness }: MappingNoteCardProps) {
  const counts = new Map(mappingSources.map((m) => [m.source, m.codes]));
  const total = mappingSources.reduce((s, m) => s + (m.codes || 0), 0);
  const sources = [...SOURCE_ORDER, ...mappingSources.map((m) => m.source).filter((s) => !SOURCE_ORDER.includes(s))];

  return (
    <Card title="About this mapping" icon={ShieldQuestion} subtitle="How each line gets its owning ministry">
      <div className="grid min-w-0 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-2.5 text-[13px] leading-relaxed text-ink-2">
          <p>
            Ministry ownership comes from the <strong className="text-ink">official DPIIT Guidebook on HSN Code Mapping</strong>{' '}
            (revised 16 December 2025). The Guidebook accepts 11,679 unique 8-digit codes and lists a further 495 as
            residual. Where a code is accepted by several ministries, every owner is recorded and the first-listed
            owner is shown as primary.
          </p>
          <p>
            11,662 Guidebook codes match the GST product master. Lines the Guidebook does not list, or lists as
            residual, stay <em>Residual</em>; the Atlas does not substitute a rule-based owner. Official Data Hub
            uploads and approved ministry claims, if any, are marked <em>Verified</em> separately.
          </p>
          {mappingByLevel.length ? (
            <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
              <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Guidebook coverage by HS level</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-4">
                {mappingByLevel.map((l) => (
                  <div key={l.level}>
                    <div className="font-semibold text-ink">{l.level}-digit</div>
                    <div className="text-ink-2">{fmtPct(l.line_coverage, { digits: 0 })} of lines</div>
                    <div className="text-[11px] text-muted atlas-num">{fmtNum(l.mapped_lines)} / {fmtNum(l.lines)}</div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-muted">
                2/4/6-digit ownership is derived from the accepted 8-digit lines under each code (leading owner shown
                first); it is not a separate Guidebook acceptance.
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button to={routes.dataHub()} size="sm" variant="secondary" icon={DatabaseZap}>
              Open the Data Hub
            </Button>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Lines by mapping source</div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {sources.map((s) => {
                const n = counts.get(s) ?? 0;
                return (
                  <li key={s} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                    <ProvenanceDot provenance={mappingProvenance(s)} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{MAPPING_SOURCE_LABELS[s] ?? s}</span>
                    <span className="font-medium text-ink atlas-num">{fmtNum(n)}</span>
                    <span className="w-12 text-right text-muted atlas-num">{total > 0 ? fmtPct(n / total, { digits: 1 }) : ''}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          {freshness.length ? (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Data freshness</div>
              <ul className="space-y-1 text-[12.5px]">
                {freshness.map((f) => (
                  <li key={f.source_id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-ink-2" title={f.name}>
                      {f.name}
                    </span>
                    <span className={f.last_refreshed ? 'whitespace-nowrap text-ink' : 'whitespace-nowrap text-na-ink'}>{freshnessText(f)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
