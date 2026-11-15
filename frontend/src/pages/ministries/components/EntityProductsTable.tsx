/**
 * EntityProductsTable - the full "Ministry Wise HS Code" table: every 8-digit line owned by a ministry
 * (or inside a sector), server-searchable, sortable and paginated
 * (GET /api/{ministries|sectors}/{id}/products), with CSV of the current page and a full export
 * through /api/reports/search (CSV / XLSX).
 *
 * Trade values are HS6-level (SPEC: `trade_level: "hs6"`): lines that share a subheading show the
 * subheading's trade, which the footer states plainly.
 */
import { useMemo, useState } from 'react';
import { TableProperties } from 'lucide-react';
import type { ProductSummary, Provenance, SearchSort } from '@/api/types';
import {
  Card,
  CodeLink,
  DataTable,
  DownloadMenu,
  MinistryPill,
  ProvenanceDot,
  SearchInput,
  SectorPill,
  type Column,
  type SortState,
} from '@/components';
import { fmtNum, fmtRatio, fmtUSD, NA_SHORT } from '@/lib/format';
import { BCD_COLUMN_HINT, BcdCell, bcdText } from '@/pages/explore/shared';
import { useEntityProducts, type EntityKind } from '../api';
import { mappingSourceLabel, mappingStatusOf } from '../utils';
import { LabelledProvenance } from './LabelledProvenance';

export interface EntityProductsTableProps {
  kind: EntityKind;
  id: string;
  /** Display name used in the title and file names. */
  entityName: string;
  tradeProvenance: Provenance;
  mappingProvenance: Provenance;
  className?: string;
}

const NA = { na: NA_SHORT };

export function EntityProductsTable({ kind, id, entityName, tradeProvenance, mappingProvenance, className }: EntityProductsTableProps) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<SortState>({ key: 'exports', order: 'desc' });

  const params = useMemo(
    () => ({ q: q.trim() || undefined, page, page_size: pageSize, sort: sort.key as SearchSort, order: sort.order }),
    [q, page, pageSize, sort],
  );
  const query = useEntityProducts(kind, id, params);

  const columns = useMemo<Column<ProductSummary>[]>(() => {
    const cols: Column<ProductSummary>[] = [
      {
        key: 'hsn8',
        header: 'HS code',
        sortKey: 'code',
        firstSort: 'asc',
        sticky: true,
        width: 116,
        value: (r) => r.hsn8,
        render: (r) => <CodeLink code={r.hsn8} />,
      },
      {
        key: 'description',
        header: 'Product label',
        value: (r) => r.description,
        csv: (r) => r.full_description ?? r.description,
        render: (r) => (
          <span className="line-clamp-2 min-w-[14rem] text-ink" title={r.full_description ?? r.description}>
            {r.description}
          </span>
        ),
      },
    ];
    if (kind === 'ministry') {
      cols.push({
        key: 'sector',
        header: 'Sector',
        hideBelow: 'lg',
        value: (r) => r.sector_name,
        render: (r) => (r.sector_id ? <SectorPill sector={{ id: r.sector_id, name: r.sector_name }} size="xs" /> : <span className="text-muted">{NA_SHORT}</span>),
      });
    } else {
      cols.push({
        key: 'ministry',
        header: 'Ministry',
        hideBelow: 'lg',
        value: (r) => r.ministry_short ?? r.ministry_id,
        render: (r) => <MinistryPill ministry={{ id: r.ministry_id, short_name: r.ministry_short, name: r.ministry_name }} size="xs" />,
      });
    }
    cols.push(
      {
        key: 'mapping',
        header: 'Mapping',
        hideBelow: 'md',
        hint: 'Source of the ministry assignment: DPIIT Guidebook, official upload or manual review (verified); provisional rule or not listed (not verified).',
        value: (r) => (r.mapping_status === 'residual' ? 'Residual' : mappingSourceLabel(r.mapping_source)),
        render: (r) => (
          <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
            <ProvenanceDot status={mappingStatusOf(r.mapping_source, r.mapping_status)} />
            {r.mapping_status === 'residual' ? 'Residual' : mappingSourceLabel(r.mapping_source)}
          </span>
        ),
      },
      {
        key: 'exports',
        header: 'Exports',
        sortKey: 'exports',
        align: 'right',
        hint: "India's exports to the world, latest year, US$ (HS6 level)",
        value: (r) => r.exports,
        render: (r) => fmtUSD(r.exports, NA),
      },
      {
        key: 'imports',
        header: 'Imports',
        sortKey: 'imports',
        align: 'right',
        hint: "India's imports from the world, latest year, US$ (HS6 level)",
        value: (r) => r.imports,
        render: (r) => fmtUSD(r.imports, NA),
      },
      {
        key: 'world_trade',
        header: 'World trade',
        sortKey: 'world_trade',
        align: 'right',
        hideBelow: 'xl',
        hint: 'Sum of all countries’ exports of the subheading, latest year, US$',
        value: (r) => r.world_trade,
        render: (r) => fmtUSD(r.world_trade, NA),
      },
      {
        key: 'rca',
        header: 'RCA',
        sortKey: 'rca',
        align: 'right',
        hint: 'Balassa revealed comparative advantage (> 1 = India specialises in the product)',
        value: (r) => r.rca,
        render: (r) => fmtRatio(r.rca, NA),
      },
      {
        key: 'tariff',
        header: 'BCD',
        align: 'right',
        hideBelow: 'lg',
        hint: BCD_COLUMN_HINT,
        value: (r) => bcdText(r),
        csv: (r) => {
          const text = bcdText(r);
          return text;
        },
        render: (r) => <BcdCell row={r} />,
      },
    );
    return cols;
  }, [kind]);

  const total = query.data?.total ?? 0;
  const filterParam = kind === 'ministry' ? { ministry_id: id } : { sector_id: id };

  return (
    <Card
      className={className}
      icon={TableProperties}
      title={kind === 'ministry' ? 'Ministry-wise HS codes' : 'HS codes in this sector'}
      subtitle={
        <>
          {query.data ? `${fmtNum(total)} national tariff lines (8-digit)` : 'National tariff lines (8-digit)'} · search by code or product text
        </>
      }
      actions={
        <>
          <LabelledProvenance label="Mapping" provenance={mappingProvenance} />
          <LabelledProvenance label="Trade" provenance={tradeProvenance} />
        </>
      }
    >
      <DataTable
        columns={columns}
        rows={query.data?.items}
        rowKey={(r) => r.hsn8}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        pagination={{ mode: 'server', page, pageSize, total, onPageChange: setPage, onPageSizeChange: setPageSize }}
        csvFilename={`${id}-hs-codes-page-${page}`}
        emptyTitle={q ? 'No products match this search' : 'No products assigned'}
        emptyMessage={q ? 'Try a shorter code prefix (for example 6109) or fewer words.' : undefined}
        caption={`HS codes of ${entityName}`}
        maxHeight="65vh"
        toolbar={
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            debounce={300}
            size="sm"
            placeholder="Search code or product…"
            className="w-full max-w-sm"
            aria-label={`Search HS codes of ${entityName}`}
          />
        }
        toolbarRight={
          <DownloadMenu
            kind="search"
            params={{ ...filterParam, q: q.trim() || undefined, sort: sort.key, order: sort.order }}
            formats={['csv', 'xlsx']}
            label="Export all lines"
          />
        }
        footer="Trade values are each line's own DGCIS TRADESTAT FY2024-25 figures (Not available when DGCIS does not publish the line separately). CSV exports the rows on this page; “Export all lines” downloads every matching line."
      />
    </Card>
  );
}
