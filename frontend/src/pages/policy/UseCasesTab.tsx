/**
 * Use cases tab (Policy Workbench) - GET /api/policy/use-cases.
 *
 * The five policy use cases (import substitution, PLI scheme targeting, trade negotiations, skilling
 * programmes, quality-control interventions) as cards. Each card states the
 * policy question, the metrics the platform brings, and links straight into the tools that answer it.
 * Tool links are fixed per use-case id (so they always land on a real tab); for any other id the
 * route supplied by the API is used.
 */
import { ArrowRight, Calculator, Factory, GraduationCap, Handshake, ShieldCheck, Sparkles, Target, type LucideIcon } from 'lucide-react';
import type { PolicyUseCase } from '@/api/types';
import { Badge, Button, QueryState } from '@/components';
import { routes } from '@/lib/routes';
import { useUseCases } from './api';

interface ToolLink {
  label: string;
  to: string;
  icon?: LucideIcon;
}

const USE_CASE_META: Record<string, { icon: LucideIcon; tools: ToolLink[]; gov?: boolean }> = {
  import_substitution: {
    icon: Factory,
    gov: true,
    tools: [
      { label: 'Substitution candidates', to: routes.analytics('substitution'), icon: Factory },
      { label: 'Tariff simulator', to: routes.policy('tariff'), icon: Calculator },
      { label: 'Supply-chain risk', to: routes.risk() },
    ],
  },
  pli_targeting: {
    icon: Target,
    tools: [
      { label: 'PLI targeting', to: routes.policy('pli'), icon: Target },
      { label: 'Export potential', to: routes.analytics('potential') },
    ],
  },
  trade_negotiations: {
    icon: Handshake,
    gov: true,
    tools: [
      { label: 'Negotiation analyser', to: routes.policy('negotiation'), icon: Handshake },
      { label: 'Tariff simulator', to: routes.policy('tariff') },
    ],
  },
  skilling: {
    icon: GraduationCap,
    tools: [
      { label: 'Sector Skill Councils', to: routes.policy('skilling'), icon: GraduationCap },
      { label: 'Value chains', to: routes.valueChains() },
    ],
  },
  quality_control: {
    icon: ShieldCheck,
    tools: [
      { label: 'Quality Control Orders', to: routes.policy('qco'), icon: ShieldCheck },
      { label: 'Import dependency', to: routes.analytics('dependency') },
    ],
  },
};

function UseCaseCard({ uc, index }: { uc: PolicyUseCase; index: number }) {
  const meta = USE_CASE_META[uc.id];
  const Icon = meta?.icon ?? Sparkles;
  const tools: ToolLink[] = meta?.tools ?? (uc.route ? [{ label: 'Open tool', to: uc.route }] : []);
  const [primary, ...rest] = tools;
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-navy text-white" aria-hidden>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wider text-brand-ink uppercase">Use case {index + 1}</div>
          <h3 className="text-[15.5px] leading-snug font-semibold text-ink">{uc.title}</h3>
        </div>
        {meta?.gov ? (
          <Badge tone="navy" size="xs" title="Some tools need a government sign-in">
            Gov tools
          </Badge>
        ) : null}
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{uc.description}</p>
      {uc.question ? (
        <blockquote className="mt-3 rounded-lg border-l-4 border-kpi bg-kpi-soft/50 px-3 py-2 text-[13px] font-medium text-ink">{uc.question}</blockquote>
      ) : null}
      {uc.metrics?.length ? (
        <ul className="mt-3 space-y-1 text-[12.5px] leading-snug text-ink-2" aria-label="Key figures">
          {uc.metrics.map((m) => (
            <li key={m} className="flex gap-2">
              <span className="mt-[0.45em] size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
              <span className="atlas-num">{m.replace(/>=/g, '≥').replace(/<=/g, '≤')}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {primary ? (
          <Button to={primary.to} variant="primary" size="sm" icon={primary.icon} iconRight={ArrowRight}>
            {primary.label}
          </Button>
        ) : null}
        {rest.map((t) => (
          <Button key={t.to} to={t.to} variant="secondary" size="sm" icon={t.icon}>
            {t.label}
          </Button>
        ))}
      </div>
    </article>
  );
}

export function UseCasesTab() {
  const q = useUseCases();
  return (
    <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No policy use cases are configured">
      {(d) => (
        <div className="space-y-4">
          <p className="max-w-3xl text-[13.5px] text-ink-2">
            The Policy Workbench supports five policy use cases. Each card names the question officials ask and opens
            the Atlas tools that answer it with product-level evidence.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {d.map((uc, i) => (
              <UseCaseCard key={uc.id} uc={uc} index={i} />
            ))}
          </div>
        </div>
      )}
    </QueryState>
  );
}
