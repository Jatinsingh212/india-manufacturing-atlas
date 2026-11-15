/**
 * Component gallery - DEVELOPMENT ONLY (route /_dev/components, registered only when
 * `import.meta.env.DEV` or VITE_ATLAS_GALLERY=1). A living reference for page builders: every
 * foundation component rendered with illustrative values. The numbers here are layout samples, not
 * Atlas data, and the route is never part of a production build.
 */
import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { ChartColumn, Download, Hash, Landmark, Layers, Search, ShieldAlert, Sparkles, TrendingUp } from 'lucide-react';
import type { CountryValue, NetworkEdge, NetworkNode } from '@/api/types';
import { DemoLoginButtons, RequireRole } from '@/auth/RequireRole';
import {
  ArchetypeBadge,
  Badge,
  Button,
  Card,
  CodeLink,
  CountryBars,
  DataTable,
  DownloadMenu,
  Drawer,
  EChart,
  EmptyState,
  ErrorState,
  FormField,
  HsnSearchBox,
  KeyValueList,
  KpiTile,
  LoadingBlock,
  Markdown,
  MinistryPill,
  Modal,
  ModelEstimateTag,
  NetworkGraph,
  PageHeader,
  ProvenanceBadge,
  ProvenanceDot,
  ProvenanceLegend,
  ScoreBar,
  SearchInput,
  SectorPill,
  SegmentedControl,
  Select,
  Sparkline,
  StatGrid,
  Tabs,
  TextArea,
  TextInput,
  Toggle,
  Tooltip,
  useToast,
  type Column,
} from '@/components';
import { ApiError } from '@/api/client';
import { fmtNum, fmtPct, fmtUSD, NA_SHORT } from '@/lib/format';
import { ministryColor } from '@/lib/theme';

const SAMPLE_NOTE = 'Illustrative sample values for layout preview - not Atlas data.';

interface SampleRow {
  code: string;
  label: string;
  ministry: string;
  exports: number | null;
  imports: number | null;
  rca: number | null;
}

const ROWS: SampleRow[] = [
  { code: '61091000', label: 'Sample line A', ministry: 'mot', exports: 1.2e9, imports: 8.0e7, rca: 1.4 },
  { code: '40111010', label: 'Sample line B', ministry: 'dpiit', exports: 2.5e8, imports: 4.0e7, rca: 1.1 },
  { code: '29420090', label: 'Sample line C', ministry: 'dcpc', exports: null, imports: 3.3e8, rca: 0.4 },
  { code: '85171300', label: 'Sample line D', ministry: 'meity', exports: 9.1e9, imports: 2.2e9, rca: 2.3 },
  { code: '30049099', label: 'Sample line E', ministry: 'dop', exports: 6.4e9, imports: 1.1e9, rca: null },
];

const COUNTRIES: CountryValue[] = [
  { country_id: 'aschn', country: 'Country A', iso3: 'AAA', value: 22e9, share: 0.22, rank: 1 },
  { country_id: 'asthb', country: 'Country B', iso3: 'BBB', value: 7.4e9, share: 0.074, rank: 2 },
  { country_id: 'eudeu', country: 'Country C', iso3: 'CCC', value: 5.8e9, share: 0.058, rank: 3 },
  { country_id: 'asind', country: 'India', iso3: 'IND', value: 3.1e9, share: 0.031, rank: 8 },
];

const NODES: NetworkNode[] = ['4001', '4002', '2803', '4011', '8708'].map((code, i) => ({
  id: code,
  code,
  label: `Sample node ${i + 1}`,
  description: null,
  level: 4,
  ministry_id: ['doc', 'dcpc', 'dcpc', 'dpiit', 'mhi'][i],
  ministry_short: null,
  color: null,
  sector_id: null,
  exports: [1e7, 5e8, 3e8, 3e9, 2e10][i],
  imports: null,
  world_trade: [1.6e10, 2e10, 1e10, 1e11, 4e11][i],
  rca: null,
  vulnerability_score: null,
  production: null,
  chain_ids: ['sample'],
  stage_id: null,
  is_center: code === '4011',
}));
const EDGES: NetworkEdge[] = [
  ['4001', '4011'],
  ['4002', '4011'],
  ['2803', '4011'],
  ['4011', '8708'],
].map(([s, t]) => ({ id: `${s}-${t}`, source: s, target: t, relation: 'input_to', chain_id: 'sample', source_kind: 'curated' }));

