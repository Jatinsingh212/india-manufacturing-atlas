/**
 * Shared helpers for the D1 pages (Overview, HSN Explorer, Product): provenance builders, mapping labels
 * and the ProductSummary table columns used by the Explorer search table, the Overview
 * "Ministry-wise HS code" table and the Enter-HSN node listing.
 *
 * Provenance rules (SPEC section 1):
 * - Trade values in ProductSummary rows are each line's official DGCIS TRADESTAT FY2024-25 figures -> Verified
 *   when present, Not available when null (DGCIS does not publish the line separately). Rows carry no provenance object, so {@link tradeProvenance} builds one.
 * - Mapping: dpiit_guidebook / official_upload / manual -> Verified; rule / unmapped -> Not verified.
 */
import type { ReactNode } from 'react';
import type { MappingSource, MappingStatus, ProductSummary, Provenance } from '@/api/types';
import { Badge, CodeLink, MinistryPill, ProvenanceDot, SectorPill, Tooltip, tradeSourceLabel, type Column } from '@/components';
import { fmtRate, fmtRatio, fmtUSD, fmtUSDMn, NA_SHORT, truncate } from '@/lib/format';

/** Latest trade year shown across the D1 pages (SPEC section 1: latest year = 2024). */
export const LATEST_YEAR = 2024;

/** Provenance of a line's trade values (DGCIS TRADESTAT, world trade CEPII BACI); Not available when null. */
export function tradeProvenance(value?: number | null, year: number = LATEST_YEAR): Provenance {
  if (value === null) return { source: 'tradestat', status: 'not_available', label: 'Not published separately by DGCIS TRADESTAT', year };
  return { source: 'tradestat', status: 'verified', label: tradeSourceLabel(year), year };
}

/** Tariff year of the WITS MFN applied averages in the Atlas (SPEC section 1). */
export const TARIFF_YEAR = 2022;

export type BcdSource = 'wits' | null;

/** Where a row's `bcd_display` comes from: WITS when a figure is present, otherwise null. */
export function bcdSource(p: Pick<ProductSummary, 'bcd_display' | 'mfn_tariff' | 'bcd_source'>): BcdSource {
  if (p.bcd_source === 'wits') return 'wits';
  return p.bcd_display || typeof p.mfn_tariff === 'number' ? 'wits' : null;
}

/** Provenance of the BCD / MFN figure shown in a row (WITS MFN applied average). */
export function tariffProvenance(p: Pick<ProductSummary, 'bcd_display' | 'mfn_tariff' | 'bcd_source'>): Provenance {
  if (bcdSource(p) === 'wits') {
    return { source: 'wits', status: 'verified', label: `WITS / UNCTAD TRAINS MFN applied ${TARIFF_YEAR}`, year: TARIFF_YEAR };
  }
  return { source: 'wits', status: 'not_available', label: 'No WITS MFN tariff for this subheading', year: null };
}

/** Human labels for mapping sources. */
export const MAPPING_SOURCE_LABELS: Record<MappingSource | string, string> = {
  dpiit_guidebook: 'DPIIT Guidebook (16.12.2025)',
  rule: 'Provisional rule',
  official_upload: 'Data Hub upload',
  manual: 'Manual review',
  unmapped: 'Not in Guidebook',
  residual: 'Residual in Guidebook',
};

/** Short labels for dense tables. */
export const MAPPING_SOURCE_SHORT: Record<MappingSource | string, string> = {
  dpiit_guidebook: 'Guidebook',
  rule: 'Rule',
  official_upload: 'Upload',
  manual: 'Manual',
  unmapped: 'Not listed',
  residual: 'Residual',
};

export const MAPPING_STATUS_LABELS: Record<MappingStatus | string, string> = {
  accepted: 'Accepted',
  residual: 'Residual',
};

