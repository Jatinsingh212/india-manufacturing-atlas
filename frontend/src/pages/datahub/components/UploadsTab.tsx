/**
 * Uploads: official files from DPIIT and line ministries (data ownership per ministry).
 * Pick a kind -> download its CSV template -> upload .csv / .xlsx -> the server validates every row
 * and returns a preview with row errors -> an administrator applies the valid rows. The history table
 * lists every upload with its status; admins can apply validated uploads from there too.
 */
import { useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleX, Download, FileClock, FileSpreadsheet, FileUp, Info, ShieldCheck, Upload as UploadIcon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import type { Upload, UploadKind, UploadResponse } from '@/api/types';
import { useAuth } from '@/auth';
import { Badge, Button, Card, DataTable, FormField, KpiTile, Select, StatGrid, useToast, type Column } from '@/components';
import { fmtAgo, fmtDate, fmtNum } from '@/lib/format';
import { useApplyUpload, useUploadFile, useUploads } from '../api';
import { normalisePreview, UPLOAD_KIND_LABELS, UPLOAD_KINDS, UploadStatusBadge, uploadErrorCount, type PreviewRow, type UploadRow } from '../utils';

/** Server limit (app/routers/datahub.py): 10 MB and 50,000 rows per file. */
const MAX_BYTES = 10 * 1024 * 1024;

export function UploadsTab() {
  const { role, isAdmin } = useAuth();
  const canUpload = role === 'ministry' || role === 'admin';
  const uploads = useUploads(true);
  const [result, setResult] = useState<UploadResponse | null>(null);

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 xl:grid-cols-12">
        {canUpload ? (
          <UploadForm className="xl:col-span-7" onValidated={setResult} />
        ) : (
          <Card className="xl:col-span-7" title="Upload a file" icon={UploadIcon}>
            <div className="flex gap-3 rounded-lg border border-line bg-surface-2 p-3 text-[13px] text-ink-2">
              <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
              <p>
                Uploads come from the data owners: ministry officers upload files for their ministry and administrators apply them. As an analyst you can
                inspect the upload history and validation results.
              </p>
            </div>
          </Card>
        )}
        <Card className="xl:col-span-5" title="How official data enters the Atlas" icon={ShieldCheck} tone="subtle">
          <ol className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
            <li>
              <span className="font-semibold text-ink">1. Template.</span> Each kind has a CSV template with the exact column names.
            </li>
            <li>
              <span className="font-semibold text-ink">2. Validation.</span> Every row is checked (codes exist, ministries known, numbers parse); errors are
              reported per row and nothing is written yet.
            </li>
            <li>
              <span className="font-semibold text-ink">3. Apply.</span> An administrator applies the valid rows. Mapping rows become{' '}
              <span className="font-medium text-ink">official upload</span> (Verified) and override the current owner for those codes.
            </li>
            <li>
              <span className="font-semibold text-ink">4. Audit.</span> Upload and apply are written to the audit log with the user and row counts.
            </li>
          </ol>
        </Card>
      </div>

      {result ? <ValidationResult result={result} canApply={isAdmin} onApplied={(u) => setResult((r) => (r ? { ...r, upload: u } : r))} /> : null}

      <UploadHistory uploads={uploads.data} loading={uploads.isPending} error={uploads.error} onRetry={() => void uploads.refetch()} canApply={isAdmin} />
    </div>
  );
}

