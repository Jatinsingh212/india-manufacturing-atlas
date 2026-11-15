/**
 * DataHubPage - route /data-hub (mixed access): real-time updating mechanism, CBIC / GSTN / DGFT and
 * trade database connectors, and data ownership per ministry.
 *
 * Tabs (URL `?tab=`, built with routes.dataHub(tab)):
 *   sources       registry of sources and connectors (public); admin refresh with job polling;
 *                 refresh history (government roles)
 *   uploads       official uploads: kind, template, validation preview with row errors, admin apply (GOV)
 *   quality       data-quality dashboard: coverage, mapping provenance, score histogram, by ministry,
 *                 BACI vs UN Comtrade cross-check (GOV)
 *   architecture  the real-time update architecture and what the CBIC / GSTN / DGFT connectors need (public)
 */
import { Database, Gauge, Network, Plug, Upload } from 'lucide-react';
import { RequireRole, useAuth } from '@/auth';
import { Badge, PageHeader, ProvenanceLegend, Tabs, type TabDef } from '@/components';
import { ArchitectureTab } from './components/ArchitectureTab';
import { QualityTab } from './components/QualityTab';
import { SourcesTab } from './components/SourcesTab';
import { UploadsTab } from './components/UploadsTab';

type TabId = 'sources' | 'uploads' | 'quality' | 'architecture';

export default function DataHubPage() {
  const { isGov } = useAuth();
  const tabs: TabDef<TabId>[] = [
    { id: 'sources', label: 'Sources & connectors', icon: Plug },
    { id: 'uploads', label: 'Uploads', icon: Upload, badge: isGov ? undefined : 'Gov only' },
    { id: 'quality', label: 'Data quality', icon: Gauge, badge: isGov ? undefined : 'Gov only' },
    { id: 'architecture', label: 'Real-time updates', icon: Network },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Data Hub"
        icon={Database}
        subtitle="Where every number in the Atlas comes from: live connectors, official ministry uploads, refresh history and data-quality checks."
        meta={
          <>
            <Badge tone="outline">India trade: DGCIS TRADESTAT FY2018-19 to FY2024-25</Badge>
            <Badge tone="outline">World trade: CEPII BACI 2018–2024</Badge>
            <Badge tone="outline">Tariffs: WITS / TRAINS 2022</Badge>
            <ProvenanceLegend compact />
          </>
        }
      />
      <Tabs<TabId> tabs={tabs} urlParam="tab" defaultValue="sources">
        {(active) =>
          active === 'sources' ? (
            <SourcesTab />
          ) : active === 'uploads' ? (
            <RequireRole
              roles="gov"
              title="Official uploads"
              description="Ministry officers upload the official mapping, production data and value-chain links; administrators validate and apply them."
              compact
            >
              <UploadsTab />
            </RequireRole>
          ) : active === 'quality' ? (
            <RequireRole roles="gov" title="Data-quality dashboard" description="Coverage, mapping provenance, quality scores and the BACI vs UN Comtrade cross-check." compact>
              <QualityTab />
            </RequireRole>
          ) : (
            <ArchitectureTab />
          )
        }
      </Tabs>
    </>
  );
}
