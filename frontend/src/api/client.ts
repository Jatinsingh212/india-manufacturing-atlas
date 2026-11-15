/**
 * Typed HTTP client for the Atlas API (docs/SPEC.md section 6).
 *
 * - Relative base URL (`/api/...`): the Vite dev server proxies to :8000, and in production FastAPI
 *   serves the SPA itself. `VITE_API_BASE` may point at another origin if ever needed.
 * - Sends `Authorization: Bearer <token>` when a session token is set (see `setAuthToken`).
 * - Every non-2xx response throws an {@link ApiError} `{status, detail}`; network failures throw
 *   status 0. A 401 while a token was sent dispatches the `atlas:unauthorized` window event, which
 *   AuthProvider uses to drop an expired session.
 * - One typed function per endpoint on the `api` object, e.g. `api.product('61091000')`. Every
 *   function accepts an optional trailing `RequestOptions` (pass React Query's `signal` through).
 *
 * Usage with React Query:
 *   useQuery({ queryKey: ['product', hsn8], queryFn: ({ signal }) => api.product(hsn8, { signal }) })
 */
import { QueryClient } from '@tanstack/react-query';
import type {
  AddTicketMessageResponse,
  AdminUser,
  AlertParams,
  Alert,
  AnalyticsFilters,
  ArchetypesResponse,
  AssistantStatus,
  AuditEntry,
  AuditParams,
  AuthResponse,
  ChatMessage,
  ChatResponse,
  ClaimRequest,
  ClaimReviewRequest,
  ClaimStatus,
  CompareResponse,
  CompetitivenessResponse,
  Country,
  CreateTicketRequest,
  CreateTicketResponse,
  CreateUserRequest,
  DataQualityResponse,
  DataSource,
  DemandSupplyParams,
  DemandSupplyResponse,
  DemoRole,
  EntityProductsParams,
  ForecastResponse,
  HealthResponse,
  ImportDependencyResponse,
  ImportSubstitutionResponse,
  InfoCard,
  LoginRequest,
  LookupResponse,
  MinistryDashboard,
  MinistryListItem,
  NegotiationParams,
  NegotiationResponse,
  NetworkParams,
  NetworkResponse,
  OpportunitiesResponse,
  OverviewResponse,
  Paginated,
  PolicyUseCase,
  ProductDetail,
  ProductSearchParams,
  ProductSummary,
  RefreshJob,
  RegisterRequest,
  ReportFormat,
  ReportKind,
  ResidualClaim,
  ResidualParams,
  ResidualProduct,
  ResidualSuggestResponse,
  RiskOverviewResponse,
  RiskRegisterRow,
  RoadmapItem,
  RoadmapResponse,
  RoadmapStatus,
  SchemeDetail,
  SchemeListItem,
  SearchReportParams,
  Section,
  SetTicketStatusResponse,
  SectorDashboard,
  SectorListItem,
  SimulateTariffRequest,
  SimulateTariffResponse,
  SkillCouncil,
  SkillingParams,
  SuggestItem,
  Ticket,
  TicketDetail,
  TicketListParams,
  TicketStats,
  TicketStatus,
  TraceParams,
  TraceResponse,
  TradeAgreement,
  TreeNode,
  TrendsParams,
  TrendsResponse,
  UpdateRiskRequest,
  UpdateUserRequest,
  Upload,
  UploadKind,
  UploadResponse,
  User,
  ValueChainDetail,
  ValueChainListItem,
  ValueChainMapping,
  ValueChainTiers,
  ApiErrorBody,
} from './types';

// ============================================================================ configuration & token

/** API origin; empty string = same origin (relative URLs). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** localStorage key that holds the JWT. */
export const TOKEN_STORAGE_KEY = 'atlas.token';

/** Event dispatched on `window` when an authenticated request comes back 401. */
export const UNAUTHORIZED_EVENT = 'atlas:unauthorized';

let authToken: string | null = readStoredToken();

function readStoredToken(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

/** Set (or clear with `null`) the bearer token used for all requests; persisted in localStorage. */
export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // storage unavailable (private mode / blocked): keep the in-memory token only
  }
}

/** Current bearer token, if any. */
export function getAuthToken(): string | null {
  return authToken;
}

// ============================================================================ errors

