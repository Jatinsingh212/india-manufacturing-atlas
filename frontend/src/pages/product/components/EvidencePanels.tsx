/**
 * Evidence panels of the product page:
 * - <DataQualityCard>: the product's data-quality score (SPEC section 4: 30 verified mapping or 15 rule
 *   mapping + 30 trade + 20 tariff + 20 production, capped at 100) with the checklist behind it, and
 *   the production statistics linked to the line (or "Not available").
 */
import { CircleCheck, CircleDashed, Factory, ShieldCheck } from 'lucide-react';
import type { ProductDetail } from '@/api/types';
import { Card, ProvenanceBadge, ScoreBar, SectionLabel } from '@/components';
import { fmtNum, fmtUSD } from '@/lib/format';
import { mappingProvenance } from '@/pages/explore/shared';
import { tariffOf } from '../extras';

interface Check {
  label: string;
  points: number;
  max: number;
  ok: boolean;
  detail: string;
}

export function DataQualityCard({ p }: { p: ProductDetail }) {
  // Same tests as the API's quality_score (app/common.py), so the checklist adds up to the score shown.
  const status = p.mapping?.status ?? p.mapping_status;
  const mapProv = p.mapping?.provenance ?? mappingProvenance(p.mapping_source, status);
  const residual = status === 'residual';
  const verified = !residual && mapProv.status === 'verified';
  const mappingPoints = residual ? 0 : verified ? 30 : 15;
  const t = p.trade;
  const hasTrade = Boolean(t) && (typeof t?.exports === 'number' || typeof t?.imports === 'number' || typeof t?.world_trade === 'number');
  const tariff = tariffOf(p);
  const hasTariff = Boolean(tariff) && typeof tariff?.mfn_avg === 'number';
  const hasProduction = p.production.length > 0;
  const checks: Check[] = [
    {
      label: 'Ministry mapping',
      points: mappingPoints,
      max: 30,
      ok: verified,
      detail: residual ? 'Residual: no accepted owner (0 of 30)' : verified ? 'Verified DPIIT Guidebook mapping' : 'Provisional rule only (15 of 30)',
    },
    { label: 'Trade data', points: hasTrade ? 30 : 0, max: 30, ok: hasTrade, detail: hasTrade ? 'DGCIS TRADESTAT FY2018-19 to FY2024-25' : 'No DGCIS TRADESTAT record' },
    {
      label: 'Tariff data',
      points: hasTariff ? 20 : 0,
      max: 20,
      ok: hasTariff,
      detail: typeof tariff?.mfn_avg === 'number' ? 'WITS MFN applied average' : 'No ad-valorem MFN rate',
    },
    { label: 'Production data', points: hasProduction ? 20 : 0, max: 20, ok: hasProduction, detail: hasProduction ? 'Linked production statistic' : 'Not available' },
  ];

  return (
    <Card title="Data quality" subtitle="How complete and verified the evidence for this line is" icon={ShieldCheck}>
      <div className="flex items-end gap-3">
        <span className="text-[34px] leading-none font-bold text-kpi">{fmtNum(p.data_quality_score)}</span>
        <span className="pb-1 text-sm text-muted">/ 100</span>
      </div>
      <ScoreBar value={p.data_quality_score} size="md" showValue={false} label="Data quality" className="mt-2 [&>span:first-child]:hidden" />
      <ul className="mt-3 space-y-1.5">
        {checks.map((c) => {
          const Icon = c.ok ? CircleCheck : CircleDashed;
          return (
            <li key={c.label} className="flex items-start gap-2 text-[12.5px]">
              <Icon className={c.ok ? 'mt-px size-4 shrink-0 text-ok' : 'mt-px size-4 shrink-0 text-na'} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-ink">{c.label}</span> <span className="text-muted">· {c.detail}</span>
              </span>
              <span className="shrink-0 text-ink-2 atlas-num">
                {c.points}/{c.max}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11.5px] text-muted">Score = verified mapping 30 (provisional rule 15, residual 0) + trade 30 + tariff 20 + production 20, capped at 100.</p>

      <div className="mt-4 border-t border-line pt-3">
        <SectionLabel className="mb-2 flex items-center gap-1.5">
          <Factory className="size-3.5" aria-hidden /> Domestic production
        </SectionLabel>
        {p.production.length ? (
          <ul className="space-y-1.5">
            {p.production.map((r, i) => (
              <li key={`${r.year}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
                <span className="font-semibold text-ink">
                  {typeof r.value === 'number' ? (r.unit === 'usd' ? fmtUSD(r.value) : fmtNum(r.value, { unit: r.unit ?? undefined })) : 'Not available'}
                </span>
                <span className="text-muted">
                  {r.label ?? 'Production'}
                  {r.year ? ` · ${r.year}` : ''}
                  {r.source ? ` · ${r.source}` : ''}
                </span>
                <ProvenanceBadge status={r.status} size="xs" className="ml-auto" />
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <ProvenanceBadge status="not_available" size="xs" />
            No official production statistic is linked to this line yet.
          </div>
        )}
      </div>
    </Card>
  );
}
