/**
 * ProductionCard - "Domestic production" on the ministry and sector dashboards.
 *
 * Data: `production[]` of GET /api/ministries/{id} and /api/sectors/{id} (SPEC 6.4): one row per
 * (scope, key, measure), chosen by the shared rule (verified first, then latest year, then newest row), for
 * the curated chains the entity takes part in (scope 'chain') and for HS codes under its products (hsn8 /
 * hs6 / hs4). `provenance.production` is the card's summary badge.
 *
 * Each figure is a small tile: measure, value + unit, its own provenance badge, a link to the chain
 * deep-dive or the product, and the reference year. No figure -> an honest "Not available" with the way to
 * fix it (ministries upload production figures in the Data Hub). Nothing is estimated or filled in.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronUp, Factory, Upload, Workflow } from 'lucide-react';
import type { EntityProductionRow, EntityValueChain, OptionalSourceProvenance, Provenance } from '@/api/types';
import { Button, Card, CodeLink, EmptyState, ProvenanceBadge, Tooltip } from '@/components';
import { humanize, plural } from '@/lib/format';
import { routes } from '@/lib/routes';
import { fmtKpiValue } from '@/pages/valuechains/utils';
import type { EntityKind } from '../api';
import { LabelledProvenance } from './LabelledProvenance';

const MEASURES: Record<string, string> = {
  india_production: 'India’s production',
  india_output: 'India’s output',
  global_production: 'Global production',
};

/** India's own output first; global output is context. */
const MEASURE_ORDER: Record<string, number> = { india_production: 0, india_output: 0, global_production: 1 };

/** Tiles shown before "Show all". */
const LIMIT = 6;

function measureLabel(label: string | null): string {
  if (!label) return 'Production';
  return MEASURES[label] ?? humanize(label);
}

/** What the figure covers: the chain title for chain rows, the product description for code rows. */
function coversLabel(r: EntityProductionRow): string {
  const d = (r.display_label ?? '').trim();
  if (r.scope === 'chain') {
    const i = d.indexOf(' - ');
    return i >= 0 ? d.slice(i + 3) : d || r.key;
  }
  // "<description> (HSN8 40111010)" -> "<description>"
  return d.replace(/\s*\((?:HSN8|HS6|HS4)\s+\d+\)\s*$/i, '') || `HS ${r.key}`;
}

/** Card-level provenance with a citable source (null source = nothing to cite). */
function summaryProvenance(p: OptionalSourceProvenance | null | undefined, rows: EntityProductionRow[]): Provenance {
  if (p) return { ...p, source: p.source ?? rows[0]?.source ?? '' };
  return rows.length
    ? {
        source: rows[0]?.source ?? 'manual',
        status: rows[0]?.status === 'verified' ? 'verified' : rows[0]?.status === 'not_available' ? 'not_available' : 'not_verified',
        label: 'Production figures',
        year: rows[0]?.year ?? null,
      }
    : { source: '', status: 'not_available', label: 'Not available - upload figures through the Data Hub', year: null };
}

export interface ProductionCardProps {
  kind: EntityKind;
  /** Rows from the dashboard (undefined = an older API without the field: shown as not available). */
  rows: EntityProductionRow[] | undefined;
  provenance: OptionalSourceProvenance | null | undefined;
  /** The dashboard's chains, for ordering and chain names. */
  chains: EntityValueChain[];
  className?: string;
}

