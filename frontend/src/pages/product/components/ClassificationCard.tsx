/**
 * ClassificationCard - the HS hierarchy of the line (section > chapter > heading > subheading > line,
 * each with its nomenclature text), the ministry mapping (status, source, provenance, confidence and the
 * rule that produced it), every ministry with its role, and the PLI / QCO schemes covering the line.
 */
import { Link } from 'react-router';
import { BadgeCheck, ListTree } from 'lucide-react';
import { useMinistryLookup } from '@/api/hooks';
import type { ProductDetail } from '@/api/types';
import { Badge, Card, MinistryPill, ProvenanceBadge, SectionLabel } from '@/components';
import { fmtCode, fmtPct, hsLevelName } from '@/lib/format';
import { routeForCode, routes } from '@/lib/routes';
import { mappingProvenance, MAPPING_SOURCE_LABELS, MAPPING_STATUS_LABELS } from '@/pages/explore/shared';

const RULE_LEVEL: Record<string, string> = { ch: 'Chapter', h: 'Heading', s: 'Subheading', l: 'Line' };

/**
 * Plain-language reading of the mapping rule id stored by the ETL:
 * - "dpiit:accepted:p141" / "dpiit:residual:p430" -> official DPIIT Guidebook (16.12.2025) page
 * - "not-in-dpiit-guidebook" -> line absent from both published Guidebook tables
 * - "ch61->mot", "h4011->dpiit", "s854143->mnre", "l33074100->msme"
 *                            -> provisional chapter / heading / subheading / line rule
 * - "t:ayush->ayush"         -> provisional text rule on the line description
 * Unknown ids are shown as they are.
 */
function ruleText(rule: string, shortName: (id: string) => string): string {
  const guidebook = /^dpiit:(accepted|residual)(?::p(\d+))?$/i.exec(rule);
  if (guidebook) {
    const where = guidebook[2] ? ` (Guidebook page ${guidebook[2]})` : '';
    return guidebook[1].toLowerCase() === 'accepted'
      ? `Official DPIIT Guidebook mapping${where}: this code was accepted by the owning ministry/department.`
      : `Official DPIIT Guidebook residual list${where}: no ministry/department accepted this code; ownership is unassigned.`;
  }
  if (rule === 'not-in-dpiit-guidebook') {
    return 'Not listed in either published table of the DPIIT Guidebook (16.12.2025 revision); left residual rather than assigned by rule.';
  }
  if (/^g:other-nec->residual$/i.test(rule)) {
    return "Generic 'Other' line of a subheading described as 'not elsewhere specified': left residual, as no single owner can be inferred";
  }
  const level = /^(ch|h|s|l)(\d{2,8})->([a-z_&]+)$/i.exec(rule);
  if (level) {
    const where = `${RULE_LEVEL[level[1].toLowerCase()]} ${fmtCode(level[2])}`;
    if (level[3] === 'residual') return `${where} is a cross-cutting catch-all: left residual (no single owner)`;
    if (level[1].toLowerCase() === 'ch') return `${where} default owner: ${shortName(level[3])}`;
    return `${where} rule: assigned to ${shortName(level[3])}`;
  }
  const text = /^t:([a-z0-9_-]+)->([a-z_&]+)$/i.exec(rule);
  if (text) return `Product-text rule "${text[1].replace(/[-_]/g, ' ')}" on the line description: assigned to ${shortName(text[2])}`;
  return rule;
}

