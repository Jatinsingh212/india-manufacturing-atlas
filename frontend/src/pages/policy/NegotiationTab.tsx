/**
 * Trade negotiations tab (Policy Workbench, GOV) - GET /api/policy/agreements (public) and
 * GET /api/policy/negotiation?agreement=|partner= (GOV).
 *
 * Choose an FTA / CEPA (or any partner country). The analyser returns bilateral KPIs, India's top
 * exports to and imports from the partner(s), and two interest lists (SPEC 6.7):
 * - offensive: India RCA >= 1 and partner imports >= $5 mn; gap = India's world share x partner
 *   imports − India's exports to the partner (export upside if India reached its world share there);
 * - defensive: India imports from the partner >= $5 mn where the partner is competitive (RCA >= 1)
 *   and India has capability (RCA >= 0.5) or a PLI scheme to protect.
 * A plain-language brief summarises the result. `?agreement=` / `?partner=` keep the selection.
 */
import { useEffect, useMemo } from 'react';
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Handshake, Scale, Shield, Swords } from 'lucide-react';
import { useAgreements, useCountries } from '@/api/hooks';
import type { BilateralFlowItem, DefensiveInterest, NegotiationResponse, OffensiveInterest, TradeAgreement } from '@/api/types';
import { Badge, Button, Card, DataTable, EChart, EmptyState, KpiTile, ModelEstimateTag, QueryState, SegmentedControl, Select, StatGrid, type Column } from '@/components';
import { fmtCode, fmtNum, fmtRate, fmtUSD, humanize, NA_SHORT, truncate } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { groupedHBarOption } from '../analytics/shared/chart';
import { Hs6Code, MethodNote, MODEL_PROVENANCE, ProductText, ratio, SourceNote, TARIFF_PROVENANCE, usd, useTradeProvenance } from '../analytics/shared/ui';
import { useNegotiation } from './api';
import { shortSchemeName } from './schemeShared';

const STATUS_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  in_force: 'success',
  signed: 'info',
  negotiating: 'warning',
  under_negotiation: 'warning',
};

/** Interest rows as sent by the API: SPEC shapes plus a sample 8-digit line (product link) and, for defensive lines, the PLI schemes covering them. */
type OffensiveRow = OffensiveInterest & { hsn8_sample?: string | null };
type DefensiveRow = DefensiveInterest & { hsn8_sample?: string | null; pli_schemes?: string[] | null };

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{humanize(status)}</Badge>;
}

/**
 * Two-line column header. DataTable headers never wrap, so the long money headers ("Partner imports
 * (world)") are split here; otherwise the seven-column interest tables overflow the main column at
 * 1280px and push the ranking column out of view. The CSV keeps the one-line text.
 */
function stacked(top: string, bottom: string): Pick<Column<unknown>, 'header' | 'csvHeader'> {
  return {
    header: (
      <span className="leading-tight">
        {top}
        <br />
        {bottom}
      </span>
    ),
    csvHeader: `${top} ${bottom}`,
  };
}