/** Provenance status of a ministry mapping by its source (and residual status, when supplied). */
export function mappingProvenance(
  source: MappingSource | string | null | undefined,
  status?: MappingStatus | string | null,
): Provenance {
  if (status === 'residual') {
    if (source === 'unmapped') {
      return { source: 'unmapped', status: 'not_verified', label: 'Not listed in the DPIIT Guidebook (16.12.2025 revision); no owner assigned', year: null };
    }
    return { source: source ?? 'dpiit_guidebook', status: 'not_verified', label: 'Residual code in the DPIIT Guidebook (no ministry accepted it); ownership to be claimed', year: null };
  }
  switch (source) {
    case 'dpiit_guidebook':
      return { source: 'dpiit_guidebook', status: 'verified', label: 'DPIIT Guidebook on HSN Code Mapping, 16 December 2025 revision', year: null };
    case 'official_upload':
      return { source: 'official_upload', status: 'verified', label: 'Official mapping uploaded through the Data Hub', year: null };
    case 'manual':
      return { source: 'manual', status: 'verified', label: 'Approved by manual review', year: null };
    case 'unmapped':
      return { source: 'unmapped', status: 'not_verified', label: 'Not listed in the DPIIT Guidebook (16.12.2025 revision)', year: null };
    case 'residual':
      return { source: 'residual', status: 'not_verified', label: 'Residual code in the DPIIT Guidebook (no ministry accepted it)', year: null };
    case 'rule':
      return { source: 'rule', status: 'not_verified', label: 'Provisional rule-based mapping (not the official Guidebook)', year: null };
    default:
      return { source: 'rule', status: 'not_available', label: 'Mapping not available', year: null };
  }
}

/** "12.5%" (WITS MFN average) or null. */
export function bcdText(p: Pick<ProductSummary, 'bcd_display' | 'mfn_tariff'>): string | null {
  if (p.bcd_display) return p.bcd_display;
  if (p.mfn_tariff !== null && p.mfn_tariff !== undefined) return fmtRate(p.mfn_tariff);
  return null;
}

/** Header hint for the BCD / tariff column (WITS MFN applied averages). */
export const BCD_COLUMN_HINT =
  "Basic customs duty: India's WITS MFN applied simple average for the HS6 subheading (2022).";

/** BCD cell: the WITS MFN figure, or a dash when the subheading has no ad-valorem average. */
export function BcdCell({ row }: { row: Pick<ProductSummary, 'bcd_display' | 'mfn_tariff' | 'bcd_source'> }) {
  const text = bcdText(row);
  return text ? <>{text}</> : <Dash />;
}

/**
 * Wrapper for links inside clickable table rows: stops the click (and Enter) from also triggering the
 * row's own navigation.
 */
export function CellLink({ children }: { children: ReactNode }) {
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="inline-flex max-w-full">
      {children}
    </span>
  );
}

/** Muted dash for missing table cells. */
export function Dash() {
  return <span className="text-muted">{NA_SHORT}</span>;
}

/**
 * Split a national-line label into its distinguishing part and its context. The ETL prefixes generic GST
 * line texts ("Other", "Radials") with the subheading text, joined by " — " ("New pneumatic tyres for
 * motor cars — radials"); sibling lines then differ only after the last separator, which a clamped cell
 * would hide. Returns `{ line, context }`; `context` is null when there is no separator.
 */
export function splitLabel(description: string): { line: string; context: string | null } {
  const i = description.lastIndexOf(' — ');
  if (i <= 0 || i + 3 >= description.length) return { line: description, context: null };
  const tail = description.slice(i + 3).trim();
  return { line: tail.charAt(0).toUpperCase() + tail.slice(1), context: description.slice(0, i).trim() };
}

/**
 * Short label that keeps both ends of a GST description ("Fabrics; ... dyed"), because sibling lines
 * usually differ only in their last words.
 */
export function shortLabel(text: string, max = 34): string {
  if (text.length <= max) return text;
  const semi = text.indexOf('; ');
  const head = semi > 0 && semi < 18 ? text.slice(0, semi) : '';
  // Last ", " / " — " separator outside parentheses.
  let cut = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (text.startsWith(', ', i) || text.startsWith(' — ', i) || text.startsWith(' - ', i))) cut = i;
  }
  const tail = cut > semi ? text.slice(cut).replace(/^(, | — | - )/, '') : '';
  if (head && tail && head.length + tail.length + 4 <= max) return `${head}; … ${tail}`;
  if (tail && tail.length + 2 <= max && tail.length >= 8) return `… ${tail}`;
  return truncate(text, max);
}

/**
 * Labels that tell sibling descriptions apart: the words every description shares at the start (and, by
 * default, at the end) are dropped, so "Garments and clothing accessories; babies', of cotton, knitted or
 * crocheted" next to "... of synthetic fibres, ..." becomes "cotton, knitted or crocheted" / "synthetic
 * fibres, ...". A description with nothing left keeps its full text. `max` truncates (Infinity = never).
 */