export function ClassificationCard({ p }: { p: ProductDetail }) {
  const ministryLookup = useMinistryLookup();
  const shortName = (id: string) => ministryLookup.get(id)?.short_name ?? (id === p.ministry_id ? (p.ministry_short ?? id) : id);
  const levels = [...p.hierarchy].sort((a, b) => a.level - b.level);
  const m = p.mapping;
  const prov = m?.provenance ?? mappingProvenance(p.mapping_source, m?.status ?? p.mapping_status);
  const source = m?.source ?? p.mapping_source;
  const status = m?.status ?? p.mapping_status;
  const confidence = m?.confidence ?? p.mapping_confidence;
  const ministries = p.ministries.length
    ? p.ministries
    : [{ id: p.ministry_id, short_name: p.ministry_short ?? p.ministry_id, name: p.ministry_name ?? p.ministry_id, color: null, role: 'primary' }];

  return (
    <Card title="Classification and ownership" icon={ListTree} subtitle="HS 2022 hierarchy, ministry mapping and schemes">
      <div className="space-y-5">
        <ol className="space-y-1.5">
          {levels.map((h) => {
            const to = h.level === 0 ? `${routes.explore()}?code=${encodeURIComponent(h.code)}` : routeForCode(h.code);
            return (
              <li key={`${h.level}-${h.code}`} className="grid grid-cols-[6.5rem_1fr] gap-2 text-[12.5px]">
                <span className="text-muted">
                  {hsLevelName(h.level)}{' '}
                  <Link to={to ?? routes.explore()} className="font-mono font-medium text-brand-ink hover:underline">
                    {h.level === 0 ? h.code : fmtCode(h.code)}
                  </Link>
                </span>
                <span className="leading-snug text-ink-2">{h.description}</span>
              </li>
            );
          })}
          <li className="grid grid-cols-[6.5rem_1fr] gap-2 text-[12.5px]">
            <span className="text-muted">
              Line <span className="font-mono font-semibold text-ink">{fmtCode(p.hsn8)}</span>
            </span>
            <span className="leading-snug font-medium text-ink">{p.description}</span>
          </li>
        </ol>

        <div>
          <SectionLabel className="mb-2">Ministry mapping</SectionLabel>
          <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status === 'residual' ? 'orange' : 'success'}>{MAPPING_STATUS_LABELS[status] ?? status}</Badge>
              <span className="text-ink-2">{MAPPING_SOURCE_LABELS[source] ?? source}</span>
              <ProvenanceBadge provenance={prov} size="xs" className="ml-auto" />
            </div>
            {typeof confidence === 'number' ? (
              <div className="flex items-center gap-2">
                <span className="text-muted">Confidence</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(confidence * 100)}%` }} />
                </span>
                <span className="font-medium text-ink atlas-num">{fmtPct(confidence, { digits: 0 })}</span>
              </div>
            ) : null}
            {m?.rule ? (
              <p className="leading-snug text-ink-2" title={`Rule id: ${m.rule}`}>
                <span className="text-muted">Basis: </span>
                {ruleText(m.rule, shortName)}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {ministries.map((x) => (
                <MinistryPill key={`${x.id}-${x.role}`} ministry={x} role={x.role} full={x.role === 'primary'} />
              ))}
            </div>
            {p.parent_ownership ? (
              <div className="rounded-md border border-dashed border-line-strong bg-surface p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="warning" size="xs">Derived parent owner</Badge>
                  <MinistryPill ministry={p.parent_ownership.owner} size="xs" />
                  <span className="text-[11px] text-muted">
                    from {p.parent_ownership.level}-digit {fmtCode(p.parent_ownership.parent_code)} ·{' '}
                    {fmtPct(p.parent_ownership.coverage, { digits: 0 })} of lines accepted
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted">
                  This line is not directly accepted in the Guidebook. Its nearest parent with one accepted owner is
                  shown only as a research hint; the line remains residual and is not counted as verified.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <SectionLabel className="mb-2">Schemes covering this line</SectionLabel>
          {p.schemes.length ? (
            <div className="flex flex-wrap gap-1.5">
              {p.schemes.map((s) => (
                <Link
                  key={s.id}
                  to={routes.policy(s.kind === 'QCO' ? 'qco' : 'pli')}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:border-brand/50 hover:bg-brand-soft"
                  title={s.name}
                >
                  <Badge tone={s.kind === 'PLI' ? 'brand' : 'warning'} size="xs" icon={BadgeCheck}>
                    {s.kind}
                  </Badge>
                  <span className="max-w-[16rem] truncate">{s.name}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">No PLI scheme or quality control order is linked to this line.</p>
          )}
        </div>
      </div>
    </Card>
  );
}
