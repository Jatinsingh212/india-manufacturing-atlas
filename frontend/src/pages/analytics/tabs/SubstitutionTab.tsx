/**
 * Import substitution tab (Opportunity Lab) - GET /api/analytics/import-substitution.
 *
 * Ranked candidates (imports > exports and >= $10 mn, SPEC section 4) with the substitution score,
 * RCA, world-supplier concentration, India's MFN tariff and the PLI / QCO schemes covering them.
 * The chart compares imports with exports for the top candidates (one US$ axis). Officials can tick
 * candidates and open them in the Policy Workbench tariff simulator (`/policy?tab=tariff&codes=`).
 *
 * Primary goods (ores, fuels, unworked stones, precious and unwrought metals; METHODOLOGY 4.5) are left
 * out by the API unless `include_primary=true`. The note above the KPIs reports the `excluded` block and
 * holds the "Include primary goods" toggle, URL-synced as `?primary=include` like the other filters.
 * With the toggle on, rows under the excluded HS prefixes (read from the API's rule text) are tagged.
 */
import { useMemo, useState } from 'react';
import { Calculator, Factory, Pickaxe, Scale, Ship } from 'lucide-react';
import type { AnalyticsFilters, ImportSubstitutionItem } from '@/api/types';
import { Badge, Button, Card, DataTable, EChart, EmptyState, KpiTile, ModelEstimateTag, QueryState, ScoreBar, StatGrid, Toggle, Tooltip, type Column } from '@/components';
import { fmtCode, fmtNum, fmtRate, fmtUSD, NA_SHORT } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useImportSubstitution, type SubstitutionExclusion } from '../api';
import { groupedHBarOption } from '../shared/chart';
import {
  Hs6Code,
  isUnscored,
  ItemMinistry,
  MethodNote,
  MODEL_PROVENANCE,
  ProductText,
  ratio,
  ScoresPendingNote,
  SourceNote,
  sumOrNull,
  TARIFF_PROVENANCE,
  usd,
  useTradeProvenance,
} from '../shared/ui';

const MAX_SIMULATE = 10;

/** URL param of the "Include primary goods" toggle (`?primary=include`). */
const PRIMARY_PARAM = 'primary';
const PRIMARY_ON = 'include';

/** Numeric summary value by key, or null when the backend did not send it. */
function summaryNumber(summary: Record<string, number | string | null>, key: string): number | null {
  const v = summary?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * HS prefixes named in the exclusion rule ("... (HS 26, 2701, 7102 10, ...)"), or [] when the text has
 * another shape. Used only to tag listed rows; the API decides what is excluded.
 */
function rulePrefixes(rule: string | null | undefined): string[] {
  const m = /\(HS ([0-9][0-9 ,]*)\)/.exec(rule ?? '');
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.replace(/\s+/g, ''))
    .filter((s) => /^\d{2,6}$/.test(s));
}

/** The rule sentence without its API hint ("Add include_primary=true to list them."). */
function ruleText(rule: string | null | undefined): string | null {
  const t = (rule ?? '').replace(/\s*Add include_primary=true[^.]*\.?\s*$/i, '').trim();
  return t || null;
}

/**
 * Exclusion note with the "Include primary goods" toggle. Shown whenever the API sends `excluded`, so
 * the toggle stays reachable even when every candidate of a selection is a primary good.
 */
