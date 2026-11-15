/**
 * AnalyticsPage - "Opportunity Lab" (route /analytics, GOV_ROLES; SPEC section 8, API section 6.6).
 *
 * Covers export potential, import dependency, RCA competitiveness, demand-supply gaps, untapped
 * markets and AI/ML insights with seven tabs:
 * Export potential, Import dependency, Import substitution, Competitiveness, Demand-supply,
 * Archetypes (rules + k-means) and the Forecast explorer.
 *
 * - Tabs are URL-synced (`?tab=`); alternative ids used elsewhere (`import_substitution`,
 *   `export_potential`, ...) are rewritten to the canonical ids below.
 * - One shared filter row (ministry, sector, value chain; `?ministry=&sector=&chain=`) scopes every tab
 *   except Demand-supply (its own chain / sector picker, sharing the same URL params) and the Forecast
 *   explorer, which works on a single code (`?code=`).
 * - Every score carries a "Model estimate" chip linking to /about#methodology; trade figures carry the
 *   BACI provenance badge.
 * - The route is gated to government roles in app/routes.tsx; the page gates itself as well so it is
 *   safe if mounted elsewhere.
 */
import { BrainCircuit, ChartScatter, Factory, Gauge, LineChart, Scale, TrendingUp } from 'lucide-react';
import { RequireRole } from '@/auth';
import { ModelEstimateTag, PageHeader, ProvenanceLegend, Tabs, type TabDef } from '@/components';
import { FilterBar, useAliasedTab, useSharedFilters } from './shared/filters';
import { ArchetypesTab } from './tabs/ArchetypesTab';
import { CompetitivenessTab } from './tabs/CompetitivenessTab';
import { DemandSupplyTab } from './tabs/DemandSupplyTab';
import { ExportPotentialTab } from './tabs/ExportPotentialTab';
import { ForecastTab } from './tabs/ForecastTab';
import { ImportDependencyTab } from './tabs/ImportDependencyTab';
import { SubstitutionTab } from './tabs/SubstitutionTab';

type TabId = 'potential' | 'dependency' | 'substitution' | 'competitiveness' | 'demand-supply' | 'archetypes' | 'forecast';

const TABS: ReadonlyArray<TabDef<TabId>> = [
  { id: 'potential', label: 'Export potential', icon: ChartScatter },
  { id: 'dependency', label: 'Import dependency', icon: Gauge },
  { id: 'substitution', label: 'Import substitution', icon: Factory },
  { id: 'competitiveness', label: 'Competitiveness', icon: TrendingUp },
  { id: 'demand-supply', label: 'Demand–supply', icon: Scale },
  { id: 'archetypes', label: 'Archetypes', icon: BrainCircuit },
  { id: 'forecast', label: 'Forecast explorer', icon: LineChart },
];

const TAB_IDS: ReadonlyArray<TabId> = TABS.map((t) => t.id);

/** Alternative tab ids (snake_case use-case ids, older links) -> canonical ids. */
const TAB_ALIASES: Readonly<Record<string, TabId>> = {
  export_potential: 'potential',
  opportunities: 'potential',
  opportunity: 'potential',
  import_dependency: 'dependency',
  dependencies: 'dependency',
  import_substitution: 'substitution',
  rca: 'competitiveness',
  demand_supply: 'demand-supply',
  demandsupply: 'demand-supply',
  clusters: 'archetypes',
  forecasts: 'forecast',
};

/** Tabs with their own scope picker instead of the shared filter row. */
const OWN_SCOPE: ReadonlySet<TabId> = new Set<TabId>(['demand-supply', 'forecast']);

export default function AnalyticsPage() {
  const shared = useSharedFilters();
  const [tab, setTab] = useAliasedTab(TAB_IDS, TAB_ALIASES, 'potential');

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Opportunity Lab"
        icon={TrendingUp}
        subtitle="Evidence-led screening of HS6 products for export potential, import dependence, substitution, competitiveness, demand–supply gaps and trends."
        meta={
          <>
            <ModelEstimateTag method="Scores, archetypes, clusters and forecasts follow the Atlas methodology" />
            <ProvenanceLegend compact />
          </>
        }
      />
      <RequireRole
        roles="gov"
        title="Opportunity Lab"
        description="Cross-ministry analytics on export potential, import dependency, substitution and forecasts is available to analysts, ministry officers and admins."
      >
        <Tabs<TabId> value={tab} onChange={setTab} tabs={TABS}>
          {(active) => (
            <div className="space-y-6">
              {!OWN_SCOPE.has(active) ? (
                <FilterBar api={shared} note="Filters apply to every chart and table in this tab. Values are HS6-level, latest year." />
              ) : null}
              {active === 'potential' ? <ExportPotentialTab filters={shared.filters} /> : null}
              {active === 'dependency' ? <ImportDependencyTab filters={shared.filters} /> : null}
              {active === 'substitution' ? <SubstitutionTab filters={shared.filters} /> : null}
              {active === 'competitiveness' ? <CompetitivenessTab filters={shared.filters} /> : null}
              {active === 'demand-supply' ? <DemandSupplyTab shared={shared} /> : null}
              {active === 'archetypes' ? <ArchetypesTab filters={shared.filters} /> : null}
              {active === 'forecast' ? <ForecastTab /> : null}
            </div>
          )}
        </Tabs>
      </RequireRole>
    </>
  );
}