export function distinctLabels(descriptions: string[], max = 30, stripSuffix = true): string[] {
  const words = descriptions.map((d) => d.split(/\s+/).filter(Boolean));
  const cut = (t: string) => (Number.isFinite(max) ? truncate(t, max) : t);
  if (words.length < 2) return descriptions.map(cut);
  const shortest = Math.min(...words.map((w) => w.length));
  let pre = 0;
  while (pre < shortest && words.every((w) => w[pre] === words[0][pre])) pre++;
  let suf = 0;
  if (stripSuffix) {
    while (suf < shortest - pre && words.every((w) => w[w.length - 1 - suf] === words[0][words[0].length - 1 - suf])) suf++;
  }
  return words.map((w, i) => {
    const middle = w.slice(pre, w.length - suf).join(' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '');
    return cut(middle ? middle.charAt(0).toUpperCase() + middle.slice(1) : descriptions[i]);
  });
}

/**
 * Product label cell. Lines with a subheading prefix show the distinguishing part first and the
 * subheading context below it in muted text; the full nomenclature text is in a tooltip when it differs.
 */
export function ProductLabel({ row, lines = 2 }: { row: Pick<ProductSummary, 'description' | 'full_description'>; lines?: 1 | 2 | 3 }) {
  const clamp = lines === 1 ? 'line-clamp-1' : lines === 3 ? 'line-clamp-3' : 'line-clamp-2';
  const { line, context } = splitLabel(row.description);
  const text = context ? (
    <span className="flex flex-col leading-snug">
      <span className={lines === 3 ? 'line-clamp-2' : 'line-clamp-1'}>{line}</span>
      <span className="line-clamp-1 text-[12px] text-muted">{context}</span>
    </span>
  ) : (
    <span className={`${clamp} leading-snug`}>{row.description}</span>
  );
  const tip = row.full_description && row.full_description !== row.description ? row.full_description : context ? row.description : null;
  if (tip) {
    return (
      <Tooltip content={tip} maxWidth={420} block>
        {text}
      </Tooltip>
    );
  }
  return text;
}

/** Mapping cell: provenance dot + source + (optional) residual marker. */
export function MappingCell({ row }: { row: Pick<ProductSummary, 'mapping_source' | 'mapping_status' | 'mapping_confidence'> }) {
  const prov = mappingProvenance(row.mapping_source, row.mapping_status);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <ProvenanceDot provenance={prov} />
      <span className="text-ink-2">{MAPPING_SOURCE_SHORT[row.mapping_source] ?? row.mapping_source}</span>
      {row.mapping_status === 'residual' ? (
        <Badge tone="orange" size="xs">
          Residual
        </Badge>
      ) : null}
    </span>
  );
}

export interface ProductColumnOptions {
  /**
   * 'compact' = narrow cards with US$ million figures and short headers; 'full' = Explorer columns with
   * ministry / sector and mapping.
   */
  variant: 'compact' | 'full';
  /** Server sort keys enabled (search / ministry products). */
  serverSort?: boolean;
  /**
   * 'full' only: show the ministry and sector pills under the product label instead of in their own
   * column (for a table that shares its row with the HS tree on mid-size screens).
   */
  ownerInProduct?: boolean;
}

/** Ministry and sector pills of a row (links stop the row click). */
function OwnerPills({ row, direction }: { row: ProductSummary; direction: 'row' | 'column' }) {
  return (
    <CellLink>
      <span className={direction === 'column' ? 'flex max-w-[11rem] flex-col items-start gap-1' : 'flex flex-wrap items-center gap-1'}>
        <MinistryPill ministry={{ id: row.ministry_id, short_name: row.ministry_short, name: row.ministry_name }} size="xs" />
        {row.sector_id ? <SectorPill sector={{ id: row.sector_id, name: row.sector_name }} size="xs" /> : null}
      </span>
    </CellLink>
  );
}

/**
 * Columns for ProductSummary tables.
 * - compact: Product (code over label), Exports ($ Mn.), Imports ($ Mn.), RCA
 * - full: HS code (with mapping source), Product, Ministry / sector, Exports, Imports, World trade, RCA, Tariff (BCD / MFN)
 */
