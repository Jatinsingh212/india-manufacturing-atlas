/**
 * DataTable - the dense, sortable, paginated table used across the Atlas.
 *
 * Client mode (default): pass all `rows`; sorting uses each column's `value()`, pagination is local.
 * Server mode: pass `sort` + `onSortChange` (server sorting) and `pagination={{ mode: 'server', ... }}`.
 *
 *   const columns: Column<ProductSummary>[] = [
 *     { key: 'hsn8', header: 'HS code', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} /> },
 *     { key: 'description', header: 'Product', value: (r) => r.description, width: '40%' },
 *     { key: 'exports', header: 'Exports', align: 'right', value: (r) => r.exports, render: (r) => fmtUSD(r.exports, { na: NA_SHORT }) },
 *   ];
 *   <DataTable columns={columns} rows={data?.items} rowKey={(r) => r.hsn8} loading={q.isPending}
 *              onRowClick={(r) => navigate(routes.product(r.hsn8))} csvFilename="ministry-products" />
 *
 * Features: sticky header (inside a `maxHeight` scroll area), sticky first column (`sticky: true`),
 * row click + keyboard Enter, empty / error / loading states, CSV export of the current rows
 * (client mode: all sorted rows; server mode: the current page).
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Download, Inbox, MoveHorizontal, type LucideIcon } from 'lucide-react';
import type { SortOrder } from '@/api/types';
import { downloadCsv, type CsvCell } from '@/lib/csv';
import { fmtNum, NA_SHORT } from '@/lib/format';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Loading';
import { Tooltip } from './Tooltip';

export interface Column<T> {
  /** Unique column id; also the default server sort key. */
  key: string;
  header: ReactNode;
  /** Cell renderer; defaults to `value()` as text ("—" when null). */
  render?: (row: T, index: number) => ReactNode;
  /** Raw value for sorting, CSV and the default renderer. */
  value?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** CSS width (px number or any CSS length). */
  width?: number | string;
  /** Sortable? Default: client mode when `value` exists; server mode only when `sortKey` is set (or `sortable: true`, sending `key`). */
  sortable?: boolean;
  /** Server sort key sent to `onSortChange` (default `key`). */
  sortKey?: string;
  /** First sort direction when clicked (default: desc for numbers, asc for text). */
  firstSort?: SortOrder;
  /** CSV: false to exclude, or a custom extractor (default `value`). */
  csv?: false | ((row: T) => CsvCell);
  /** CSV header text (default: `header` when it is a string, else `key`). */
  csvHeader?: string;
  /** Header tooltip (definitions, units). */
  hint?: ReactNode;
  /** Keep this column visible while scrolling horizontally (use on the first column). */
  sticky?: boolean;
  /** Hide below this breakpoint. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  /** Phone card view: use this column as the card title (defaults to a description-like column). */
  mobilePrimary?: boolean;
  /** Phone card view: render in the card's top-right action corner (e.g. a pin button). */
  mobileAction?: boolean;
  /** Phone card view: override the field label; `false` hides the label. */
  mobileLabel?: string | false;
  /** CSV only: exported through `value` / `csv` but never rendered (e.g. an aggregation-level flag beside a value column). */
  csvOnly?: boolean;
  className?: string;
  headerClassName?: string;
}

export interface SortState {
  key: string;
  order: SortOrder;
}

export type DataTablePagination =
  | false
  | { mode: 'client'; pageSize?: number; pageSizeOptions?: number[] }
  | {
      mode: 'server';
      page: number;
      pageSize: number;
      total: number;
      onPageChange: (page: number) => void;
      onPageSizeChange?: (size: number) => void;
      pageSizeOptions?: number[];
    };

export interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T> | null | undefined;
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  /** When set (and there are no rows), renders ErrorState. */
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: ReactNode;
  emptyMessage?: ReactNode;
  emptyIcon?: LucideIcon;
  onRowClick?: (row: T, index: number) => void;
  isRowSelected?: (row: T) => boolean;
  rowClassName?: (row: T, index: number) => string | undefined;
  /** Controlled sort (server or client). */
  sort?: SortState | null;
  /** Providing this switches to server sorting (rows are shown in the given order). */
  onSortChange?: (sort: SortState) => void;
  /** Initial client sort. */
  defaultSort?: SortState;
  /** Default: client pagination with 25 rows per page. */
  pagination?: DataTablePagination;
  /** Scroll-area max height enabling the sticky header (default '70vh'; null = no limit). */
  maxHeight?: number | string | null;
  dense?: boolean;
  /** Narrower horizontal cell padding (8px instead of 12px), so a six-column table fits a half-width card at 1280px. */
  tight?: boolean;
  /** Shows an "Export CSV" button; the file name without extension. */
  csvFilename?: string;
  /** Left side of the toolbar (filters, counts). */
  toolbar?: ReactNode;
  /** Right side of the toolbar, before the CSV button. */
  toolbarRight?: ReactNode;
  /** Accessible caption (visually hidden). */
  caption?: string;
  footer?: ReactNode;
  className?: string;
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'max-sm:hidden',
  md: 'max-md:hidden',
  lg: 'max-lg:hidden',
  xl: 'max-xl:hidden',
};

/** Keys that usually identify a row better than a code or a timestamp in the phone card view. */
const PRIMARY_KEYS = new Set([
  'description',
  'label',
  'name',
  'product',
  'title',
  'subject',
  'requirement',
  'ministry_name',
  'email',
  'action',
  'event',
  'summary',
]);
/** Columns whose text should use the full card width in the phone card view. */
const WIDE_KEYS = new Set(['description', 'label', 'notes', 'message', 'reason', 'details', 'title', 'requirement', 'subject', 'summary']);

function mobileLabelOf<T>(c: Column<T>): string | null {
  if (c.mobileLabel === false) return null;
  if (typeof c.mobileLabel === 'string') return c.mobileLabel;
  if (typeof c.header === 'string') return c.header;
  if (typeof c.csvHeader === 'string') return c.csvHeader;
  return null;
}

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1; // nulls last
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

