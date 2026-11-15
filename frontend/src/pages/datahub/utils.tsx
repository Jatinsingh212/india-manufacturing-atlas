/**
 * Data Hub helpers: status badges for sources / jobs / uploads, the upload-kind catalogue, a small
 * cron humaniser and scale normalisation for percentage fields the SPEC leaves open.
 */
import { CircleCheck, CircleDashed, CircleX, Database, FileText, Hand, KeyRound, LoaderCircle, Plug } from 'lucide-react';
import type { DataQualityResponse, DataSource, RefreshJob, Upload, UploadKind, UploadResponse } from '@/api/types';
import { Badge, type BadgeTone } from '@/components';

type IconT = typeof CircleCheck;

/**
 * Source statuses (SPEC 6.11). `not_refreshed` is a live connector that needs no credentials but has
 * never run successfully (e.g. UN Comtrade before its first refresh): neutral, never shown as Connected.
 */
const SOURCE_STATUS: Record<string, { tone: BadgeTone; label: string; icon: IconT }> = {
  connected: { tone: 'success', label: 'Connected', icon: CircleCheck },
  not_refreshed: { tone: 'neutral', label: 'Not yet refreshed', icon: CircleDashed },
  not_configured: { tone: 'orange', label: 'Needs credentials', icon: KeyRound },
  error: { tone: 'danger', label: 'Error', icon: CircleX },
};

/** Human label of a source status ("Not yet refreshed"), for text and CSV cells. */
export function sourceStatusLabel(status: DataSource['status']): string {
  return SOURCE_STATUS[status]?.label ?? status;
}

