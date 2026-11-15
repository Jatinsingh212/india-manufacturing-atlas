/**
 * ProductInsight - one product in plain sentences: who owns it, how strong India is (RCA, world share,
 * rank), whether India is a net exporter or importer and how concentrated its suppliers are, and the
 * model's verdict (archetype). Every number comes from the ProductDetail payload; sentences whose
 * inputs are missing are skipped.
 */
import type { ProductDetail } from '@/api/types';
import { Insight, Term, type InsightPoint } from '@/components';
import { fmtOrdinal, fmtPct, fmtUSD } from '@/lib/format';
import { tradeOf } from '../extras';

const ARCHETYPE_MEANING: Record<string, string> = {
  Champion: 'India is strong in it and gaining share faster than world demand grows.',
  Established: 'India is strong in it, but its exports grow slower than world demand.',
  Emerging: 'India is not yet strong, but its exports grow faster than the world market.',
  Dependent: 'India imports far more than it exports.',
  Marginal: 'India has little trade in it either way.',
};

export function ProductInsight({ p }: { p: ProductDetail }) {
  const t = tradeOf(p);
  const owner = p.ministries.find((m) => m.role === 'primary') ?? p.ministries[0];
  const points: InsightPoint[] = [];

  if (owner && owner.id !== 'residual') {
    points.push({
      tone: 'info',
      text: (
        <>
          Owned by the <b>{owner.name}</b>
          {p.mapping.source === 'rule' ? ' (provisional mapping, not verified by the Guidebook)' : ''}.
        </>
      ),
    });
  } else {
    points.push({ tone: 'bad', text: <>No ministry owns this line yet: it is a <Term k="residual">residual code</Term>.</> });
  }

  if (t && t.rca !== null) {
    const strong = t.rca >= 1;
    points.push({
      tone: strong ? 'good' : 'info',
      text: (
        <>
          <Term k="rca">RCA</Term> <b>{t.rca.toFixed(2)}</b>: India is{' '}
          {strong ? <>relatively <b>strong</b> in this product{t.rca >= 2 ? <> ({t.rca.toFixed(1)}× its usual share of world exports)</> : null}</> : <>relatively <b>weak</b> in this product</>}
          {t.india_world_share !== null ? <>, with {fmtPct(t.india_world_share, { digits: 1 })} of world exports</> : null}
          {t.india_supplier_rank ? <> (<b>{fmtOrdinal(t.india_supplier_rank)}</b>{t.n_suppliers ? ` of ${t.n_suppliers}` : ''} exporters)</> : null}.
        </>
      ),
    });
  }

  if (t && t.exports !== null && t.imports !== null) {
    const net = t.exports - t.imports;
    const source = t.top_import_source_name ?? null;
    points.push({
      tone: net >= 0 ? 'good' : 'bad',
      text: (
        <>
          India exported <b>{fmtUSD(t.exports)}</b> and imported <b>{fmtUSD(t.imports)}</b> in {t.year}: a net{' '}
          {net >= 0 ? 'exporter' : 'importer'}.
          {source && t.top_import_source_share !== null && t.imports > 0 ? (
            <> {fmtPct(t.top_import_source_share, { digits: 0 })} of imports come from <b>{source}</b>{t.top_import_source_share >= 0.6 ? ', a concentrated supply' : ''}.</>
          ) : null}
        </>
      ),
    });
  }

  const arch = p.scores?.archetype;
  if (arch && ARCHETYPE_MEANING[arch]) {
    points.push({
      tone: arch === 'Champion' || arch === 'Established' ? 'good' : arch === 'Dependent' ? 'bad' : 'info',
      text: (
        <>
          <Term k="archetype">Archetype</Term>: <b>{arch}</b>. {ARCHETYPE_MEANING[arch]}
        </>
      ),
    });
  }

  return (
    <Insight
      points={points}
      title="This product in plain words"
      note={t?.trade_level === 'hs6' && (t.lines_in_hs6 ?? 1) > 1
        ? `Trade figures are for the 6-digit subheading, shared by ${t.lines_in_hs6} national lines.`
        : undefined}
    />
  );
}