function AgreementsOverview({ agreements, onPick }: { agreements: TradeAgreement[]; onPick: (id: string) => void }) {
  const trade = useTradeProvenance();
  const columns: Column<TradeAgreement>[] = [
    {
      key: 'name',
      header: 'Agreement',
      value: (r) => r.name,
      render: (r) => (
        <div className="min-w-56">
          <div className="font-medium text-ink">{r.short_name ?? r.name}</div>
          {r.short_name ? <div className="text-[12px] text-muted">{r.name}</div> : null}
        </div>
      ),
    },
    { key: 'status', header: 'Status', value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'year', header: 'Year', align: 'right', value: (r) => r.year, render: (r) => (r.year ? String(r.year) : NA_SHORT) },
    { key: 'partners', header: 'Partners', align: 'right', value: (r) => r.partners.length, hideBelow: 'md' },
    { key: 'exports', ...stacked('India exports', 'to partners'), align: 'right', value: (r) => r.india_exports_to, render: (r) => usd(r.india_exports_to) },
    { key: 'imports', ...stacked('India imports', 'from partners'), align: 'right', value: (r) => r.india_imports_from, render: (r) => usd(r.india_imports_from) },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      value: (r) => (r.india_exports_to === null || r.india_imports_from === null ? null : r.india_exports_to - r.india_imports_from),
      render: (r) =>
        r.india_exports_to === null || r.india_imports_from === null ? NA_SHORT : fmtUSD(r.india_exports_to - r.india_imports_from, { signed: true }),
      hideBelow: 'lg',
    },
  ];
  return (
    <Card
      title="India's trade agreements"
      subtitle="Bilateral goods trade with each agreement's partners (US$, latest year). Select a row to analyse it."
      footer={<SourceNote provenances={[trade]}>Agreement facts compiled from public Department of Commerce sources.</SourceNote>}
    >
      <DataTable
        columns={columns}
        rows={agreements}
        rowKey={(r) => r.id}
        onRowClick={(r) => onPick(r.id)}
        defaultSort={{ key: 'exports', order: 'desc' }}
        pagination={false}
        dense
        // Narrow cell padding: all seven columns (through Balance) fit the main column at 1280px.
        tight
        csvFilename="atlas-trade-agreements"
      />
    </Card>
  );
}

function FlowBars({ title, items, color }: { title: string; items: BilateralFlowItem[]; color: string }) {
  const top = useMemo(() => [...items].sort((x, y) => (y.value ?? 0) - (x.value ?? 0)).slice(0, 10), [items]);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: top.map((r) => `${fmtCode(r.hs6)} ${r.description}`),
        fullLabels: top.map((r) => `HS ${fmtCode(r.hs6)} · ${r.description}`),
        series: [{ name: title, values: top.map((r) => r.value), color }],
        labelMax: 30,
      }),
    [top, title, color],
  );
  return (
    <Card title={title} subtitle="Top 10 HS6 products (US$, latest year)">
      {top.length ? <EChart option={option} height={Math.max(220, top.length * 30 + 20)} ariaLabel={title} /> : <EmptyState compact title="No bilateral flows recorded" />}
    </Card>
  );
}

function Brief({ d, label }: { d: NegotiationResponse; label: string }) {
  const b = d.bilateral;
  const topOff = [...d.offensive].sort((x, y) => (y.gap_usd ?? 0) - (x.gap_usd ?? 0)).slice(0, 3);
  const topDef = [...d.defensive].sort((x, y) => (y.india_imports_from_partner ?? 0) - (x.india_imports_from_partner ?? 0)).slice(0, 3);
  return (
    <Card title="Negotiation brief" subtitle="Generated from the figures on this page" icon={Handshake} actions={<ModelEstimateTag method="Offensive gap and defensive screening rules (SPEC 6.7)" />}>
      <ul className="list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-2">
        <li>
          India exported <b className="text-ink">{fmtUSD(b.india_exports_to)}</b> to {label} and imported <b className="text-ink">{fmtUSD(b.india_imports_from)}</b>
          {b.balance !== null ? (
            <>
              , a {b.balance >= 0 ? 'surplus' : 'deficit'} of <b className="text-ink">{fmtUSD(Math.abs(b.balance))}</b>
            </>
          ) : null}
          .
        </li>
        <li>
          <b className="text-ink">{fmtNum(d.summary.n_offensive)}</b> offensive interests where India is competitive and the partner imports at scale, with an
          estimated export gap of <b className="text-ink">{fmtUSD(d.summary.total_gap_usd)}</b>
          {topOff.length ? <> — led by {topOff.map((o) => `${truncate(o.description, 60)} (HS ${fmtCode(o.hs6)})`).join('; ')}</> : null}.
        </li>
        <li>
          <b className="text-ink">{fmtNum(d.summary.n_defensive)}</b> defensive lines where the partner is competitive in products India also makes or
          supports through PLI
          {topDef.length ? <> — largest {topDef.map((o) => `${truncate(o.description, 60)} (HS ${fmtCode(o.hs6)})`).join('; ')}</> : null}.
        </li>
      </ul>
    </Card>
  );
}