function PrimaryGoodsNote({ excluded, include, onChange }: { excluded: SubstitutionExclusion; include: boolean; onChange: (v: boolean) => void }) {
  const included = excluded.included ?? include;
  const n = typeof excluded.n_products === 'number' ? excluded.n_products : null;
  const imports = typeof excluded.imports === 'number' && excluded.imports > 0 ? excluded.imports : null;
  const prefixes = rulePrefixes(excluded.rule);
  // The prefixes are listed as chips, so the sentence drops its own copy of the list.
  const rule = prefixes.length ? (ruleText(excluded.rule)?.replace(/\s*\(HS [^)]*\)/, '') ?? null) : ruleText(excluded.rule);
  // Nothing to switch when the selection holds no primary goods and they are already left out.
  const showToggle = included || (n ?? 0) > 0;
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-info/40 bg-info-soft px-3.5 py-3 text-[13px] leading-relaxed text-ink" role="note">
      <Pickaxe className="mt-0.5 size-4 shrink-0 text-info-ink" aria-hidden />
      <div className="min-w-0 flex-1 basis-80">
        {included ? (
          <p>
            <span className="font-semibold">Primary goods included</span> — ores, fuels, rough gems and unwrought metals are listed and tagged{' '}
            <i>Primary</i>, although domestic manufacturing cannot substitute them. Turn the toggle off for the manufacturing ranking.
          </p>
        ) : n ? (
          <p>
            <span className="font-semibold">
              {fmtNum(n)} primary good{n === 1 ? '' : 's'} excluded
            </span>{' '}
            — ores, fuels, rough gems, unwrought metals are not substitutable by domestic manufacturing.
            {imports !== null ? <span className="text-ink-2"> They account for {fmtUSD(imports)} of imports in this selection.</span> : null}
          </p>
        ) : (
          <p>
            <span className="font-semibold">No primary goods in this selection.</span> Ores, fuels, rough gems and unwrought metals are left out of the
            ranking by default because domestic manufacturing cannot substitute them.
          </p>
        )}
        {prefixes.length || rule ? (
          <details className="mt-1 text-xs text-ink-2">
            <summary className="cursor-pointer font-medium text-info-ink select-none">Which HS codes count as primary goods</summary>
            {prefixes.length ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {prefixes.map((p) => (
                  <code key={p} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
                    {fmtCode(p)}
                  </code>
                ))}
              </div>
            ) : null}
            {rule ? <p className="mt-1.5">{rule}</p> : null}
          </details>
        ) : null}
      </div>
      {showToggle ? <Toggle checked={include} onChange={onChange} label="Include primary goods" size="sm" className="self-center font-medium text-ink" /> : null}
    </div>
  );
}

function CandidatesChart({ items }: { items: ImportSubstitutionItem[] }) {
  const { mode } = useTheme();
  const top = items.slice(0, 12);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: top.map((r) => `${fmtCode(r.hs6)} ${r.description}`),
        fullLabels: top.map((r) => `HS ${fmtCode(r.hs6)} · ${r.description}`),
        series: [
          { name: 'India imports', values: top.map((r) => r.india_imports), color: CATEGORICAL[mode][1] },
          { name: 'India exports', values: top.map((r) => r.india_exports), color: CATEGORICAL[mode][0] },
        ],
        labelMax: 30,
      }),
    [top, mode],
  );
  return (
    <Card title="Import bill of the top candidates" subtitle="India's imports against its exports for the 12 highest-scoring candidates (US$, latest year)">
      <EChart option={option} height={Math.max(260, top.length * 40 + 40)} ariaLabel="Imports and exports of the top substitution candidates" />
    </Card>
  );
}