/**
 * Error thrown for every failed API call.
 * - `status`: HTTP status (0 = network failure / API unreachable)
 * - `detail`: human-readable message (FastAPI `detail`, 422 issues flattened)
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly body: unknown;

  constructor(status: number, detail: string, body?: unknown) {
    super(detail || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.body = body;
  }

  /** 401 - not signed in or the session expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  /** 403 - signed in, but the role does not grant access. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** 401 or 403. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isNetworkError(): boolean {
    return this.status === 0;
  }
  /** API unreachable or not responding (network failure, or 502 / 503 / 504 from a proxy). */
  get isUnavailable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/** Type guard for {@link ApiError}. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Best human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.detail;
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
}

function detailFromBody(body: unknown, status: number, statusText: string): string {
  const fallback = statusText ? `${status} ${statusText}` : `Request failed (${status})`;
  if (!body || typeof body !== 'object') return typeof body === 'string' && body.trim() ? body.slice(0, 300) : fallback;
  const detail = (body as ApiErrorBody).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      const loc = Array.isArray(d.loc) ? d.loc.filter((x) => x !== 'body' && x !== 'query').join('.') : '';
      return loc ? `${loc}: ${d.msg ?? 'invalid'}` : (d.msg ?? 'invalid value');
    });
    return parts.join('; ') || fallback;
  }
  return fallback;
}

// ============================================================================ request core

/** Query-string values accepted by {@link buildQuery}. Arrays are joined with commas. */
export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;
export type QueryParams = Record<string, QueryValue> | object;

/** Per-call options; `signal` lets React Query cancel stale requests. */
export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

interface RequestConfig extends RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  params?: QueryParams;
  body?: unknown;
  /** When true, resolve with the raw Response (for downloads). */
  raw?: boolean;
}

