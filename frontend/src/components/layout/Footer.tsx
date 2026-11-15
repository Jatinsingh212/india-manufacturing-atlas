/**
 * Footer - data credits, the provenance legend, the mapping caveat (SPEC data-honesty rule) and the
 * build / latest-year stamp from /api/health.
 */
import { useHealth } from '@/api/hooks';
import { fmtDate } from '@/lib/format';
import { ProvenanceLegend } from '../Provenance';

export const DATA_CREDITS =
  'India trade: DGFT/DGCIS TRADESTAT · World trade: CEPII BACI HS 2022 via OEC · Tariffs: WITS / UNCTAD TRAINS · Production: UNIDO INDSTAT, Rubber Board, ATMA · ' +
  'Nomenclature: WCO HS2022 and GST HSN master · Mapping: DPIIT Guidebook on HSN Code Mapping (16.12.2025)';

export function Footer() {
  const health = useHealth();
  const h = health.data;
  return (
    <footer className="atlas-no-print mt-8 border-t border-line bg-surface sm:mt-10">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-5 text-xs text-muted sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="text-ink-2">{DATA_CREDITS}</div>
          <ProvenanceLegend compact />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p className="max-w-3xl">
            Ministry ownership comes from the official DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision).
            Lines the Guidebook lists as residual, or does not list, stay residual; no rule-based owner is substituted.
            Production figures are sourced from UNIDO INDSTAT, the Rubber Board, ATMA or official uploads.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {h ? (
              <span>
                Latest trade year {h.latest_year ?? 'n/a'}
                {h.built_at ? ` · data built ${fmtDate(h.built_at)}` : ''}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </footer>
  );
}
