/**
 * ScoresPanel - the model scores of the product's HS6 subheading (SPEC section 4), each with a meter,
 * a one-line plain-language meaning, the "Model estimate" label and a link to the methodology:
 * export potential, untapped potential (US$), import dependency, vulnerability, substitution, plus the
 * rule-based archetype and the k-means cluster.
 */
import { BrainCircuit } from 'lucide-react';
import type { ProductScores, Provenance } from '@/api/types';
import { ArchetypeBadge, Badge, Card, EmptyState, ModelEstimateTag, ProvenanceBadge, ScoreBar } from '@/components';
import { fmtNum, fmtUSD } from '@/lib/format';
import type { ScoresExtras } from '../extras';

interface ScoreRowProps {
  label: string;
  value: number | null | undefined;
  scale: 'sequential' | 'risk';
  meaning: string;
  missing?: string;
}

function ScoreRow({ label, value, scale, meaning, missing = 'Not available for this product.' }: ScoreRowProps) {
  const has = typeof value === 'number' && Number.isFinite(value);
  return (
    <li className="py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="text-[11px] text-muted">{scale === 'risk' ? 'higher = more exposed' : 'higher = stronger'}</span>
      </div>
      <ScoreBar value={value} scale={scale} size="md" label={label} className="mt-1 [&>span:first-child]:hidden" />
      <p className="mt-1 text-[12px] leading-snug text-ink-2">{has ? meaning : missing}</p>
    </li>
  );
}

/** Fallback when the API sends no provenance with the scores: model output is never "verified". */
const MODEL_PROVENANCE: Provenance = { source: 'model', status: 'not_verified', label: 'Model estimate · Atlas methodology', year: null };

const ARCHETYPE_MEANING: Record<string, string> = {
  Champion: 'India is specialised (RCA ≥ 1) and its exports are growing at least as fast as world trade.',
  Established: 'India is specialised (RCA ≥ 1) but its exports grow more slowly than world trade.',
  Emerging: 'Not yet specialised (RCA 0.3–1), but India’s exports are outgrowing world trade.',
  Dependent: 'India imports at least twice what it exports, and over $50 mn.',
  Marginal: 'Small or weak position on every test above.',
};

/** Plain reading of the untapped-potential figure, including why it can be zero. */
function untappedMeaning(value: number | null | undefined, rca: number | null | undefined): string {
  const base = "Extra exports India would gain by reaching its chapter-average share of world trade in this product.";
  if (value !== 0) return base;
  if (typeof rca === 'number' && rca < 0.3) return `${base} Not counted here because India's RCA is below 0.3.`;
  return `${base} Zero: India's share already reaches that benchmark.`;
}

export function ScoresPanel({ scores, rca }: { scores: ProductScores | null; rca?: number | null }) {
  return (
    <Card
      title="Opportunity and risk scores"
      subtitle={
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>0–100 scores for the HS6 subheading</span>
          <ModelEstimateTag method="Percentile composites of trade size, RCA, growth, concentration and China share" />
        </span>
      }
      icon={BrainCircuit}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {scores ? <ProvenanceBadge provenance={(scores as ScoresExtras).provenance ?? MODEL_PROVENANCE} size="xs" /> : null}
        </div>
      }
    >
      {!scores ? (
        <EmptyState
          compact
          icon={BrainCircuit}
          title="Scores not available"
          message="No model scores for this subheading: they are computed only where world trade is recorded, after the scoring step of the data build. The trade facts on this page remain valid."
        />
      ) : (
        <div>
          {scores.product_readiness_index != null ? (
            <div className="mb-4 rounded-xl border border-brand/20 bg-gradient-to-br from-brand-soft/60 to-surface p-3.5 shadow-sm">
              {/* The title may wrap; the score never shrinks, so it is never clipped (it drops below the title only
                  when the card is very narrow). The tier badge gets its own full-width line so it is not truncated. */}
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1 text-[13.5px] font-bold leading-snug text-ink">
                  Product Readiness Index <span className="whitespace-nowrap">(PRI)</span>
                </div>
                <span className="atlas-num shrink-0 whitespace-nowrap text-[20px] font-extrabold leading-none text-brand-ink">
                  {scores.product_readiness_index.toFixed(1)}
                  <span className="text-[12px] font-semibold text-muted">/100</span>
                </span>
              </div>
              {(() => {
                const tier = scores.readiness_tier ?? (scores.product_readiness_index >= 75 ? 'Tier 1: Export Champion' : scores.product_readiness_index >= 50 ? 'Tier 2: Scale-Ready' : 'Tier 3: Substitution Target');
                return (
                  <Badge
                    tone={scores.product_readiness_index >= 75 ? 'success' : scores.product_readiness_index >= 50 ? 'info' : 'warning'}
                    size="sm"
                    title={tier}
                    className="mt-2"
                  >
                    {tier}
                  </Badge>
                );
              })()}
              <ScoreBar
                value={scores.product_readiness_index}
                scale="sequential"
                size="md"
                label="PRI"
                showValue={false}
                className="mt-2.5 [&>span:first-child]:hidden"
              />
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-2">
                Multidimensional policy & readiness benchmark combining <strong>35% Competitiveness</strong> (RCA & Archetype), <strong>25% Global Demand</strong> (Export potential), <strong>20% Policy Support</strong> (DPIIT & PLI schemes), and <strong>20% Standards & Resilience</strong> (BIS QCOs & supply resilience).
              </p>
            </div>
          ) : null}
          <ul className="divide-y divide-line">
            <ScoreRow
              label="Export potential"
              value={scores.export_potential_score}
              scale="sequential"
              meaning="How promising the product is for export growth: world market size, India's RCA, and world and Indian export growth."
            />
            <li className="py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-ink">Untapped export potential</span>
                <span className="text-[15px] font-bold text-kpi">{fmtUSD(scores.untapped_potential_usd)}</span>
              </div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{untappedMeaning(scores.untapped_potential_usd, rca)}</p>
            </li>
            <ScoreRow
              label="Import dependency"
              value={scores.import_dependency_score}
              scale="risk"
              meaning="How much India relies on imports for this product, how large they are and how concentrated the suppliers are."
            />
            <ScoreRow
              label="Supply-chain vulnerability"
              value={scores.vulnerability_score}
              scale="risk"
              meaning="Exposure to supply disruption: import dependence, supplier concentration, China's share and import size."
            />
            <ScoreRow
              label="Import substitution"
              value={scores.substitution_score}
              scale="sequential"
              meaning="Room to replace imports with domestic output, given India's competitiveness and how concentrated world supply is."
              missing="Not scored: substitution is assessed only where imports exceed exports and are at least $10 mn."
            />
          </ul>
          <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-ink">Archetype</span>
              <ArchetypeBadge archetype={scores.archetype} />
              {scores.ml_cluster !== null && scores.ml_cluster !== undefined ? (
                <span className="ml-auto text-[11.5px] text-muted">Cluster {fmtNum(scores.ml_cluster)} (k-means, k = 6)</span>
              ) : null}
            </div>
            {scores.archetype ? <p className="mt-1 text-[12px] leading-snug text-ink-2">{ARCHETYPE_MEANING[scores.archetype] ?? ''}</p> : null}
          </div>
        </div>
      )}
    </Card>
  );
}