function csvHeaderOf<T>(c: Column<T>): string {
  if (c.csvHeader) return c.csvHeader;
  return typeof c.header === 'string' ? c.header : c.key;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  emptyTitle = 'No rows to show',
  emptyMessage,
  emptyIcon = Inbox,
  onRowClick,
  isRowSelected,
  rowClassName,
  sort: sortProp,
  onSortChange,
  defaultSort,
  pagination = { mode: 'client', pageSize: 25 },
  maxHeight = '70vh',
  dense,
  tight,
  csvFilename,
  toolbar,
  toolbarRight,
  caption,
  footer,
  className,
}: DataTableProps<T>) {
  const serverSort = Boolean(onSortChange);
  const [localSort, setLocalSort] = useState<SortState | null>(defaultSort ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollX, setCanScrollX] = useState(false);
  const scrollHintId = useId();
  const sort = sortProp !== undefined ? sortProp : localSort;
  const data = useMemo(() => rows ?? [], [rows]);

  // Reveal a scroll cue only when the desktop table is actually wider than its scroll area.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setCanScrollX(el.scrollWidth > el.clientWidth + 2);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const table = el.querySelector('table');
    if (table) ro.observe(table);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, [columns.length]);

  const sorted = useMemo(() => {
    if (serverSort || !sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return data;
    const get = col.value;
    const out = [...data].sort((a, b) => compare(get(a), get(b)));
    if (sort.order === 'desc') {
      // keep nulls last when descending
      const nonNull = out.filter((r) => get(r) !== null && get(r) !== undefined && get(r) !== '');
      const nulls = out.filter((r) => get(r) === null || get(r) === undefined || get(r) === '');
      return [...nonNull.reverse(), ...nulls];
    }
    return out;
  }, [data, sort, serverSort, columns]);

  // ---- pagination
  const clientPaging = pagination !== false && pagination.mode === 'client';
  const [clientPage, setClientPage] = useState(1);
  const [clientSize, setClientSize] = useState(pagination !== false && pagination.mode === 'client' ? (pagination.pageSize ?? 25) : 25);
  // Back to page 1 when the row count or sort changes (keyed on length, so inline-filtered arrays
  // that are re-created every render do not reset paging).
  useEffect(() => setClientPage(1), [data.length, sort?.key, sort?.order]);
  const clientPages = Math.max(1, Math.ceil(sorted.length / clientSize));
  const safeClientPage = Math.min(clientPage, clientPages);

  const pageRows = useMemo(() => {
    if (!clientPaging) return sorted;
    const start = (safeClientPage - 1) * clientSize;
    return sorted.slice(start, start + clientSize);
  }, [sorted, clientPaging, safeClientPage, clientSize]);

  const pageInfo = useMemo(() => {
    if (pagination === false) return null;
    if (pagination.mode === 'server') {
      return { page: pagination.page, size: pagination.pageSize, total: pagination.total, options: pagination.pageSizeOptions ?? [25, 50, 100, 200] };
    }
    return { page: safeClientPage, size: clientSize, total: sorted.length, options: pagination.pageSizeOptions ?? [10, 25, 50, 100] };
  }, [pagination, safeClientPage, clientSize, sorted.length]);

  const setPage = (p: number) => {
    if (pagination === false) return;
    if (pagination.mode === 'server') pagination.onPageChange(p);
    else setClientPage(p);
  };
  const setSize = (n: number) => {
    if (pagination === false) return;
    if (pagination.mode === 'server') {
      pagination.onPageSizeChange?.(n);
      pagination.onPageChange(1);
    } else {
      setClientSize(n);
      setClientPage(1);
    }
  };

  const onHeaderClick = (c: Column<T>) => {
    const sortable = c.sortable ?? (serverSort ? Boolean(c.sortKey) : Boolean(c.value));
    if (!sortable) return;
    const key = serverSort ? (c.sortKey ?? c.key) : c.key;
    const first: SortOrder = c.firstSort ?? (c.align === 'right' ? 'desc' : 'asc');
    const next: SortState = sort && sort.key === key ? { key, order: sort.order === 'asc' ? 'desc' : 'asc' } : { key, order: first };
    if (onSortChange) onSortChange(next);
    if (sortProp === undefined) setLocalSort(next);
  };

  const exportCsv = () => {
    const cols = columns.filter((c) => c.csv !== false && (c.csv || c.value));
    const header = cols.map(csvHeaderOf);
    const body = sorted.map((r) => cols.map((c) => (typeof c.csv === 'function' ? c.csv(r) : (c.value?.(r) ?? null))));
    downloadCsv(csvFilename ?? 'atlas-table', header, body);
  };

  const padX = tight ? 'px-2' : 'px-3';
  const cellPad = clsx(padX, dense ? 'py-1.5' : 'py-2.5');
  const headPad = clsx(padX, dense ? 'py-2' : 'py-2.5');
  // Columns rendered on screen; csvOnly columns exist for the CSV export alone.
  const shown = columns.filter((c) => !c.csvOnly);
  const showToolbar = Boolean(toolbar || toolbarRight || csvFilename);
  const hasRows = pageRows.length > 0;
  const showError = Boolean(error) && !hasRows && !loading;
  const totalPages = pageInfo ? Math.max(1, Math.ceil(pageInfo.total / pageInfo.size)) : 1;

  const renderCell = (c: Column<T>, row: T, index: number): ReactNode => {
    if (c.render) return c.render(row, index);
    const v = c.value?.(row);
    if (v === null || v === undefined || v === '') return <span className="text-muted">{NA_SHORT}</span>;
    return typeof v === 'number' ? fmtNum(v) : v;
  };

  // ---- phone card view
  const actionCols = shown.filter((c) => c.mobileAction);
  const bodyCols = shown.filter((c) => !c.mobileAction);
  const primaryCol =
    bodyCols.find((c) => c.mobilePrimary) ??
    bodyCols.find((c) => PRIMARY_KEYS.has(c.key)) ??
    bodyCols.find((c) => Boolean(c.render) || Boolean(c.value)) ??
    bodyCols[0];
  const visibleFields = bodyCols.filter((c) => c !== primaryCol && !c.hideBelow).slice(0, 6);
  const cardFields = visibleFields.length ? visibleFields : bodyCols.filter((c) => c !== primaryCol).slice(0, 3);

  return (
    <div className={clsx('min-w-0', className)}>
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {toolbarRight}
          {csvFilename ? (
            <Button size="sm" icon={Download} onClick={exportCsv} disabled={!sorted.length} title="Export the rows currently loaded as CSV" className="max-sm:h-9">
              CSV
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Phones and portrait tablets: one readable card per row instead of a horizontally scrolling table. */}
      <div className={clsx('space-y-2 lg:hidden', loading && hasRows && 'opacity-60 transition-opacity')}>
        {loading && !hasRows
          ? Array.from({ length: 4 }, (_, i) => (
              <div key={`msk-${i}`} className="rounded-2xl border border-line/90 bg-surface p-3.5 shadow-card">
                <Skeleton className="h-4 w-2/3" />
                <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-line pt-2.5">
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-7 w-full" />
                </div>
              </div>
            ))
          : null}
        {!loading && !hasRows ? (
          <div className="overflow-hidden rounded-2xl border border-line/90 bg-surface">
            {showError ? (
              <ErrorState error={error} onRetry={onRetry} compact />
            ) : (
              <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} compact />
            )}
          </div>
        ) : null}
        {pageRows.map((row, i) => {
          const selected = isRowSelected?.(row);
          return (
            <div
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row, i) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row, i);
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              aria-selected={selected || undefined}
              className={clsx(
                'group/card rounded-2xl border bg-surface p-3.5 shadow-card transition-colors',
                onRowClick && 'cursor-pointer active:bg-surface-2',
                selected ? 'border-brand/50 bg-brand-soft/40' : 'border-line',
                rowClassName?.(row, i),
              )}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 text-[13px] font-medium text-ink">
                  {primaryCol ? renderCell(primaryCol, row, i) : null}
                </div>
                {actionCols.map((c) => (
                  <div key={c.key} className="shrink-0">
                    {renderCell(c, row, i)}
                  </div>
                ))}
                {onRowClick && !actionCols.length ? <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : null}
              </div>
              {cardFields.length ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line/70 pt-2">
                  {cardFields.map((c) => {
                    const label = mobileLabelOf(c);
                    const wide = WIDE_KEYS.has(c.key);
                    return (
                      <div key={c.key} className={clsx('min-w-0', wide && 'col-span-2')}>
                        {label ? <dt className="text-[10px] leading-4 font-semibold tracking-wide text-muted uppercase">{label}</dt> : null}
                        <dd className={clsx('mt-0.5 min-w-0 text-[12.5px] leading-snug text-ink', c.align === 'right' && 'atlas-num')}>{renderCell(c, row, i)}</dd>
                      </div>
                    );
                  })}
                </dl>
              ) : null}
            </div>
          );
        })}
      </div>

      {canScrollX ? (
        <div id={scrollHintId} className="hidden items-center justify-end gap-1.5 pb-1.5 text-[11.5px] text-muted lg:flex">
          <MoveHorizontal className="size-3.5" aria-hidden />
          Wide table — scroll sideways to see every column.
        </div>
      ) : null}

      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label={caption ? `${caption} (scrollable)` : 'Scrollable data table'}
        aria-describedby={canScrollX ? scrollHintId : undefined}
        className={clsx(
          'relative hidden overflow-auto rounded-xl border border-line/90 bg-surface lg:block',
          loading && hasRows && 'opacity-60 transition-opacity',
        )}
        style={maxHeight !== null ? { maxHeight } : undefined}
      >
        <table className="w-full text-[13px]">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {shown.map((c, ci) => {
                const sortable = c.sortable ?? (serverSort ? Boolean(c.sortKey) : Boolean(c.value));
                const key = serverSort ? (c.sortKey ?? c.key) : c.key;
                const active = sort?.key === key;
                const SortIcon = !active ? ChevronsUpDown : sort?.order === 'asc' ? ArrowUp : ArrowDown;
                const label = (
                  <span className={clsx('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                    {c.hint ? (
                      <Tooltip content={c.hint}>
                        <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">{c.header}</span>
                      </Tooltip>
                    ) : (
                      c.header
                    )}
                    {sortable ? <SortIcon className={clsx('size-3.5 shrink-0', active ? 'text-brand-ink' : 'opacity-40')} aria-hidden /> : null}
                  </span>
                );
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={c.width !== undefined ? { width: c.width } : undefined}
                    aria-sort={active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={clsx(
                      'sticky top-0 z-10 border-b border-line bg-surface-2/95 text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-ink-2 uppercase backdrop-blur',
                      headPad,
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                      c.sticky && ci === 0 && 'left-0 z-20',
                      c.hideBelow && HIDE[c.hideBelow],
                      c.headerClassName,
                    )}
                  >
                    {sortable ? (
                      <button type="button" onClick={() => onHeaderClick(c)} className="inline-flex items-center uppercase hover:text-ink">
                        {label}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && !hasRows
              ? Array.from({ length: Math.min(8, pageInfo?.size ?? 8) }, (_, i) => (
                  <tr key={`sk-${i}`}>
                    {shown.map((c) => (
                      <td key={c.key} className={clsx(cellPad, 'border-b border-line', c.hideBelow && HIDE[c.hideBelow])}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {!loading && !hasRows ? (
              <tr>
                <td colSpan={shown.length}>
                  {showError ? (
                    <ErrorState error={error} onRetry={onRetry} compact />
                  ) : (
                    <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} compact />
                  )}
                </td>
              </tr>
            ) : null}
            {pageRows.map((row, i) => {
              const selected = isRowSelected?.(row);
              return (
                <tr
                  key={rowKey(row, i)}
                  onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row, i);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-selected={selected || undefined}
                  className={clsx(
                    'group/row transition-colors',
                    onRowClick && 'cursor-pointer',
                    selected ? 'bg-brand-soft' : 'hover:bg-surface-2/80',
                    rowClassName?.(row, i),
                  )}
                >
                  {shown.map((c, ci) => {
                    const content = renderCell(c, row, i);
                    return (
                      <td
                        key={c.key}
                        className={clsx(
                          cellPad,
                          'border-b border-line align-middle text-ink',
                          c.align === 'right' && 'text-right whitespace-nowrap atlas-num',
                          c.align === 'center' && 'text-center',
                          c.sticky && ci === 0 && 'sticky left-0 z-[5] bg-surface group-hover/row:bg-surface-2',
                          c.hideBelow && HIDE[c.hideBelow],
                          c.className,
                        )}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageInfo && pageInfo.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 text-xs text-muted sm:gap-3">
          <div className="w-full sm:w-auto">
            Showing <span className="font-medium text-ink-2 atlas-num">{fmtNum((pageInfo.page - 1) * pageInfo.size + 1)}</span>–
            <span className="font-medium text-ink-2 atlas-num">{fmtNum(Math.min(pageInfo.page * pageInfo.size, pageInfo.total))}</span> of{' '}
            <span className="font-medium text-ink-2 atlas-num">{fmtNum(pageInfo.total)}</span>
          </div>
          <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <label className="inline-flex items-center gap-1.5">
              <span>Rows</span>
              <select
                value={pageInfo.size}
                onChange={(e) => setSize(Number(e.target.value))}
                className="h-7 cursor-pointer rounded-md border border-line-strong bg-surface px-1.5 text-xs text-ink max-sm:h-9 max-sm:text-base"
                aria-label="Rows per page"
              >
                {pageInfo.options.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="secondary"
                icon={ChevronLeft}
                disabled={pageInfo.page <= 1}
                onClick={() => setPage(pageInfo.page - 1)}
                aria-label="Previous page"
                className="max-sm:h-9 max-sm:w-9 max-sm:px-0!"
              />
              <span className="atlas-num">
                Page {fmtNum(pageInfo.page)} / {fmtNum(totalPages)}
              </span>
              <Button
                size="xs"
                variant="secondary"
                icon={ChevronRight}
                disabled={pageInfo.page >= totalPages}
                onClick={() => setPage(pageInfo.page + 1)}
                aria-label="Next page"
                className="max-sm:h-9 max-sm:w-9 max-sm:px-0!"
              />
            </div>
          </div>
        </div>
      ) : null}
      {footer ? <div className="pt-2 text-xs text-muted">{footer}</div> : null}
    </div>
  );
}