function UploadForm({ className, onValidated }: { className?: string; onValidated: (r: UploadResponse) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<UploadKind>('ministry_mapping');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadFile((res) => {
    onValidated(res);
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  });
  const meta = UPLOAD_KINDS.find((k) => k.value === kind) ?? UPLOAD_KINDS[0];

  const pick = (f: File | null) => {
    setFileError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!/\.(csv|xlsx)$/i.test(f.name)) {
      setFile(null);
      setFileError('Choose a .csv or .xlsx file.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setFileError('The file is larger than 10 MB; split it into smaller files.');
      return;
    }
    setFile(f);
  };

  const downloadTemplate = async () => {
    setDownloading(true);
    try {
      await api.downloadTemplate(kind);
    } catch (e) {
      toast.error('The template could not be downloaded', errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className={className} title="Upload a file" subtitle="Validated first; nothing changes until an administrator applies it." icon={UploadIcon}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) {
            setFileError('Choose a file to upload.');
            return;
          }
          upload.mutate({ kind, file });
        }}
      >
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Select<UploadKind> label="Upload kind" value={kind} onChange={(v) => setKind((v || 'ministry_mapping') as UploadKind)} options={UPLOAD_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
          <Button icon={Download} loading={downloading} onClick={() => void downloadTemplate()}>
            CSV template
          </Button>
        </div>
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
          <div className="text-ink">
            <span className="font-medium">Columns:</span> <code className="font-mono text-[12px] text-ink-2">{meta.columns}</code>
          </div>
          <div className="mt-1 text-ink-2">{meta.effect}</div>
        </div>
        <FormField label="File (.csv or .xlsx)" htmlFor="datahub-file" required error={fileError ?? undefined}>
          <label
            htmlFor="datahub-file"
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface px-4 py-4 transition-colors hover:border-brand hover:bg-brand-soft/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <FileSpreadsheet className="size-6 shrink-0 text-brand-ink" aria-hidden />
            <span className="min-w-0 flex-1 text-[13px]">
              {file ? (
                <>
                  <span className="block truncate font-medium text-ink">{file.name}</span>
                  <span className="text-muted">{fmtNum(Math.max(1, Math.round(file.size / 1024)))} KB · click to choose another</span>
                </>
              ) : (
                <>
                  <span className="block font-medium text-ink">Choose a file or drop it here</span>
                  <span className="text-muted">First sheet of an .xlsx, or a UTF-8 CSV with the template's header row</span>
                </>
              )}
            </span>
          </label>
          <input
            ref={inputRef}
            id="datahub-file"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </FormField>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" icon={FileUp} loading={upload.isPending}>
            Upload and validate
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ValidationResult({ result, canApply, onApplied }: { result: UploadResponse; canApply: boolean; onApplied: (u: Upload) => void }) {
  const apply = useApplyUpload();
  const u = result.upload as UploadRow;
  const total = u.rows_total ?? null;
  const valid = u.rows_valid ?? null;
  const preview = useMemo(() => normalisePreview(result.preview), [result.preview]);
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const row of preview) for (const k of Object.keys(row.values)) if (!keys.includes(k)) keys.push(k);
    const cols: Column<PreviewRow>[] = [
      { key: '_row', header: 'Row', align: 'right', value: (r) => r.row, width: 56, sortable: false },
      {
        key: '_valid',
        header: 'Check',
        sortable: false,
        value: (r) => (r.valid === null ? null : r.valid ? 'Valid' : 'Error'),
        render: (r) =>
          r.valid === null ? (
            <span className="text-muted">—</span>
          ) : r.valid ? (
            <Badge tone="success" size="xs" icon={CircleCheck}>
              Valid
            </Badge>
          ) : (
            <Badge tone="danger" size="xs" icon={CircleX}>
              Error
            </Badge>
          ),
      },
    ];
    for (const k of keys) {
      cols.push({
        key: k,
        header: k,
        sortable: false,
        value: (r) => {
          const v = r.values[k];
          return v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : String(v);
        },
        render: (r) => {
          const v = r.values[k];
          if (v === null || v === undefined || v === '') return <span className="text-muted">—</span>;
          const text = String(v);
          // Codes and identifiers in monospace; names and free text in the body face.
          return /^[\w.-]+$/.test(text) && !/\s/.test(text) ? (
            <span className="font-mono text-[12px]">{text}</span>
          ) : (
            <span className="line-clamp-2 min-w-32 text-[12.5px]" title={text}>
              {text}
            </span>
          );
        },
      });
    }
    if (preview.some((r) => r.errors.length)) {
      cols.push({
        key: '_errors',
        header: 'Problem',
        sortable: false,
        value: (r) => r.errors.join('; ') || null,
        render: (r) => (r.errors.length ? <span className="text-[12px] text-bad-ink">{r.errors.join('; ')}</span> : <span className="text-muted">—</span>),
      });
    }
    return cols;
  }, [preview]);
  const errorCols: Column<UploadResponse['errors'][number]>[] = [
    { key: 'row', header: 'Row', align: 'right', value: (e) => e.row, width: 80 },
    { key: 'error', header: 'Problem', value: (e) => e.error },
  ];

  return (
    <Card
      title={`Validation result · upload #${u.id}`}
      subtitle={`${UPLOAD_KIND_LABELS[u.kind] ?? u.kind} · ${u.filename}${u.uploaded_by_name ? ` · uploaded by ${u.uploaded_by_name}` : ''}`}
      icon={CircleAlert}
      actions={
        <>
          <UploadStatusBadge status={u.status} />
          {canApply ? (
            <Button
              variant="primary"
              size="sm"
              icon={ShieldCheck}
              loading={apply.isPending}
              disabled={u.status !== 'validated' || !valid}
              onClick={() => apply.mutate(u.id, { onSuccess: (res) => res.upload && onApplied(res.upload) })}
            >
              {u.status === 'applied'
                ? `Applied${u.applied_at ? ` ${fmtAgo(u.applied_at)}` : ''}`
                : `Apply ${valid !== null ? fmtNum(valid) : ''} valid row${valid === 1 ? '' : 's'}`}
            </Button>
          ) : (
            <Badge tone="outline">An administrator applies validated uploads</Badge>
          )}
        </>
      }
    >
      <StatGrid cols={3}>
        <KpiTile label="Rows read" value={fmtNum(total)} accent="ink" />
        <KpiTile label="Valid rows" value={fmtNum(valid)} accent="ok" sub={total ? `${Math.round(((valid ?? 0) / total) * 100)}% of the file` : undefined} />
        <KpiTile
          label="Rows with errors"
          value={fmtNum(result.errors.length)}
          accent={result.errors.length ? 'bad' : 'ink'}
          sub={result.errors.length ? (valid ? 'Fix and upload again, or apply the valid rows' : 'No valid rows: fix the file and upload again') : 'No problems found'}
        />
      </StatGrid>
      <div className="mt-5 grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-2 text-[13px] font-semibold text-ink">Preview (first {fmtNum(preview.length)} rows as parsed)</div>
          <DataTable columns={columns} rows={preview} rowKey={(r, i) => r.row ?? i} dense pagination={false} maxHeight={320} emptyTitle="The file has no data rows" />
        </div>
        <div className="min-w-0">
          <div className="mb-2 text-[13px] font-semibold text-ink">Row errors</div>
          <DataTable
            columns={errorCols}
            rows={result.errors}
            rowKey={(e, i) => `${e.row}-${i}`}
            dense
            pagination={{ mode: 'client', pageSize: 10 }}
            maxHeight={320}
            csvFilename={`upload-${u.id}-errors`}
            emptyTitle="No row errors"
            emptyMessage="Every row passed validation."
          />
        </div>
      </div>
    </Card>
  );
}