export function ProductionCard({ kind, rows: input, provenance, chains, className }: ProductionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => {
    const chainRank = new Map(chains.map((c, i) => [c.chain_id, i]));
    const statusRank = (s: string) => (s === 'verified' ? 0 : s === 'not_verified' ? 1 : 2);
    return [...(input ?? [])].sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        Number(a.scope !== 'chain') - Number(b.scope !== 'chain') ||
        (chainRank.get(a.key) ?? 99) - (chainRank.get(b.key) ?? 99) ||
        coversLabel(a).localeCompare(coversLabel(b)) ||
        (MEASURE_ORDER[a.label ?? ''] ?? 2) - (MEASURE_ORDER[b.label ?? ''] ?? 2),
    );
  }, [input, chains]);
  const prov = summaryProvenance(provenance, rows);
  const shown = expanded ? rows : rows.slice(0, LIMIT);
  const owner = kind === 'ministry' ? 'ministry' : 'sector';

  return (
    <Card
      className={className}
      padding="sm"
      icon={Factory}
      title="Domestic production"
      subtitle={`Output of the value chains and products this ${owner} covers, with global output for context where a source gives it`}
      actions={<ProvenanceBadge provenance={prov} size="xs" />}
      footer={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <LabelledProvenance label="Production" provenance={prov} />
          <span>
            {rows.length
              ? 'One figure per measure: verified figures first, then the latest year. '
              : ''}
            Ministries can upload official production figures in the{' '}
            <Link to={routes.dataHub('uploads')} className="font-medium text-brand-ink hover:underline">
              Data Hub
            </Link>
            .
          </span>
        </span>
      }
    >
      {rows.length ? (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Domestic production figures">
            {shown.map((r) => (
              <ProductionTile key={`${r.scope}|${r.key}|${r.label ?? ''}`} row={r} chains={chains} />
            ))}
          </ul>
          {rows.length > LIMIT ? (
            <Button variant="link" size="xs" className="mt-2" iconRight={expanded ? ChevronUp : ChevronDown} onClick={() => setExpanded((e) => !e)}>
              {expanded ? `Show first ${LIMIT}` : `Show all ${rows.length} figures`}
            </Button>
          ) : null}
        </>
      ) : (
        <EmptyState
          compact
          icon={Factory}
          title="Not available"
          message={`No production data source yet for this ${owner}'s products; ministries can upload production figures in Data Hub.`}
          action={
            <Button to={routes.dataHub('uploads')} size="sm" variant="secondary" icon={Upload}>
              Open Data Hub uploads
            </Button>
          }
        />
      )}
    </Card>
  );
}

function ProductionTile({ row: r, chains }: { row: EntityProductionRow; chains: EntityValueChain[] }) {
  const text = r.value === null ? null : fmtKpiValue(r.value, r.unit);
  // physical units keep the number large and the unit small (as on the chain KPI strip)
  const m = text ? /^(.*\S)\s+(tonnes|units)$/.exec(text) : null;
  const chainId = r.scope === 'chain' ? (r.chain_id ?? r.key) : null;
  const chainName = chainId ? chains.find((c) => c.chain_id === chainId)?.name : null;
  const covers = coversLabel(r);
  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-line p-3">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] leading-5 font-medium text-ink-2">{measureLabel(r.label)}</span>
        <ProvenanceBadge provenance={r.provenance} status={r.status} size="xs" className="shrink-0" />
      </div>
      <div className={text ? 'mt-1 text-[22px] leading-none font-bold tracking-tight text-kpi' : 'mt-1 text-[15px] font-medium text-na-ink'}>
        {text ? (
          <>
            {m ? m[1] : text}
            {m ? <span className="ml-1 text-[13px] font-semibold">{m[2]}</span> : null}
          </>
        ) : (
          'Not available'
        )}
      </div>
      <div className="mt-2 min-w-0 text-xs">
        {chainId ? (
          <Link to={routes.valueChain(chainId)} className="inline-flex max-w-full items-center gap-1.5 font-medium text-brand-ink hover:underline" title={`Open the ${chainName ?? covers} value chain`}>
            <Workflow className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{covers}</span>
          </Link>
        ) : (
          <span className="flex min-w-0 items-baseline gap-2">
            <CodeLink code={r.key} className="shrink-0" />
            <span className="min-w-0 truncate text-ink-2" title={covers}>
              {covers}
            </span>
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
        <span>{r.year ? `Year ${r.year}` : 'Reference year not stated'}</span>
        {r.n_rows > 1 ? (
          <Tooltip content="Several figures exist for this measure; the shown one is chosen by the shared rule: verified first, then the latest year, then the newest row.">
            <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">chosen from {plural(r.n_rows, 'figure')}</span>
          </Tooltip>
        ) : null}
      </div>
    </li>
  );
}