function NegotiationBody({ d, label }: { d: NegotiationResponse; label: string }) {
  const { mode } = useTheme();
  const trade = useTradeProvenance();
  const b = d.bilateral;

  const offCols: Column<OffensiveRow>[] = [
    { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 92 },
    { key: 'product', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '30%' },
    { key: 'pimp', ...stacked('Partner imports', '(world)'), align: 'right', value: (r) => r.partner_imports_world, render: (r) => usd(r.partner_imports_world) },
    { key: 'iexp', ...stacked('India exports', 'to partner'), align: 'right', value: (r) => r.india_exports_to_partner, render: (r) => usd(r.india_exports_to_partner) },
    { key: 'rca', header: 'India RCA', align: 'right', value: (r) => r.india_rca, render: (r) => ratio(r.india_rca), hideBelow: 'md' },
    { key: 'mfn', header: 'India MFN', align: 'right', value: (r) => r.india_mfn, render: (r) => fmtRate(r.india_mfn, { na: NA_SHORT }), hideBelow: 'lg' },
    {
      key: 'gap',
      header: 'Export gap',
      align: 'right',
      value: (r) => r.gap_usd,
      render: (r) => <span className="font-semibold">{usd(r.gap_usd)}</span>,
      hint: "India's world market share × partner imports − India's current exports to the partner. Model estimate.",
      firstSort: 'desc',
    },
  ];
  const defCols: Column<DefensiveRow>[] = [
    { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 92 },
    { key: 'product', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '28%' },
    { key: 'imp', ...stacked('India imports', 'from partner'), align: 'right', value: (r) => r.india_imports_from_partner, render: (r) => usd(r.india_imports_from_partner), firstSort: 'desc' },
    { key: 'prca', header: 'Partner RCA', align: 'right', value: (r) => r.partner_rca, render: (r) => ratio(r.partner_rca) },
    { key: 'irca', header: 'India RCA', align: 'right', value: (r) => r.india_rca, render: (r) => ratio(r.india_rca), hideBelow: 'md' },
    { key: 'mfn', header: 'India MFN', align: 'right', value: (r) => r.india_mfn, render: (r) => fmtRate(r.india_mfn, { na: NA_SHORT }), hideBelow: 'lg' },
    {
      key: 'reason',
      header: 'Why defensive',
      value: (r) => r.reason,
      render: (r) => {
        // The reason usually names the PLI scheme already; badge only the schemes it leaves out.
        const extra = (r.pli_schemes ?? []).filter((name) => !r.reason?.includes(name));
        return (
          <div className="min-w-40">
            <span className="text-[12.5px] text-ink-2">{r.reason}</span>
            {extra.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {extra.slice(0, 2).map((name) => (
                  <Badge key={name} tone="brand" size="xs" title={name}>
                    PLI: {truncate(shortSchemeName(name), 28)}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        );
      },
      csv: (r) => [r.reason, ...(r.pli_schemes ?? [])].join('; '),
      hideBelow: 'md',
    },
  ];

  return (
    <div className="space-y-6">
      <StatGrid cols={5}>
        <KpiTile label={`India exports to ${label}`} value={b.india_exports_to === null ? null : fmtUSD(b.india_exports_to)} icon={ArrowUpRight} accent="brand" provenance={trade} />
        <KpiTile label={`India imports from ${label}`} value={b.india_imports_from === null ? null : fmtUSD(b.india_imports_from)} icon={ArrowDownLeft} provenance={trade} />
        <KpiTile label="Trade balance" value={b.balance === null ? null : fmtUSD(b.balance, { signed: true })} icon={Scale} accent={(b.balance ?? 0) >= 0 ? 'ok' : 'bad'} provenance={trade} />
        <KpiTile label="Offensive interests" value={fmtNum(d.summary.n_offensive)} icon={Swords} accent="ink" sub={`Export gap ${fmtUSD(d.summary.total_gap_usd)}`} provenance={MODEL_PROVENANCE} />
        <KpiTile label="Defensive interests" value={fmtNum(d.summary.n_defensive)} icon={Shield} accent="ink" provenance={MODEL_PROVENANCE} />
      </StatGrid>

      <Brief d={d} label={label} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <FlowBars title={`India's top exports to ${label}`} items={b.top_exports} color={CATEGORICAL[mode][0]} />
        <FlowBars title={`India's top imports from ${label}`} items={b.top_imports} color={CATEGORICAL[mode][1]} />
      </div>

      <Card
        title="Offensive interests: where to seek market access"
        subtitle="India is competitive (RCA ≥ 1) and the partner imports at least $5 mn from the world; ranked by the export gap"
        icon={Swords}
        actions={<ModelEstimateTag method="Offensive gap (SPEC 6.7)" />}
        footer={<SourceNote provenances={[trade, TARIFF_PROVENANCE, MODEL_PROVENANCE]} />}
      >
        {/* `tight` + the stacked headers above keep the ranking column (Export gap) inside the card at 1280px. */}
        <DataTable columns={offCols} rows={d.offensive as OffensiveRow[]} rowKey={(r) => r.hs6} defaultSort={{ key: 'gap', order: 'desc' }} dense tight csvFilename="atlas-offensive-interests" emptyTitle="No offensive interests meet the thresholds" />
      </Card>

      <Card
        title="Defensive interests: where to protect domestic capability"
        subtitle="India imports at least $5 mn from the partner, the partner is competitive (RCA ≥ 1), and India has capability (RCA ≥ 0.5) or PLI support"
        icon={Shield}
        footer={<SourceNote provenances={[trade, TARIFF_PROVENANCE]} />}
      >
        <DataTable columns={defCols} rows={d.defensive as DefensiveRow[]} rowKey={(r) => r.hs6} defaultSort={{ key: 'imp', order: 'desc' }} dense tight csvFilename="atlas-defensive-interests" emptyTitle="No defensive lines meet the thresholds" />
      </Card>
    </div>
  );
}

export function NegotiationTab() {
  const agreements = useAgreements();
  const countries = useCountries();
  const [by, setBy] = useSearchParamState('by', 'agreement');
  const [agreementId, setAgreementId] = useSearchParamState('agreement', '');
  const [partnerId, setPartnerId] = useSearchParamState('partner', '');
  const byPartner = by === 'partner';
  // Ask the analyser only for ids the loaded lists contain, so a stale link never fires a 404 (if a list
  // cannot be loaded, the id is sent as is and the analyser's own error is shown).
  const knownPartner = Boolean(partnerId && (countries.isError || countries.data?.some((c) => c.id === partnerId)));
  const knownAgreement = Boolean(agreementId && (agreements.isError || agreements.data?.some((a) => a.id === agreementId)));
  const params = byPartner ? { partner: knownPartner ? partnerId : undefined } : { agreement: knownAgreement ? agreementId : undefined };
  const q = useNegotiation(params);

  const agreement = agreements.data?.find((a) => a.id === agreementId) ?? null;

  // Drop a stale `?agreement=` / `?partner=` (e.g. from an old link) once the lists have loaded.
  useEffect(() => {
    if (agreementId && agreements.data?.length && !agreements.data.some((a) => a.id === agreementId)) setAgreementId(null);
  }, [agreementId, agreements.data, setAgreementId]);
  useEffect(() => {
    if (partnerId && countries.data?.length && !countries.data.some((c) => c.id === partnerId)) setPartnerId(null);
  }, [partnerId, countries.data, setPartnerId]);
  const countryOptions = useMemo(
    () =>
      (countries.data ?? [])
        .filter((c) => c.iso3 !== 'IND')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ value: c.id, label: c.name })),
    [countries.data],
  );
  const agreementOptions = useMemo(
    () => (agreements.data ?? []).map((a) => ({ value: a.id, label: `${a.short_name ? `${a.short_name} — ` : ''}${a.name} (${humanize(a.status).toLowerCase()})` })),
    [agreements.data],
  );
  const partnerName = countryOptions.find((c) => c.value === partnerId)?.label ?? partnerId;
  // A single partner's name reads better than the agreement name in "India exports to ...".
  const label = byPartner
    ? partnerName
    : agreement?.partners.length === 1
      ? agreement.partners[0].name
      : `${agreement?.short_name ?? agreement?.name ?? 'the agreement'} partners`;
  const chosen = byPartner ? Boolean(partnerId) : Boolean(agreementId);

  return (
    <div className="space-y-6">
      <Card padding="sm">
        <div className="flex flex-wrap items-center gap-3 px-1">
          <SegmentedControl
            value={byPartner ? 'partner' : 'agreement'}
            onChange={(v) => setBy(v)}
            ariaLabel="Analyse by"
            options={[
              { value: 'agreement', label: 'By agreement' },
              { value: 'partner', label: 'By partner country' },
            ]}
          />
          {byPartner ? (
            <Select size="sm" className="w-full sm:w-72" value={partnerId} onChange={(v) => setPartnerId(v)} options={countryOptions} placeholder="Choose a partner country" aria-label="Partner country" />
          ) : (
            <Select size="sm" className="w-full sm:w-[28rem]" value={agreementId} onChange={(v) => setAgreementId(v)} options={agreementOptions} placeholder="Choose an agreement" aria-label="Trade agreement" />
          )}
          {chosen ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (byPartner ? setPartnerId(null) : setAgreementId(null))}
            >
              Back to all agreements
            </Button>
          ) : null}
        </div>
      </Card>

      {!byPartner && agreement ? (
        <Card padding="md">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={agreement.status} />
                {agreement.year ? <span className="text-xs text-muted">Since {agreement.year}</span> : null}
              </div>
              <h3 className="mt-1.5 text-[16px] font-bold text-ink">{agreement.name}</h3>
              {agreement.notes ? <p className="mt-1 text-[13px] text-ink-2">{agreement.notes}</p> : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {agreement.partners.map((p) => (
                  <Badge key={p.id} tone="outline" size="sm">
                    {p.name}
                  </Badge>
                ))}
              </div>
            </div>
            {agreement.url ? (
              <Button href={agreement.url} size="sm" icon={ExternalLink}>
                Agreement text
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {!chosen ? (
        byPartner ? (
          <EmptyState icon={Handshake} title="Choose a partner country" message="Pick any country to see offensive and defensive interests for a prospective agreement." />
        ) : (
          <QueryState query={agreements} isEmpty={(d) => d.length === 0} emptyTitle="No agreements are loaded" roles="gov">
            {(list) => <AgreementsOverview agreements={list} onPick={(id) => setAgreementId(id)} />}
          </QueryState>
        )
      ) : (
        <QueryState query={q} loadingLabel="Analysing bilateral trade…" roles="gov">
          {(d) => <NegotiationBody d={d} label={label} />}
        </QueryState>
      )}

      <MethodNote method="Offensive and defensive screening (SPEC 6.7)">
        <b>Offensive</b> lines are products where India is competitive (RCA ≥ 1) and the partner imports at least $5 mn; the <b>export gap</b> is what
        India would sell if it held its world market share in the partner's imports. <b>Defensive</b> lines are imports from the partner of at least
        $5 mn where the partner is competitive and India has capability (RCA ≥ 0.5) or supports the product through a PLI scheme. Tariff
        concessions on defensive lines deserve care; offensive lines are where to ask for access, rules of origin and NTB relief.
      </MethodNote>
    </div>
  );
}