const uploader = (u: UploadRow) => u.uploaded_by_name ?? (u.uploaded_by ? `User #${u.uploaded_by}` : null);

function UploadHistory({ uploads, loading, error, onRetry, canApply }: { uploads: UploadRow[] | undefined; loading: boolean; error: unknown; onRetry: () => void; canApply: boolean }) {
  const apply = useApplyUpload();
  // Eight columns on screen (the uploader sits under the upload time and the applied date under the
  // status badge; both stay separate CSV columns), so the Apply button is inside the card at 1280px.
  const columns: Column<UploadRow>[] = [
    { key: 'id', header: 'Upload', align: 'right', value: (u) => u.id, render: (u) => <span className="text-muted atlas-num">#{u.id}</span>, width: 80 },
    {
      key: 'kind',
      header: 'Kind',
      value: (u) => UPLOAD_KIND_LABELS[u.kind] ?? u.kind,
      render: (u) => <span className="block max-w-44 leading-snug">{UPLOAD_KIND_LABELS[u.kind] ?? u.kind}</span>,
    },
    { key: 'filename', header: 'File', value: (u) => u.filename, render: (u) => <span className="block min-w-32 font-mono text-[12px] break-all">{u.filename}</span> },
    {
      key: 'ts',
      header: 'Uploaded',
      value: (u) => u.ts,
      render: (u) => (
        <div className="min-w-0 leading-snug">
          <span title={fmtDate(u.ts, { withTime: true })}>{fmtAgo(u.ts)}</span>
          {uploader(u) ? <div className="text-[11.5px] text-muted">by {uploader(u)}</div> : null}
        </div>
      ),
    },
    { key: 'by', header: 'Uploaded by', value: (u) => uploader(u), csvOnly: true },
    {
      key: 'status',
      header: 'Status',
      value: (u) => u.status,
      render: (u) => (
        <div className="min-w-0 leading-snug">
          <UploadStatusBadge status={u.status} />
          {u.applied_at ? <div className="mt-0.5 text-[11.5px] text-muted">{fmtDate(u.applied_at, { withTime: true })}</div> : null}
        </div>
      ),
    },
    { key: 'applied_at', header: 'Applied', value: (u) => u.applied_at, csvOnly: true },
    {
      key: 'rows',
      header: 'Valid / total',
      align: 'right',
      value: (u) => u.rows_valid,
      render: (u) => `${fmtNum(u.rows_valid, { na: '—' })} / ${fmtNum(u.rows_total, { na: '—' })}`,
    },
    { key: 'errors', header: 'Errors', align: 'right', value: (u) => uploadErrorCount(u), hideBelow: 'sm' },
    ...(canApply
      ? [
          {
            key: 'apply',
            header: <span className="sr-only">Actions</span>,
            sortable: false,
            csv: false as const,
            render: (u: UploadRow) =>
              u.status === 'validated' && (u.rows_valid ?? 0) > 0 ? (
                <Button size="xs" variant="primary" icon={ShieldCheck} loading={apply.isPending && apply.variables === u.id} disabled={apply.isPending} onClick={() => apply.mutate(u.id)}>
                  Apply
                </Button>
              ) : null,
          } satisfies Column<UploadRow>,
        ]
      : []),
  ];
  return (
    <Card title="Upload history" subtitle="Every file uploaded to the Atlas, newest first" icon={FileClock}>
      <DataTable
        columns={columns}
        rows={uploads}
        rowKey={(u) => u.id}
        loading={loading}
        error={error}
        onRetry={onRetry}
        defaultSort={{ key: 'ts', order: 'desc' }}
        pagination={{ mode: 'client', pageSize: 10, pageSizeOptions: [10, 25, 50] }}
        maxHeight={null}
        dense
        tight
        csvFilename="datahub-uploads"
        emptyTitle="No uploads yet"
        emptyMessage="The official Guidebook mapping, production data and value-chain links uploaded by ministries appear here."
      />
    </Card>
  );
}