export default function DevGallery() {
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [seg, setSeg] = useState<'top5' | 'all'>('top5');
  const [sel, setSel] = useState('');
  const [toggle, setToggle] = useState(true);
  const [q, setQ] = useState('');
  const [node, setNode] = useState<string | null>('4011');

  const columns: Column<SampleRow>[] = [
    { key: 'code', header: 'HS code', value: (r) => r.code, render: (r) => <CodeLink code={r.code} noLink />, sticky: true },
    { key: 'label', header: 'Product', value: (r) => r.label },
    { key: 'ministry', header: 'Ministry', value: (r) => r.ministry, render: (r) => <MinistryPill ministry={{ id: r.ministry, short_name: r.ministry.toUpperCase() }} link={false} /> },
    { key: 'exports', header: 'Exports', align: 'right', value: (r) => r.exports, render: (r) => fmtUSD(r.exports, { na: NA_SHORT }), hint: 'India exports, US$' },
    { key: 'imports', header: 'Imports', align: 'right', value: (r) => r.imports, render: (r) => fmtUSD(r.imports, { na: NA_SHORT }) },
    { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => (r.rca === null ? NA_SHORT : r.rca.toFixed(2)) },
  ];

  const bar = useMemo<EChartsOption>(
    () => ({
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtNum(v, { compact: true }) } },
      yAxis: { type: 'category', inverse: true, data: ROWS.map((r) => r.ministry.toUpperCase()) },
      series: [
        {
          type: 'bar',
          name: 'Codes',
          data: ROWS.map((r, i) => ({ value: 2600 - i * 420, itemStyle: { color: ministryColor(r.ministry), borderRadius: [0, 4, 4, 0] } })),
          label: { show: true, position: 'right' },
        },
      ],
    }),
    [],
  );
  const line = useMemo<EChartsOption>(
    () => ({
      grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
      legend: { top: 0, left: 0 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: ['2018', '2019', '2020', '2021', '2022', '2023', '2024'] },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtUSD(v) } },
      series: [
        { type: 'line', name: 'Exports', data: [2.1, 2.3, 2.0, 2.6, 2.9, 3.0, 3.1].map((x) => x * 1e9) },
        { type: 'line', name: 'Imports', data: [0.15, 0.17, 0.12, 0.18, 0.21, 0.2, 0.22].map((x) => x * 1e9) },
      ],
    }),
    [],
  );

  return (
    <>
      <PageHeader
        eyebrow="Development"
        title="Component gallery"
        subtitle={SAMPLE_NOTE}
        icon={Layers}
        breadcrumbs={[{ label: 'Overview', to: '/' }, { label: 'Component gallery' }]}
        meta={
          <>
            <ProvenanceBadge status="verified" />
            <ProvenanceBadge status="not_verified" />
            <ProvenanceBadge status="not_available" />
            <ModelEstimateTag method="Sample method" />
          </>
        }
        actions={<DownloadMenu kind="product" id="61091000" />}
      />

      <div className="space-y-6">
        <StatGrid cols={4}>
          <KpiTile label="Total HS codes mapped" value={fmtNum(13110)} icon={Hash} status="verified" />
          <KpiTile label="Exports (sample)" value={fmtUSD(3.106e9)} accent="brand" trend={[2.1, 2.3, 2.0, 2.6, 2.9, 3.0, 3.1]} delta={{ value: 0.034, label: 'vs 2023' }} />
          <KpiTile label="Imports (sample)" value={fmtUSD(2.16e8)} accent="ink" delta={{ value: 0.08, label: 'vs 2023', upIsGood: false }} hint="Definition tooltip" />
          <KpiTile label="Global production" value={null} status="not_available" icon={ChartColumn} />
        </StatGrid>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Buttons & badges" icon={Sparkles}>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={Download}>
                Primary
              </Button>
              <Button>Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="accent" icon={Sparkles}>
                Accent
              </Button>
              <Button variant="danger">Danger</Button>
              <Button loading>Loading</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(['neutral', 'brand', 'success', 'danger', 'warning', 'orange', 'info', 'magenta', 'outline'] as const).map((t) => (
                <Badge key={t} tone={t}>
                  {t}
                </Badge>
              ))}
              <ArchetypeBadge archetype="Champion" />
              <ArchetypeBadge archetype="Dependent" />
              <MinistryPill ministry={{ id: 'mot', short_name: 'MoT', name: 'Ministry of Textiles' }} />
              <MinistryPill ministry={{ id: 'residual', short_name: 'Residual' }} link={false} />
              <SectorPill sector={{ id: 'textiles', name: 'Textiles & Apparel' }} />
              <CodeLink code="40111010" label="Sample label" />
              <ProvenanceDot status="verified" />
            </div>
            <div className="mt-4">
              <ProvenanceLegend />
            </div>
          </Card>

          <Card title="Form controls" icon={Search}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Ministry" value={sel} onChange={setSel} placeholder="All ministries" options={[{ value: 'mot', label: 'MoT' }, { value: 'dpiit', label: 'DPIIT' }]} />
              <FormField label="Search" htmlFor="g-search">
                <SearchInput id="g-search" value={q} onChange={setQ} debounce={200} />
              </FormField>
              <FormField label="Text" htmlFor="g-text" hint="Hint text">
                <TextInput id="g-text" placeholder="Type…" />
              </FormField>
              <FormField label="Typeahead (API)" htmlFor="g-hsn">
                <HsnSearchBox onSelect={(s) => toast.info(`Selected ${s.hsn8}`)} onSubmit={(t) => toast.info(`Submitted ${t}`)} />
              </FormField>
              <FormField label="Message" htmlFor="g-area" className="sm:col-span-2">
                <TextArea id="g-area" rows={2} />
              </FormField>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <Toggle checked={toggle} onChange={setToggle} label="Include parts-of links" />
              <SegmentedControl value={seg} onChange={setSeg} options={[{ value: 'top5', label: 'Top 5' }, { value: 'all', label: 'All' }]} />
              <Tooltip content="Tooltip content">
                <span className="text-sm text-ink-2 underline decoration-dotted">Hover me</span>
              </Tooltip>
              <Button size="sm" onClick={() => setModal(true)}>
                Modal
              </Button>
              <Button size="sm" onClick={() => setDrawer(true)}>
                Drawer
              </Button>
              <Button size="sm" onClick={() => toast.success('Saved', 'Toast message')}>
                Toast
              </Button>
            </div>
          </Card>
        </div>

        <Card title="DataTable" subtitle={SAMPLE_NOTE} padding="md">
          <DataTable columns={columns} rows={ROWS} rowKey={(r) => r.code} csvFilename="sample" defaultSort={{ key: 'exports', order: 'desc' }} pagination={{ mode: 'client', pageSize: 10 }} onRowClick={(r) => toast.info(r.code)} />
        </Card>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="EChart - bars coloured by ministry" subtitle={SAMPLE_NOTE}>
            <EChart option={bar} height={240} />
          </Card>
          <Card title="EChart - line" subtitle={SAMPLE_NOTE}>
            <EChart option={line} height={240} />
          </Card>
          <Card title="CountryBars (India highlighted)" subtitle={SAMPLE_NOTE}>
            <CountryBars items={COUNTRIES} limit={3} />
          </Card>
          <Card title="Scores, sparkline, key-values" icon={TrendingUp}>
            <div className="space-y-2">
              <ScoreBar value={78} label="Export potential" />
              <ScoreBar value={64} label="Vulnerability" scale="risk" />
              <ScoreBar value={null} label="Substitution" />
              <Sparkline values={[1, 3, 2, null, 4, 5]} width={160} height={36} />
            </div>
            <KeyValueList
              className="mt-4"
              items={[
                { label: 'Assigned ministry', value: <MinistryPill ministry={{ id: 'mot', short_name: 'MoT', name: 'Ministry of Textiles' }} full /> },
                { label: 'Exports ($ Mn.)', value: '1,723', numeric: true, aside: <ProvenanceBadge status="not_verified" size="xs" /> },
                { label: 'Share', value: fmtPct(0.0307), numeric: true },
              ]}
            />
          </Card>
        </div>

        <Card title="NetworkGraph" subtitle={SAMPLE_NOTE}>
          <NetworkGraph nodes={NODES} edges={EDGES} height={300} selectedId={node} onNodeClick={(n) => setNode(n.id)} onBackgroundClick={() => setNode(null)} highlightIds={['2803']} />
        </Card>

        <Tabs
          urlParam="tab"
          tabs={[
            { id: 'md', label: 'Markdown', icon: Landmark },
            { id: 'states', label: 'States', badge: 3 },
            { id: 'gate', label: 'Role gate', icon: ShieldAlert },
          ]}
        >
          {(active) =>
            active === 'md' ? (
              <Card>
                <Markdown>{'## Heading\nSome **bold** text, a [link](/explore) and a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- item one\n- item two'}</Markdown>
              </Card>
            ) : active === 'states' ? (
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <LoadingBlock />
                </Card>
                <Card>
                  <EmptyState title="Nothing here" message="Try clearing filters." />
                </Card>
                <Card>
                  <ErrorState error={new ApiError(500, 'Sample server error')} onRetry={() => toast.info('Retry')} />
                </Card>
                <Card className="md:col-span-3">
                  <ErrorState error={new ApiError(401, 'Not authenticated')} />
                </Card>
              </div>
            ) : (
              <div className="space-y-4">
                <DemoLoginButtons allowed="gov" />
                <RequireRole roles={['admin']} title="Admin sample" description="Only admins see the protected content.">
                  <Card>Protected content visible to admins.</Card>
                </RequireRole>
              </div>
            )
          }
        </Tabs>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title="Modal title" description="Description" footer={<Button variant="primary" onClick={() => setModal(false)}>Done</Button>}>
        <p className="text-sm text-ink-2">Modal body.</p>
      </Modal>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="Drawer title" subtitle="Subtitle">
        <p className="text-sm text-ink-2">Drawer body.</p>
      </Drawer>
    </>
  );
}