/** Serialise params into `?a=1&b=x`, dropping undefined / null / '' values. */
export function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, QueryValue>)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) sp.set(key, value.join(','));
    } else {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** Absolute-or-relative URL for an API path ('/api/...'), with optional query params. */
export function apiUrl(path: string, params?: QueryParams): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${p}${buildQuery(params)}`;
}

async function request<T>(path: string, config: RequestConfig = {}): Promise<T> {
  const { method = 'GET', params, body, signal, headers = {}, raw } = config;
  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  const token = authToken;
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // browser sets the multipart boundary
  } else if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path, params), { method, headers: finalHeaders, body: payload, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the Atlas API. Check that the backend is running on port 8000.');
  }

  if (!response.ok) {
    let errBody: unknown = null;
    const text = await response.text().catch(() => '');
    try {
      errBody = text ? JSON.parse(text) : null;
    } catch {
      errBody = text;
    }
    if (response.status === 401 && token && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    let detail = detailFromBody(errBody, response.status, response.statusText);
    if ([502, 503, 504].includes(response.status) && !(errBody && typeof errBody === 'object' && 'detail' in errBody)) {
      detail = `The Atlas API is not responding (${response.status}). Check that the backend is running on port 8000.`;
    }
    throw new ApiError(response.status, detail, errBody);
  }

  if (raw) return response as unknown as T;
  if (response.status === 204) return undefined as T;
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await response.json()) as T;
  return (await response.text()) as unknown as T;
}

// ============================================================================ primitives

/** GET `path` with query params; resolves with the parsed JSON body. */
export function apiGet<T>(path: string, params?: QueryParams, opts?: RequestOptions): Promise<T> {
  return request<T>(path, { ...opts, method: 'GET', params });
}

/** POST a JSON body. */
export function apiPost<T>(path: string, body?: unknown, params?: QueryParams, opts?: RequestOptions): Promise<T> {
  return request<T>(path, { ...opts, method: 'POST', body, params });
}

/** PATCH a JSON body. */
export function apiPatch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>(path, { ...opts, method: 'PATCH', body });
}

/** DELETE `path`. */
export function apiDelete<T = unknown>(path: string, params?: QueryParams, opts?: RequestOptions): Promise<T> {
  return request<T>(path, { ...opts, method: 'DELETE', params });
}

/**
 * POST multipart/form-data. `fields` become string parts; `file` is sent as the `file` part
 * (pass a ready FormData instead for full control).
 */
export function apiUpload<T>(
  path: string,
  data: FormData | { fields?: Record<string, string | number | boolean>; file?: Blob; fileName?: string },
  opts?: RequestOptions,
): Promise<T> {
  let form: FormData;
  if (data instanceof FormData) {
    form = data;
  } else {
    form = new FormData();
    for (const [k, v] of Object.entries(data.fields ?? {})) form.append(k, String(v));
    if (data.file) form.append('file', data.file, data.fileName ?? (data.file instanceof File ? data.file.name : 'upload'));
  }
  return request<T>(path, { ...opts, method: 'POST', body: form });
}

// ============================================================================ downloads

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** Save a Blob to disk via a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Fetch any API path with the session token and save the response body as a file.
 * The filename comes from Content-Disposition, else `fallbackName`. Resolves with the name used.
 */
export async function downloadFile(path: string, params?: QueryParams, fallbackName = 'download'): Promise<string> {
  const res = await request<Response>(path, { method: 'GET', params, raw: true, headers: { Accept: '*/*' } });
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName;
  saveBlob(blob, name);
  return name;
}

/**
 * Download a report: `GET /api/reports/{kind}/{id}?format=` (kind = product | ministry | sector | valuechain).
 * Pass `kind = 'search'` (id ignored) with search filters in `params` for the current-table export
 * (`GET /api/reports/search?...&format=csv|xlsx`).
 */
export function downloadReport(
  kind: ReportKind | 'search',
  id: string | null,
  format: ReportFormat,
  params?: QueryParams,
): Promise<string> {
  const ext = format;
  if (kind === 'search') {
    return downloadFile('/api/reports/search', { ...(params ?? {}), format }, `atlas-search.${ext}`);
  }
  return downloadFile(
    `/api/reports/${encodeURIComponent(kind)}/${encodeURIComponent(id ?? '')}`,
    { ...(params ?? {}), format },
    `atlas-${kind}-${id ?? 'report'}.${ext}`,
  );
}

// ============================================================================ helpers

const enc = encodeURIComponent;

/** Strip dots / spaces from a code typed by a user ("4011.10.10" -> "40111010"). */
export function normalizeCode(code: string): string {
  return code.replace(/[\s.]/g, '');
}

/** Accept either a list or a paginated envelope and always return the envelope. */
function asPage<T>(data: T[] | Paginated<T>): Paginated<T> {
  if (Array.isArray(data)) return { items: data, total: data.length, page: 1, page_size: data.length };
  return data;
}

/** Accept either a list or `{items: [...]}` and always return the list. */
function asList<T>(data: T[] | { items: T[] }): T[] {
  return Array.isArray(data) ? data : (data?.items ?? []);
}

// ============================================================================ endpoint functions

/**
 * One typed function per endpoint of SPEC section 6. Grouped in the same order as the SPEC.
 * All functions take an optional trailing {@link RequestOptions}.
 */
export const api = {
  // ---------------------------------------------------------------- 6.1 system / auth
  health: (o?: RequestOptions) => apiGet<HealthResponse>('/api/health', undefined, o),
  login: (body: LoginRequest, o?: RequestOptions) => apiPost<AuthResponse>('/api/auth/login', body, undefined, o),
  demoLogin: (role: DemoRole, o?: RequestOptions) => apiPost<AuthResponse>('/api/auth/demo-login', { role }, undefined, o),
  register: (body: RegisterRequest, o?: RequestOptions) => apiPost<AuthResponse>('/api/auth/register', body, undefined, o),
  me: (o?: RequestOptions) => apiGet<User>('/api/auth/me', undefined, o),

  // ---------------------------------------------------------------- 6.2 meta
  overview: (o?: RequestOptions) => apiGet<OverviewResponse>('/api/meta/overview', undefined, o),
  ministries: (o?: RequestOptions) => apiGet<MinistryListItem[]>('/api/meta/ministries', undefined, o),
  sectors: (o?: RequestOptions) => apiGet<SectorListItem[]>('/api/meta/sectors', undefined, o),
  sections: (o?: RequestOptions) => apiGet<Section[]>('/api/meta/sections', undefined, o),
  countries: (o?: RequestOptions) => apiGet<Country[]>('/api/meta/countries', undefined, o),
  info: (o?: RequestOptions) => apiGet<InfoCard[]>('/api/meta/info', undefined, o),

  // ---------------------------------------------------------------- 6.3 HSN
  searchProducts: (params: ProductSearchParams = {}, o?: RequestOptions) =>
    apiGet<Paginated<ProductSummary>>('/api/hsn/search', params, o),
  suggest: (q: string, o?: RequestOptions) => apiGet<SuggestItem[]>('/api/hsn/suggest', { q }, o),
  lookup: (code: string, o?: RequestOptions) => apiGet<LookupResponse>(`/api/hsn/lookup/${enc(normalizeCode(code))}`, undefined, o),
  product: (hsn8: string, o?: RequestOptions) => apiGet<ProductDetail>(`/api/hsn/product/${enc(normalizeCode(hsn8))}`, undefined, o),
  /** No code = the 21 sections; section id -> chapters; chapter -> headings; ... subheading -> 8-digit lines. */
  tree: (code?: string | null, o?: RequestOptions) => apiGet<TreeNode[]>('/api/hsn/tree', { code: code ?? undefined }, o),
  /** Up to 5 hsn8 codes. */
  compare: (codes: string[], o?: RequestOptions) =>
    apiGet<CompareResponse>('/api/hsn/compare', { codes: codes.map(normalizeCode).slice(0, 5) }, o),

  // ---------------------------------------------------------------- 6.4 ministries & sectors
  ministry: (id: string, o?: RequestOptions) => apiGet<MinistryDashboard>(`/api/ministries/${enc(id)}`, undefined, o),
  ministryProducts: (id: string, params: EntityProductsParams = {}, o?: RequestOptions) =>
    apiGet<Paginated<ProductSummary>>(`/api/ministries/${enc(id)}/products`, params, o),
  sector: (id: string, o?: RequestOptions) => apiGet<SectorDashboard>(`/api/sectors/${enc(id)}`, undefined, o),
  sectorProducts: (id: string, params: EntityProductsParams = {}, o?: RequestOptions) =>
    apiGet<Paginated<ProductSummary>>(`/api/sectors/${enc(id)}/products`, params, o),

  // ---------------------------------------------------------------- 6.5 value chains & network
  valueChains: (o?: RequestOptions) => apiGet<ValueChainListItem[]>('/api/valuechains', undefined, o),
  valueChain: (id: string, o?: RequestOptions) => apiGet<ValueChainDetail>(`/api/valuechains/${enc(id)}`, undefined, o),
  valueChainTiers: (id: string, o?: RequestOptions) =>
    apiGet<ValueChainTiers>(`/api/valuechains/${enc(id)}/tiers`, undefined, o),
  valueChainMapping: (id: string, stageId?: string | null, o?: RequestOptions) =>
    apiGet<ValueChainMapping>(`/api/valuechains/${enc(id)}/mapping`, { stage_id: stageId ?? undefined }, o),
  network: (params: NetworkParams = {}, o?: RequestOptions) => apiGet<NetworkResponse>('/api/network', params, o),
  trace: (code: string, params: TraceParams = {}, o?: RequestOptions) =>
    apiGet<TraceResponse>(`/api/network/trace/${enc(normalizeCode(code))}`, params, o),

  // ---------------------------------------------------------------- 6.6 analytics (GOV_ROLES)
  opportunities: (params: AnalyticsFilters = {}, o?: RequestOptions) =>
    apiGet<OpportunitiesResponse>('/api/analytics/opportunities', params, o),
  importDependency: (params: AnalyticsFilters = {}, o?: RequestOptions) =>
    apiGet<ImportDependencyResponse>('/api/analytics/import-dependency', params, o),
  importSubstitution: (params: AnalyticsFilters = {}, o?: RequestOptions) =>
    apiGet<ImportSubstitutionResponse>('/api/analytics/import-substitution', params, o),
  competitiveness: (params: AnalyticsFilters = {}, o?: RequestOptions) =>
    apiGet<CompetitivenessResponse>('/api/analytics/competitiveness', params, o),
  demandSupply: (params: DemandSupplyParams = {}, o?: RequestOptions) =>
    apiGet<DemandSupplyResponse>('/api/analytics/demand-supply', params, o),
  archetypes: (params: AnalyticsFilters = {}, o?: RequestOptions) => apiGet<ArchetypesResponse>('/api/analytics/archetypes', params, o),
  /** hs6 or hsn8 */
  forecast: (code: string, o?: RequestOptions) => apiGet<ForecastResponse>(`/api/analytics/forecast/${enc(normalizeCode(code))}`, undefined, o),
  trends: (params: TrendsParams = {}, o?: RequestOptions) => apiGet<TrendsResponse>('/api/analytics/trends', params, o),
  anomalies: (params: AlertParams & AnalyticsFilters = {}, o?: RequestOptions) =>
    apiGet<Alert[] | { items: Alert[] }>('/api/analytics/anomalies', params, o).then(asList),

  // ---------------------------------------------------------------- 6.7 policy
  useCases: (o?: RequestOptions) => apiGet<PolicyUseCase[]>('/api/policy/use-cases', undefined, o),
  schemes: (kind?: 'PLI' | 'QCO' | null, o?: RequestOptions) => apiGet<SchemeListItem[]>('/api/policy/schemes', { kind: kind ?? undefined }, o),
  scheme: (id: string, o?: RequestOptions) => apiGet<SchemeDetail>(`/api/policy/schemes/${enc(id)}`, undefined, o),
  agreements: (o?: RequestOptions) => apiGet<TradeAgreement[]>('/api/policy/agreements', undefined, o),
  /** GOV. Pass `partner` (country id) or `agreement` (agreement id). */
  negotiation: (params: NegotiationParams, o?: RequestOptions) => apiGet<NegotiationResponse>('/api/policy/negotiation', params, o),
  /** GOV. */
  simulateTariff: (body: SimulateTariffRequest, o?: RequestOptions) =>
    apiPost<SimulateTariffResponse>('/api/policy/simulate-tariff', body, undefined, o),
  skilling: (params: SkillingParams = {}, o?: RequestOptions) => apiGet<SkillCouncil[]>('/api/policy/skilling', params, o),

  // ---------------------------------------------------------------- 6.8 risk (GOV)
  riskOverview: (params: AnalyticsFilters = {}, o?: RequestOptions) => apiGet<RiskOverviewResponse>('/api/risk/overview', params, o),
  riskAlerts: (params: AlertParams = {}, o?: RequestOptions) =>
    apiGet<Alert[] | { items: Alert[] }>('/api/risk/alerts', params, o).then(asList),

  // ---------------------------------------------------------------- 6.9 residual workbench
  residual: (params: ResidualParams = {}, o?: RequestOptions) => apiGet<Paginated<ResidualProduct>>('/api/residual', params, o),
  residualSuggest: (hsn8: string, o?: RequestOptions) =>
    apiGet<ResidualSuggestResponse>(`/api/residual/suggest/${enc(normalizeCode(hsn8))}`, undefined, o),
  claimResidual: (hsn8: string, body: ClaimRequest, o?: RequestOptions) =>
    apiPost<ResidualClaim>(`/api/residual/${enc(normalizeCode(hsn8))}/claim`, body, undefined, o),
  residualClaims: (status?: ClaimStatus | null, o?: RequestOptions) =>
    apiGet<ResidualClaim[] | { items: ResidualClaim[] }>('/api/residual/claims', { status: status ?? undefined }, o).then(asList),
  reviewClaim: (id: number, body: ClaimReviewRequest, o?: RequestOptions) =>
    apiPost<ResidualClaim>(`/api/residual/claims/${id}/review`, body, undefined, o),

  // ---------------------------------------------------------------- 6.10 helpdesk
  createTicket: (body: CreateTicketRequest, o?: RequestOptions) => apiPost<CreateTicketResponse>('/api/tickets', body, undefined, o),
  tickets: (params: TicketListParams = {}, o?: RequestOptions) =>
    apiGet<Ticket[] | Paginated<Ticket>>('/api/tickets', params, o).then(asPage),
  ticket: (id: number, o?: RequestOptions) => apiGet<TicketDetail>(`/api/tickets/${id}`, undefined, o),
  /** Resolves with the new message and the ticket (whose status may have changed: open -> in_progress on a reply). */
  addTicketMessage: (id: number, body: string, o?: RequestOptions) =>
    apiPost<AddTicketMessageResponse>(`/api/tickets/${id}/messages`, { body }, undefined, o),
  /** Routed ministry / admin. Pass `routedMinistryId` to forward the ticket to another ministry. */
  setTicketStatus: (id: number, status: TicketStatus, routedMinistryId?: string | null, o?: RequestOptions) =>
    apiPost<SetTicketStatusResponse>(`/api/tickets/${id}/status`,
      { status, ...(routedMinistryId ? { routed_ministry_id: routedMinistryId } : {}) }, undefined, o),
  /** GOV. */
  ticketStats: (o?: RequestOptions) => apiGet<TicketStats>('/api/tickets/stats', undefined, o),

  // ---------------------------------------------------------------- 6.11 data hub
  dataSources: (o?: RequestOptions) => apiGet<DataSource[]>('/api/datahub/sources', undefined, o),
  /** admin. Starts a background refresh job. */
  refreshSource: (id: string, o?: RequestOptions) => apiPost<{ job: RefreshJob }>(`/api/datahub/sources/${enc(id)}/refresh`, undefined, undefined, o),
  jobs: (o?: RequestOptions) => apiGet<RefreshJob[] | { items: RefreshJob[] }>('/api/datahub/jobs', undefined, o).then(asList),
  /** ministry / admin. Multipart `kind` + `file` (.csv / .xlsx). */
  upload: (kind: UploadKind, file: File, o?: RequestOptions) =>
    apiUpload<UploadResponse>('/api/datahub/upload', { fields: { kind }, file, fileName: file.name }, o),
  /** admin. */
  applyUpload: (id: number, o?: RequestOptions) => apiPost<{ upload: Upload; applied?: number } & Record<string, unknown>>(`/api/datahub/uploads/${id}/apply`, undefined, undefined, o),
  uploads: (o?: RequestOptions) => apiGet<Upload[] | { items: Upload[] }>('/api/datahub/uploads', undefined, o).then(asList),
  /** URL of the CSV template for an upload kind (use with downloadFile for authenticated download). */
  templateUrl: (kind: UploadKind) => apiUrl(`/api/datahub/templates/${enc(kind)}`),
  downloadTemplate: (kind: UploadKind) => downloadFile(`/api/datahub/templates/${enc(kind)}`, undefined, `${kind}_template.csv`),
  /** GOV. */
  quality: (o?: RequestOptions) => apiGet<DataQualityResponse>('/api/datahub/quality', undefined, o),

  // ---------------------------------------------------------------- 6.12 reports
  /** Direct URL (no token) - prefer downloadReport(), which sends the token. */
  reportUrl: (kind: ReportKind, id: string, format: ReportFormat) => apiUrl(`/api/reports/${enc(kind)}/${enc(id)}`, { format }),
  downloadReport,
  downloadSearchReport: (params: SearchReportParams, format: Exclude<ReportFormat, 'pdf'>) => downloadReport('search', null, format, params),

  // ---------------------------------------------------------------- 6.13 admin, roadmap, risks, watchlist
  adminUsers: (o?: RequestOptions) => apiGet<AdminUser[] | { items: AdminUser[] }>('/api/admin/users', undefined, o).then(asList),
  createUser: (body: CreateUserRequest, o?: RequestOptions) => apiPost<AdminUser>('/api/admin/users', body, undefined, o),
  updateUser: (id: number, body: UpdateUserRequest, o?: RequestOptions) => apiPatch<AdminUser>(`/api/admin/users/${id}`, body, o),
  audit: (params: AuditParams = {}, o?: RequestOptions) =>
    apiGet<AuditEntry[] | Paginated<AuditEntry>>('/api/admin/audit', params, o).then(asPage),
  roadmap: (o?: RequestOptions) => apiGet<RoadmapResponse>('/api/roadmap', undefined, o),
  updateRoadmapItem: (id: string, status: RoadmapStatus, o?: RequestOptions) =>
    apiPatch<RoadmapItem>(`/api/roadmap/${enc(id)}`, { status }, o),
  risks: (o?: RequestOptions) => apiGet<RiskRegisterRow[] | { items: RiskRegisterRow[] }>('/api/risks', undefined, o).then(asList),
  updateRisk: (id: number, body: UpdateRiskRequest, o?: RequestOptions) => apiPatch<RiskRegisterRow>(`/api/risks/${id}`, body, o),
  watchlist: (o?: RequestOptions) => apiGet<ProductSummary[] | { items: ProductSummary[] }>('/api/watchlist', undefined, o).then(asList),
  addToWatchlist: (hsn8: string, o?: RequestOptions) => apiPost<unknown>(`/api/watchlist/${enc(normalizeCode(hsn8))}`, undefined, undefined, o),
  removeFromWatchlist: (hsn8: string, o?: RequestOptions) => apiDelete<unknown>(`/api/watchlist/${enc(normalizeCode(hsn8))}`, undefined, o),

  // ---------------------------------------------------------------- 6.14 AI assistant
  assistantStatus: (o?: RequestOptions) => apiGet<AssistantStatus>('/api/assistant/status', undefined, o),
  assistantChat: (messages: ChatMessage[], o?: RequestOptions) => apiPost<ChatResponse>('/api/assistant/chat', { messages }, undefined, o),
} as const;

export type Api = typeof api;

// ============================================================================ React Query client

/**
 * The app-wide QueryClient. Atlas data is rebuilt by the ETL, not streamed, so results are
 * cached for 5 minutes and not refetched on window focus. 4xx errors are not retried.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
