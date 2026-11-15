/**
 * Data Hub data hooks (SPEC section 6.11).
 *
 *   GET  /api/datahub/sources                 public: registry of sources and connectors
 *   POST /api/datahub/sources/{id}/refresh    admin: starts a background refresh job -> {job}
 *   GET  /api/datahub/jobs                    GOV: recent refresh jobs (polled while one is running)
 *   POST /api/datahub/upload                  ministry / admin: multipart kind + file -> validation preview
 *   POST /api/datahub/uploads/{id}/apply      admin: apply the valid rows
 *   GET  /api/datahub/uploads                 GOV: upload history
 *   GET  /api/datahub/templates/{kind}        CSV template download
 *   GET  /api/datahub/quality                 GOV: coverage, by-ministry quality, BACI vs Comtrade checks
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import type { RefreshJob, UploadKind, UploadResponse } from '@/api/types';
import { useToast } from '@/components';

export const datahubKeys = {
  all: ['datahub'] as const,
  sources: queryKeys.dataSources,
  jobs: ['datahub', 'jobs'] as const,
  uploads: ['datahub', 'uploads'] as const,
  quality: ['datahub', 'quality'] as const,
};

/** Poll interval while a refresh job is running. */
export const JOB_POLL_MS = 2000;

export function useDataSources() {
  return useQuery({ queryKey: datahubKeys.sources, queryFn: ({ signal }) => api.dataSources({ signal }), staleTime: 60 * 1000 });
}

/**
 * Recent refresh jobs. Polls every {@link JOB_POLL_MS} while any job is running or while the page
 * is waiting for a job it started (`watching`).
 */
export function useJobs(enabled: boolean, watching: boolean) {
  return useQuery({
    queryKey: datahubKeys.jobs,
    queryFn: ({ signal }) => api.jobs({ signal }),
    enabled,
    staleTime: 10 * 1000,
    refetchInterval: (query) => {
      const data = query.state.data as RefreshJob[] | undefined;
      return watching || (data ?? []).some((j) => j.status === 'running') ? JOB_POLL_MS : false;
    },
  });
}

export function useUploads(enabled: boolean) {
  return useQuery({ queryKey: datahubKeys.uploads, queryFn: ({ signal }) => api.uploads({ signal }), enabled, staleTime: 30 * 1000 });
}

export function useQuality(enabled: boolean) {
  return useQuery({ queryKey: datahubKeys.quality, queryFn: ({ signal }) => api.quality({ signal }), enabled });
}

/** Admin: start a connector refresh. */
export function useRefreshSource(onStarted: (job: RefreshJob) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.refreshSource(id),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: datahubKeys.jobs });
      onStarted(res.job);
    },
    onError: (e) => toast.error('The refresh could not be started', errorMessage(e)),
  });
}

/** Ministry / admin: upload a file for validation. */
export function useUploadFile(onValidated: (res: UploadResponse) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { kind: UploadKind; file: File }) => api.upload(v.kind, v.file),
    onSuccess: (res) => {
      const errs = res.errors.length;
      if (errs) toast.info('File validated with errors', `${res.upload.rows_valid ?? 0} valid rows, ${errs} row error${errs === 1 ? '' : 's'}.`);
      else toast.success('File validated', `${res.upload.rows_valid ?? 0} valid rows ready to apply.`);
      void qc.invalidateQueries({ queryKey: datahubKeys.uploads });
      onValidated(res);
    },
    onError: (e) => toast.error('The upload failed', errorMessage(e)),
  });
}

/** Admin: apply a validated upload. */
export function useApplyUpload() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: number) => api.applyUpload(id),
    onSuccess: (res, id) => {
      // SPEC leaves the body open: `applied` may be a row count or the router's stats object
      // ({rows, owners_changed, ...}); summarise whichever arrives.
      const stats = res.applied as unknown;
      const rows = typeof stats === 'number' ? stats : (stats && typeof stats === 'object' ? (stats as Record<string, unknown>).rows : undefined) ?? res.upload?.rows_valid;
      const extras =
        stats && typeof stats === 'object'
          ? Object.entries(stats as Record<string, unknown>)
              .filter(([k, v]) => k !== 'rows' && typeof v === 'number' && v > 0)
              .map(([k, v]) => `${(v as number).toLocaleString('en-IN')} ${k.replace(/_/g, ' ')}`)
          : [];
      const head = typeof rows === 'number' ? `${rows} row${rows === 1 ? '' : 's'} written to the Atlas` : 'Rows written to the Atlas';
      toast.success(`Upload #${id} applied`, extras.length ? `${head} (${extras.join(', ')}).` : `${head}.`);
      void qc.invalidateQueries({ queryKey: datahubKeys.all });
      // Mapping / production changes ripple into every dashboard.
      void qc.invalidateQueries({ queryKey: ['meta'] });
      void qc.invalidateQueries({ queryKey: ['hsn'] });
      void qc.invalidateQueries({ queryKey: ['ministries'] });
      void qc.invalidateQueries({ queryKey: ['residual'] });
    },
    onError: (e) => toast.error('The upload could not be applied', errorMessage(e)),
  });
}
