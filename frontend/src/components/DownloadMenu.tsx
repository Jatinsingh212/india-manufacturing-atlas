/**
 * DownloadMenu - "Download report" button with PDF / XLSX / CSV choices, calling
 * `GET /api/reports/{kind}/{id}?format=` (or `/api/reports/search?...` for kind="search") with the
 * session token, then saving the file. Errors surface as toasts.
 *
 *   <DownloadMenu kind="ministry" id="mot" />
 *   <DownloadMenu kind="search" params={filters} formats={['csv', 'xlsx']} label="Export table" />
 */
import { useState } from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText, Sheet } from 'lucide-react';
import { downloadReport, errorMessage, type QueryParams } from '@/api/client';
import type { ReportFormat, ReportKind } from '@/api/types';
import { Button, type ButtonSize, type ButtonVariant } from './Button';
import { Menu, type MenuItem } from './Menu';
import { useToast } from './Toast';

export interface DownloadMenuProps {
  kind: ReportKind | 'search';
  /** Entity id (hsn8, ministry id, sector id, chain id); ignored for kind="search". */
  id?: string | null;
  formats?: ReadonlyArray<ReportFormat>;
  /** Extra query params (search filters for kind="search"). */
  params?: QueryParams;
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  align?: 'left' | 'right';
  className?: string;
}

const FORMAT_META: Record<ReportFormat, { label: string; description: string; icon: typeof FileText }> = {
  pdf: { label: 'PDF report', description: 'KPIs, top tables and provenance notes', icon: FileText },
  xlsx: { label: 'Excel workbook (.xlsx)', description: 'All tables, one sheet each', icon: FileSpreadsheet },
  csv: { label: 'CSV data', description: 'Plain table for analysis tools', icon: Sheet },
};

export function DownloadMenu({
  kind,
  id = null,
  formats,
  params,
  label = 'Download report',
  size = 'sm',
  variant = 'secondary',
  align = 'right',
  className,
}: DownloadMenuProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const list: ReadonlyArray<ReportFormat> = formats ?? (kind === 'search' ? ['csv', 'xlsx'] : ['pdf', 'xlsx', 'csv']);

  const run = async (format: ReportFormat) => {
    setBusy(format);
    try {
      const name = await downloadReport(kind, id, format, params);
      toast.success('Download ready', name);
    } catch (err) {
      toast.error('Download failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const items: MenuItem[] = list.map((f) => ({
    label: FORMAT_META[f].label,
    description: FORMAT_META[f].description,
    icon: FORMAT_META[f].icon,
    onSelect: () => void run(f),
    disabled: busy !== null,
  }));

  return (
    <Menu
      align={align}
      width={260}
      className={className}
      items={items}
      trigger={(p) => (
        <Button {...p} size={size} variant={variant} icon={Download} iconRight={ChevronDown} loading={busy !== null} disabled={kind !== 'search' && !id}>
          {label}
        </Button>
      )}
    />
  );
}
