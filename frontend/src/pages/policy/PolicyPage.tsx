/**
 * PolicyPage - "Policy Workbench" (route /policy; SPEC section 8, API section 6.7).
 *
 * Supports import substitution strategies, PLI scheme targeting, trade negotiations, skilling
 * programmes and quality-control interventions. Tabs:
 * - Use cases           the five use cases as cards linking into the tools (public)
 * - PLI targeting       schemes -> scheme detail with product coverage and dependencies (public)
 * - Quality control     Quality Control Orders and the imports they cover (public; QualityControlTab.tsx)
 * - Trade negotiations  agreement / partner analyser: offensive & defensive interests (GOV)
 * - Tariff simulator    BCD scenario with downstream cost propagation (GOV)
 * - Skilling            Sector Skill Councils by value chain / sector (public)
 *
 * The route is public; the negotiation analyser and tariff simulator are gated with <RequireRole>
 * (public users see an explanation and demo sign-in). Tabs are URL-synced (`?tab=`), and alternative
 * ids used by the use-case API (`pli_targeting`, `quality_control`, ...) are rewritten to these ids.
 */
import { Calculator, GraduationCap, Handshake, LayoutGrid, Lock, Scale, ShieldCheck, Target } from 'lucide-react';
import { RequireRole, useAuth } from '@/auth';
import { PageHeader, ProvenanceLegend, Tabs, type TabDef } from '@/components';
import { useAliasedTab } from '../analytics/shared/filters';
import { NegotiationTab } from './NegotiationTab';
import { QualityControlTab } from './QualityControlTab';
import { SchemesTab } from './SchemesTab';
import { SkillingTab } from './SkillingTab';
import { TariffSimulatorTab } from './TariffSimulatorTab';
import { UseCasesTab } from './UseCasesTab';

type TabId = 'use-cases' | 'pli' | 'qco' | 'negotiation' | 'tariff' | 'skilling';

const TAB_IDS: ReadonlyArray<TabId> = ['use-cases', 'pli', 'qco', 'negotiation', 'tariff', 'skilling'];

const TAB_ALIASES: Readonly<Record<string, TabId>> = {
  use_cases: 'use-cases',
  usecases: 'use-cases',
  pli_targeting: 'pli',
  schemes: 'pli',
  quality_control: 'qco',
  qcos: 'qco',
  trade_negotiations: 'negotiation',
  negotiations: 'negotiation',
  fta: 'negotiation',
  tariff_simulator: 'tariff',
  simulator: 'tariff',
  simulate: 'tariff',
  skills: 'skilling',
};

export default function PolicyPage() {
  const { isGov } = useAuth();
  const [tab, setTab] = useAliasedTab(TAB_IDS, TAB_ALIASES, 'use-cases');
  const lock = isGov ? undefined : <Lock className="size-3" aria-label="Government sign-in required" />;

  const tabs: ReadonlyArray<TabDef<TabId>> = [
    { id: 'use-cases', label: 'Use cases', icon: LayoutGrid },
    { id: 'pli', label: 'PLI targeting', icon: Target },
    { id: 'qco', label: 'Quality control (QCO)', icon: ShieldCheck },
    { id: 'negotiation', label: 'Trade negotiations', icon: Handshake, badge: lock },
    { id: 'tariff', label: 'Tariff simulator', icon: Calculator, badge: lock },
    { id: 'skilling', label: 'Skilling', icon: GraduationCap },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Policy Workbench"
        icon={Scale}
        subtitle="Product-level evidence for five policy use cases: import substitution, PLI targeting, trade negotiations, skilling and quality control."
        meta={<ProvenanceLegend compact />}
      />
      <Tabs<TabId> value={tab} onChange={setTab} tabs={tabs}>
        {(active) => (
          <>
            {active === 'use-cases' ? <UseCasesTab /> : null}
            {active === 'pli' ? <SchemesTab /> : null}
            {active === 'qco' ? <QualityControlTab /> : null}
            {active === 'negotiation' ? (
              <RequireRole
                roles="gov"
                title="Trade negotiation analyser"
                description="Offensive and defensive interests for FTA / CEPA partners, built from bilateral HS6 trade, RCA and India's tariffs."
              >
                <NegotiationTab />
              </RequireRole>
            ) : null}
            {active === 'tariff' ? (
              <RequireRole
                roles="gov"
                title="Tariff scenario simulator"
                description="Test a Basic Customs Duty change: import response, customs revenue, domestic opportunity and the cost passed to downstream industries."
              >
                <TariffSimulatorTab />
              </RequireRole>
            ) : null}
            {active === 'skilling' ? <SkillingTab /> : null}
          </>
        )}
      </Tabs>
    </>
  );
}