export function SourceStatusBadge({ status }: { status: DataSource['status'] }) {
  const s = SOURCE_STATUS[status] ?? { tone: 'neutral' as BadgeTone, label: status, icon: CircleDashed };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const JOB_STATUS: Record<string, { tone: BadgeTone; label: string; icon: IconT }> = {
  running: { tone: 'info', label: 'Running', icon: LoaderCircle },
  success: { tone: 'success', label: 'Succeeded', icon: CircleCheck },
  failed: { tone: 'danger', label: 'Failed', icon: CircleX },
  not_configured: { tone: 'orange', label: 'Not configured', icon: KeyRound },
};

export function JobStatusBadge({ status }: { status: RefreshJob['status'] }) {
  const s = JOB_STATUS[status] ?? { tone: 'neutral' as BadgeTone, label: status, icon: CircleDashed };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const UPLOAD_STATUS: Record<string, { tone: BadgeTone; label: string; icon: IconT }> = {
  validated: { tone: 'info', label: 'Validated', icon: CircleDashed },
  applied: { tone: 'success', label: 'Applied', icon: CircleCheck },
  rejected: { tone: 'danger', label: 'Rejected', icon: CircleX },
};

export function UploadStatusBadge({ status }: { status: Upload['status'] }) {
  const s = UPLOAD_STATUS[status] ?? { tone: 'neutral' as BadgeTone, label: status, icon: CircleDashed };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export const SOURCE_KIND: Record<string, { label: string; icon: IconT }> = {
  api: { label: 'API connector', icon: Plug },
  file: { label: 'File import', icon: FileText },
  manual: { label: 'Curated / manual', icon: Hand },
};

export function sourceKind(kind: string) {
  return SOURCE_KIND[kind] ?? { label: kind, icon: Database };
}

export const UPLOAD_KINDS: ReadonlyArray<{ value: UploadKind; label: string; columns: string; effect: string }> = [
  {
    value: 'ministry_mapping',
    label: 'Ministry mapping (official Guidebook)',
    columns: 'hsn8, ministry_id (or the ministry name)',
    effect: 'Applied rows override the current owner for those codes: mapping source becomes "official upload" and the status Verified. Codes not in the upload keep the DPIIT Guidebook owner or residual status.',
  },
  {
    value: 'production',
    label: 'Domestic production',
    columns: 'scope (hsn8 | hs6 | hs4 | chain), key, year, value, unit, source',
    effect: 'Adds production figures to product, sector and value-chain pages and to the demand-supply analysis.',
  },
  {
    value: 'value_chain_edges',
    label: 'Value-chain links',
    columns: 'src, dst, relation (input_to | component_of | parts_of), chain_id',
    effect: 'Adds input → output links between HS codes to the network graph and product upstream / downstream lists.',
  },
];

export const UPLOAD_KIND_LABELS: Record<string, string> = Object.fromEntries(UPLOAD_KINDS.map((k) => [k.value, k.label]));

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinal(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  return `${n}${m100 >= 11 && m100 <= 13 ? 'th' : m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th'}`;
}

/**
 * Human label for a 5-field cron expression ("0 2 1 * *" -> "Monthly, 1st at 02:00 UTC").
 * Unrecognised patterns are returned as-is; null means "on demand".
 */
export function describeCron(cron: string | null | undefined): string {
  if (!cron) return 'On demand';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC`;
  if (dom === '*' && month === '*' && dow === '*') return `Daily at ${time}`;
  if (dom === '*' && month === '*' && /^\d$/.test(dow)) return `Weekly on ${DOW[Number(dow) % 7]} at ${time}`;
  if (/^\d+$/.test(dom) && dow === '*') {
    if (month === '*') return `Monthly, ${ordinal(Number(dom))} at ${time}`;
    const step = /^\*\/(\d+)$/.exec(month);
    if (step) return Number(step[1]) === 3 ? `Quarterly, ${ordinal(Number(dom))} at ${time}` : `Every ${step[1]} months, ${ordinal(Number(dom))} at ${time}`;
  }
  return cron;
}

/**
 * Some quality fields are named *_pct but SPEC does not pin their scale. Detect it over the whole
 * column: if any value exceeds 1 the column is in percent, else it is a fraction. Returns fractions.
 */
export function columnAsFractions(values: Array<number | null | undefined>): Array<number | null> {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const percent = nums.some((v) => v > 1.0001);
  return values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? (percent ? v / 100 : v) : null));
}

/**
 * Like {@link columnAsFractions}, but resolves the scale even when every value is <= 1 (e.g. verified
 * mapping shares that are all below 1 %, where "0.47" may mean 0.47 % or 47 %). Each row's share is
 * weighted by its row count (`weights`, e.g. lines per ministry) and the implied total under each reading
 * is compared with the known total (`expectedTotal`, e.g. verified lines from the coverage block); the
 * closer reading wins. Without a usable total it falls back to the "> 1 means percent" rule.
 */
export function sharesAsFractions(
  values: Array<number | null | undefined>,
  weights: Array<number | null | undefined>,
  expectedTotal: number | null | undefined,
): Array<number | null> {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (values.some((v) => finite(v) && v > 1.0001) || !finite(expectedTotal)) return columnAsFractions(values);
  let impliedIfFraction = 0;
  values.forEach((v, i) => {
    const w = weights[i];
    if (finite(v) && finite(w)) impliedIfFraction += v * w;
  });
  const impliedIfPercent = impliedIfFraction / 100;
  const percent = Math.abs(impliedIfPercent - expectedTotal) < Math.abs(impliedIfFraction - expectedTotal);
  return values.map((v) => (finite(v) ? (percent ? v / 100 : v) : null));
}

/**
 * Fields the Data Hub router adds beyond SPEC 6.11 (all optional; see app/routers/datahub.py):
 * a source's connector description, a job's / upload's user name, an upload's error count.
 */
export interface ConnectorInfo {
  name?: string;
  refreshable?: boolean;
  configured?: boolean;
  message?: string | null;
  required_env?: string[];
}
export type SourceRow = DataSource & { connector?: ConnectorInfo | null; last_job?: RefreshJob | null };

/**
 * `cross_check_summary` of GET /api/datahub/quality (SPEC 6.11; not in src/api/types.ts yet). While no
 * cross-checks exist, `action` names the connector to run (UN Comtrade) and whether it can run.
 */
export interface CrossCheckAction {
  source_id: string;
  status?: DataSource['status'] | null;
  last_refreshed?: string | null;
  refreshable?: boolean | null;
  configured?: boolean | null;
  message?: string | null;
}
export interface CrossCheckSummary {
  n?: number | null;
  median_abs_diff?: number | null;
  within_10pct?: number | null;
  last_checked?: string | null;
  action?: CrossCheckAction | null;
}
export type QualityData = DataQualityResponse & { cross_check_summary?: CrossCheckSummary | null };
export type JobRow = RefreshJob & { source_name?: string | null; triggered_by_name?: string | null; duration_s?: number | null };
export type UploadRow = Upload & { uploaded_by_name?: string | null; n_errors?: number | null };

/** One preview row, normalised: SPEC sends the parsed row; the router sends `{row, valid, errors, values}`. */
export interface PreviewRow {
  row: number | null;
  valid: boolean | null;
  errors: string[];
  values: Record<string, unknown>;
}

export function normalisePreview(preview: UploadResponse['preview']): PreviewRow[] {
  return preview.map((r, i) => {
    const v = r.values;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return {
        row: typeof r.row === 'number' ? r.row : null,
        valid: typeof r.valid === 'boolean' ? r.valid : null,
        errors: Array.isArray(r.errors) ? r.errors.map(String) : [],
        values: v as Record<string, unknown>,
      };
    }
    return { row: i + 2, valid: null, errors: [], values: r };
  });
}

/** Number of row errors stored on an upload row (n_errors or errors_json), or null when unknown. */
export function uploadErrorCount(u: UploadRow): number | null {
  if (typeof u.n_errors === 'number') return u.n_errors;
  if (!u.errors_json) return typeof u.rows_total === 'number' && typeof u.rows_valid === 'number' ? Math.max(0, u.rows_total - u.rows_valid) : null;
  try {
    const parsed: unknown = JSON.parse(u.errors_json);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}