export function productColumns({ variant, serverSort = false, ownerInProduct = false }: ProductColumnOptions): Column<ProductSummary>[] {
  const sk = (key: string) => (serverSort ? key : undefined);
  const mn = variant !== 'full'; // compact tables use US$ million figures
  const code: Column<ProductSummary> = {
    key: 'hsn8',
    header: variant === 'full' ? 'HS code' : 'Product code',
    value: (r) => r.hsn8,
    render: (r) =>
      variant === 'full' ? (
        <span className="flex flex-col items-start gap-0.5">
          <CodeLink code={r.hsn8} />
          <MappingCell row={r} />
        </span>
      ) : (
        <CodeLink code={r.hsn8} />
      ),
    sortKey: sk('code'),
    firstSort: 'asc',
    width: variant === 'full' ? 124 : 96,
    hint: variant === 'full' ? 'Under each code: the mapping source. Green = verified (DPIIT Guidebook, upload or approved review); red = provisional rule or unlisted.' : undefined,
    csvHeader: 'hsn8',
  };

  const label: Column<ProductSummary> = {
    key: 'description',
    header: variant === 'full' ? 'Product' : 'Product label',
    value: (r) => r.description,
    render: (r) => <ProductLabel row={r} />,
    className: variant === 'compact' ? 'min-w-[10rem]' : 'min-w-[13rem]',
  };
  const exportsCol: Column<ProductSummary> = {
    key: 'exports',
    header: variant === 'compact' ? 'Exports ($ Mn.)' : 'Exports 2024',
    align: 'right',
    value: (r) => r.exports,
    render: (r) => (mn ? fmtUSDMn(r.exports, { na: NA_SHORT }) : fmtUSD(r.exports, { na: NA_SHORT })),
    sortKey: sk('exports'),
    hint: "This 8-digit line's exports, FY2024-25 (DGCIS TRADESTAT). Not available when DGCIS does not publish the line separately.",
  };
  const importsCol: Column<ProductSummary> = {
    key: 'imports',
    header: variant === 'compact' ? 'Imports ($ Mn.)' : 'Imports 2024',
    align: 'right',
    value: (r) => r.imports,
    render: (r) => (mn ? fmtUSDMn(r.imports, { na: NA_SHORT }) : fmtUSD(r.imports, { na: NA_SHORT })),
    sortKey: sk('imports'),
    hint: "This 8-digit line's imports, FY2024-25 (DGCIS TRADESTAT).",
  };
  const bcd: Column<ProductSummary> = {
    key: 'bcd',
    header: variant === 'full' ? 'Tariff' : 'BCD',
    align: 'right',
    value: (r) => bcdText(r),
    csv: (r) => bcdText(r),
    render: (r) => <BcdCell row={r} />,
    hint: BCD_COLUMN_HINT,
    sortable: false,
  };
  const rca: Column<ProductSummary> = {
    key: 'rca',
    header: 'RCA',
    align: 'right',
    value: (r) => r.rca,
    render: (r) => fmtRatio(r.rca, { na: NA_SHORT }),
    sortKey: sk('rca'),
    hint: "Balassa revealed comparative advantage: India's export share in this product divided by its share in world exports. Above 1 = advantage.",
  };
  if (variant === 'compact') {
    // Narrow cards: code and label share one column; numeric headers may wrap.
    const line: Column<ProductSummary> = {
      ...code,
      header: 'Product',
      render: (r) => (
        <span className="flex min-w-[9rem] flex-col gap-0.5">
          <CodeLink code={r.hsn8} />
          <ProductLabel row={r} />
        </span>
      ),
      width: undefined,
    };
    const wrap = 'whitespace-normal! min-w-[4.5rem]';
    return [line, { ...exportsCol, headerClassName: wrap }, { ...importsCol, headerClassName: wrap }, rca];
  }

  const owner: Column<ProductSummary>[] = ownerInProduct
    ? []
    : [
        {
          key: 'ministry',
          header: 'Ministry · sector',
          value: (r) => r.ministry_short,
          csv: (r) => [r.ministry_short, r.sector_name].filter(Boolean).join(' / '),
          render: (r) => <OwnerPills row={r} direction="column" />,
          hideBelow: 'md',
          sortable: false,
        },
      ];
  const productCol: Column<ProductSummary> = ownerInProduct
    ? {
        ...label,
        header: 'Product · owner',
        render: (r) => (
          <span className="flex flex-col gap-1">
            <ProductLabel row={r} />
            <OwnerPills row={r} direction="row" />
          </span>
        ),
        csv: (r) => r.description,
      }
    : label;

  return [
    code,
    productCol,
    ...owner,
    exportsCol,
    importsCol,
    {
      key: 'world_trade',
      header: 'World trade',
      align: 'right',
      value: (r) => r.world_trade,
      render: (r) => fmtUSD(r.world_trade, { na: NA_SHORT }),
      sortKey: sk('world_trade'),
      hint: 'Sum of all exporters of the HS6 subheading in 2024 (CEPII BACI).',
      hideBelow: 'xl',
    },
    rca,
    bcd,
  ];
}