export function SubstitutionTab({ filters }: { filters: AnalyticsFilters }) {
  const [primaryParam, setPrimaryParam] = useSearchParamState(PRIMARY_PARAM, '');
  const includePrimary = primaryParam === PRIMARY_ON;
  const q = useImportSubstitution({ ...filters, limit: 200 }, includePrimary);
  const trade = useTradeProvenance();
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : prev.length >= MAX_SIMULATE ? prev : [...prev, code]));
  const setIncludePrimary = (on: boolean) => {
    if (!on) {
      // Primary goods leave the list: drop them from the simulator selection too.
      const prefixes = rulePrefixes(q.data?.excluded?.rule);
      setSelected((prev) => prev.filter((c) => !prefixes.some((p) => c.startsWith(p))));
    }
    setPrimaryParam(on ? PRIMARY_ON : null);
  };

  return (
    <QueryState
      query={q}
      // With primary goods excluded the body still renders, so the note and its toggle stay reachable.
      isEmpty={(d) => d.items.length === 0 && !isUnscored(d) && !(d.excluded?.n_products || d.excluded?.included)}
      emptyTitle="No substitution candidates in this selection"
      emptyMessage="Candidates need imports above exports and at least $10 mn of imports."
    >
      {(d) => {
        const note = d.excluded ? <PrimaryGoodsNote excluded={d.excluded} include={includePrimary} onChange={setIncludePrimary} /> : null;
        if (!d.items.length) {
          if (isUnscored(d)) {
            // The candidate list is defined by the substitution score: none can be listed until scores exist.
            return (
              <div className="space-y-4">
                {note}
                <ScoresPendingNote response={d} what="Substitution scores" />
                <EmptyState icon={Factory} title="No substitution candidates to list yet" message="Candidates are ranked by the substitution score, which is not available in the current data build." />
              </div>
            );
          }
          return (
            <div className="space-y-4">
              {note}
              <EmptyState
                icon={Factory}
                title="No manufactured substitution candidates in this selection"
                message="Every product here with imports above exports and at least $10 mn of imports is a primary good. Turn on “Include primary goods” to list them."
              />
            </div>
          );
        }
        const primaryPrefixes = includePrimary ? rulePrefixes(d.excluded?.rule) : [];
        const isPrimary = (hs6: string) => primaryPrefixes.some((p) => hs6.startsWith(p));
        const items = [...d.items].sort((a, b) => (b.substitution_score ?? -1) - (a.substitution_score ?? -1) || (b.india_imports ?? -1) - (a.india_imports ?? -1));
        const totalImports = summaryNumber(d.summary, 'total_imports') ?? sumOrNull(items.map((i) => i.india_imports));
        const nProducts = summaryNumber(d.summary, 'n_products') ?? items.length;
        const coveredAll = summaryNumber(d.summary, 'n_with_scheme');
        const covered = coveredAll ?? items.filter((i) => i.schemes?.length).length;
        const gap = summaryNumber(d.summary, 'net_imports') ?? sumOrNull(items.map((i) => (i.india_imports ?? 0) - (i.india_exports ?? 0)));
        const scopeNote = d.excluded ? (d.excluded.included ? ' · incl. primary goods' : ' · primary goods excluded') : '';

        const columns: Column<ImportSubstitutionItem>[] = [
          {
            key: 'pick',
            header: <span className="sr-only">Select for tariff simulation</span>,
            csv: false,
            width: 36,
            render: (r) => {
              const on = selected.includes(r.hs6);
              return (
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-[var(--atlas-brand)]"
                  checked={on}
                  disabled={!on && selected.length >= MAX_SIMULATE}
                  onChange={() => toggle(r.hs6)}
                  aria-label={`Select ${r.hs6} for the tariff simulator`}
                />
              );
            },
          },
          { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 96 },
          {
            key: 'product',
            header: 'Product',
            value: (r) => r.description,
            render: (r) =>
              isPrimary(r.hs6) ? (
                <div className="flex min-w-0 items-start gap-1.5">
                  <Tooltip content="Primary good: extracted or refined from imported raw material, not substitutable by domestic manufacturing.">
                    <Badge tone="info" size="xs" icon={Pickaxe}>
                      Primary
                    </Badge>
                  </Tooltip>
                  <ProductText text={r.description} />
                </div>
              ) : (
                <ProductText text={r.description} />
              ),
            width: '24%',
          },
          { key: 'ministry', header: 'Ministry', value: (r) => r.ministry_short, render: (r) => <ItemMinistry id={r.ministry_id} short={r.ministry_short} />, hideBelow: 'xl' },
          { key: 'imports', header: 'Imports', align: 'right', value: (r) => r.india_imports, render: (r) => usd(r.india_imports) },
          { key: 'exports', header: 'Exports', align: 'right', value: (r) => r.india_exports, render: (r) => usd(r.india_exports), hideBelow: 'md' },
          { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => ratio(r.rca), hint: 'Existing comparative advantage to build on (capped at 1 inside the score).' },
          {
            key: 'hhi',
            header: 'Supplier HHI',
            align: 'right',
            value: (r) => r.world_supplier_hhi,
            render: (r) => ratio(r.world_supplier_hhi),
            hint: 'Herfindahl index of world exporters (0–1). Lower values mean more alternative suppliers and technology sources.',
            hideBelow: 'lg',
          },
          { key: 'mfn', header: 'MFN tariff', align: 'right', value: (r) => r.mfn_tariff, render: (r) => fmtRate(r.mfn_tariff, { na: NA_SHORT }), hint: 'India MFN applied tariff, HS6 simple average (WITS 2022).' },
          {
            key: 'score',
            header: 'Score',
            value: (r) => r.substitution_score,
            render: (r) => <ScoreBar value={r.substitution_score} width={64} />,
            hint: '0–100 model score: 40% import size percentile, 30% RCA (capped at 1), 30% openness of world supply (1 − HHI).',
            firstSort: 'desc',
            width: 130,
          },
          {
            key: 'schemes',
            header: 'Schemes',
            value: (r) => (r.schemes ?? []).map((s) => s.name).join('; '),
            render: (r) =>
              r.schemes?.length ? (
                <div className="flex flex-wrap gap-1">
                  {r.schemes.slice(0, 2).map((s) => (
                    <Tooltip key={s.id} content={s.name}>
                      <Badge tone={s.kind === 'PLI' ? 'brand' : 'info'} size="xs">
                        {s.kind}
                      </Badge>
                    </Tooltip>
                  ))}
                  {r.schemes.length > 2 ? <span className="text-[11px] text-muted">+{r.schemes.length - 2}</span> : null}
                </div>
              ) : (
                <span className="text-muted">{NA_SHORT}</span>
              ),
            hideBelow: 'md',
          },
        ];

        return (
          <div className="space-y-6">
            {note}
            <StatGrid cols={4}>
              <KpiTile label="Substitution candidates" value={fmtNum(nProducts)} icon={Factory} accent="ink" sub={`Imports > exports and ≥ $10 mn${scopeNote}`} provenance={trade} />
              <KpiTile label="Import bill of candidates" value={totalImports === null ? null : fmtUSD(totalImports)} icon={Ship} provenance={trade} />
              <KpiTile label="Net import gap" value={gap === null ? null : fmtUSD(gap)} icon={Scale} accent="brand" sub="Imports minus exports" provenance={trade} />
              <KpiTile
                label="Covered by a PLI / QCO scheme"
                value={fmtNum(covered)}
                icon={Calculator}
                accent="brand"
                provenance={MODEL_PROVENANCE}
                sub={`of ${fmtNum(coveredAll === null ? items.length : nProducts)} candidates${coveredAll === null ? ' shown' : ''} · indicative HS coverage`}
              />
            </StatGrid>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <CandidatesChart items={items} />
              <MethodNote method="Substitution score (SPEC section 4)" className="self-start">
                <p>
                  The <b>substitution score</b> ranks products India imports more than it exports (at least $10 mn of imports) by the size of
                  the import bill, the comparative advantage India already shows (RCA, capped at 1) and how open world supply is (1 − HHI of
                  world exporters), so that capability and technology can be sourced.
                </p>
                <p className="mt-2">
                  The formula cannot tell whether a manufacturing path exists, so primary goods (ores, fuels, rough gems, precious and unwrought
                  metals) are left out of the ranking unless you include them; their scores stay on their product pages.
                </p>
                <p className="mt-2">
                  Tick up to {MAX_SIMULATE} candidates and open them in the tariff simulator to test a BCD change, its import response and
                  the cost passed to downstream users.
                </p>
              </MethodNote>
            </div>

            <Card
              title="Ranked substitution candidates"
              subtitle="Highest substitution score first. Schemes show the PLI or QCO measures whose product coverage includes the line."
              actions={
                <>
                  <ModelEstimateTag method="Substitution score (SPEC section 4)" />
                  <Button
                    size="sm"
                    variant="primary"
                    icon={Calculator}
                    disabled={!selected.length}
                    to={selected.length ? `${routes.policy('tariff')}&codes=${selected.join(',')}` : undefined}
                  >
                    Simulate tariff{selected.length ? ` (${selected.length})` : ''}
                  </Button>
                </>
              }
              footer={<SourceNote provenances={[trade, TARIFF_PROVENANCE, MODEL_PROVENANCE]} />}
            >
              <DataTable
                columns={columns}
                rows={items}
                rowKey={(r) => r.hs6}
                isRowSelected={(r) => selected.includes(r.hs6)}
                defaultSort={{ key: 'score', order: 'desc' }}
                csvFilename="atlas-import-substitution"
                dense
                toolbar={
                  selected.length ? (
                    <span className="text-xs text-muted">
                      {selected.length} selected for simulation{' '}
                      <button type="button" className="ml-1 text-brand-ink hover:underline" onClick={() => setSelected([])}>
                        Clear
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Tick rows to compare them in the tariff simulator.</span>
                  )
                }
              />
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}
