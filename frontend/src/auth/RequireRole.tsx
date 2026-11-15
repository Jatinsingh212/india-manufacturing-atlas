/**
 * Role gates and the "restricted" panels (SPEC section 5 access matrix).
 *
 *   <RequireRole roles="gov" title="Opportunity Lab">...gov-only page...</RequireRole>
 *   <RequireRole roles={['admin']}>...</RequireRole>
 *   <RequireRole roles={['industry', 'analyst', 'ministry', 'admin']} compact>...watchlist...</RequireRole>
 *
 * - `roles="gov"` = analyst | ministry | admin. Admin always passes.
 * - While a stored session is being validated a loading block is shown (no flash of the panel).
 * - Otherwise renders <RestrictedPanel>: explains the access model and offers demo sign-in buttons
 *   (Analyst, Ministry officer, Admin, Industry) plus a link to the full sign-in page.
 * - <SignInPrompt> is the compact variant (used by ErrorState for 401 / 403 responses).
 */
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import clsx from 'clsx';
import { Building, ChartColumn, Globe, KeyRound, Landmark, Lock, ShieldCheck, UserCog, type LucideIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { GOV_ROLES, type DemoRole, type Role } from '@/api/types';
import { Button } from '@/components/Button';
import { LoadingBlock } from '@/components/Loading';
import { useToast } from '@/components/Toast';
import { routes } from '@/lib/routes';
import { ROLE_LABELS, roleAllowed, useAuth } from './AuthContext';

/** Demo roles offered on restricted panels and the login page, in display order. */
export const DEMO_ROLES: Array<{ role: DemoRole; label: string; icon: LucideIcon; blurb: string }> = [
  { role: 'analyst', label: 'Analyst', icon: ChartColumn, blurb: 'Cross-ministry analytics, risk and residual review' },
  { role: 'ministry', label: 'Ministry officer', icon: Landmark, blurb: 'Own-ministry codes, claims, routed queries, uploads' },
  { role: 'admin', label: 'Admin', icon: UserCog, blurb: 'Users, approvals, connectors, audit log' },
  { role: 'industry', label: 'Industry', icon: Building, blurb: 'Watchlist and all reports' },
];

const ACCESS_TIERS: Array<{ icon: LucideIcon; title: string; text: string }> = [
  {
    icon: Globe,
    title: 'Public module',
    text: 'HSN Explorer, product pages, ministries, value chains, network, schemes, assistant and standard reports - no sign-in.',
  },
  {
    icon: Building,
    title: 'Industry',
    text: 'Registered industry users add a watchlist and every report.',
  },
  {
    icon: ShieldCheck,
    title: 'Government users',
    text: 'Analysts, ministry officers and admins add the Opportunity Lab, supply-chain risk, negotiation analyser, tariff simulator and data quality.',
  },
];

function rolesText(roles: readonly Role[] | 'gov'): string {
  const list = roles === 'gov' ? GOV_ROLES : roles;
  const labels = list.filter((r) => r !== 'public').map((r) => ROLE_LABELS[r]);
  if (labels.length <= 1) return labels[0] ?? 'signed-in users';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** Demo sign-in button row; `allowed` roles are emphasised. */
export function DemoLoginButtons({ allowed, size = 'md', className }: { allowed?: readonly Role[] | 'gov'; size?: 'sm' | 'md'; className?: string }) {
  const { demoLogin, role: currentRole } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<DemoRole | null>(null);
  const onClick = async (role: DemoRole) => {
    setBusy(role);
    try {
      const user = await demoLogin(role);
      toast.success(`Signed in as ${user.name ?? ROLE_LABELS[role]}`, `Demo ${ROLE_LABELS[role].toLowerCase()} account`);
    } catch (err) {
      toast.error('Demo sign-in failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={clsx('flex flex-wrap gap-2', className)}>
      {DEMO_ROLES.map((d) => {
        const ok = allowed ? roleAllowed(d.role, allowed) : true;
        return (
          <Button
            key={d.role}
            size={size}
            variant={ok ? 'primary' : 'secondary'}
            icon={d.icon}
            loading={busy === d.role}
            disabled={busy !== null || currentRole === d.role}
            onClick={() => void onClick(d.role)}
            title={d.blurb}
          >
            {d.label}
          </Button>
        );
      })}
    </div>
  );
}

export interface RestrictedPanelProps {
  roles: readonly Role[] | 'gov';
  /** Module name, e.g. "Opportunity Lab". */
  title?: string;
  /** What the module does (shown under the heading). */
  description?: string;
  /** Smaller, single-card variant without the access-model grid. */
  compact?: boolean;
  className?: string;
}

/** Explains why the content is restricted and how to get access. */
export function RestrictedPanel({ roles, title, description, compact, className }: RestrictedPanelProps) {
  const { role, isAuthenticated, user } = useAuth();
  const location = useLocation();
  const next = `${location.pathname}${location.search}`;
  const needed = rolesText(roles);
  const heading = isAuthenticated
    ? `${title ?? 'This module'} needs a different role`
    : `${title ?? 'This module'} is for ${roles === 'gov' ? 'government users' : needed}`;
  const explanation = isAuthenticated
    ? `You are signed in as ${user.name ?? user.email ?? ROLE_LABELS[role]} (${ROLE_LABELS[role]}). Access requires ${needed}.`
    : `Sign in as ${needed} to continue. The public module stays open to everyone.`;

  return (
    <div className={clsx('rounded-xl border border-line bg-surface shadow-card', compact ? 'p-5' : 'p-6 sm:p-8', className)}>
      <div className="flex flex-wrap items-start gap-4">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-xl bg-navy text-white" aria-hidden>
          <Lock className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold tracking-wider text-brand-ink uppercase">Controlled access</div>
          <h2 className="mt-0.5 text-lg font-bold text-ink">{heading}</h2>
          {description ? <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p> : null}
          <p className="mt-2 max-w-2xl text-sm text-muted">{explanation}</p>
        </div>
      </div>

      {!compact ? (
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {ACCESS_TIERS.map((t) => (
            <div key={t.title} className="rounded-lg border border-line bg-surface-2 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                <t.icon className="size-4 text-brand-ink" aria-hidden />
                {t.title}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{t.text}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 border-t border-line pt-5">
        <div className="mb-2 text-sm font-medium text-ink">Try it with a demo account</div>
        <DemoLoginButtons allowed={roles} />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
          <Button to={routes.login(next)} variant="link" size="sm" icon={KeyRound}>
            Sign in with email
          </Button>
          <span>Demo accounts are seeded for evaluation only; every action is recorded in the audit log.</span>
        </div>
      </div>
    </div>
  );
}

/** Compact sign-in call-to-action (for 401 / 403 errors inside cards). */
export function SignInPrompt({ roles = 'gov', message, className }: { roles?: readonly Role[] | 'gov'; message?: string; className?: string }) {
  const { isAuthenticated, role } = useAuth();
  const location = useLocation();
  return (
    <div className={clsx('flex flex-col items-center gap-3 px-4 py-8 text-center', className)}>
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-brand-soft text-brand-ink" aria-hidden>
        <Lock className="size-5" />
      </span>
      <div className="text-[15px] font-semibold text-ink">{isAuthenticated ? 'Your role cannot open this data' : 'Sign in to view this data'}</div>
      <p className="max-w-md text-sm text-muted">
        {message ??
          (isAuthenticated
            ? `Signed in as ${ROLE_LABELS[role]}. This data is available to ${rolesText(roles)}.`
            : `This data is available to ${rolesText(roles)}. Use a demo account or sign in.`)}
      </p>
      <DemoLoginButtons allowed={roles} size="sm" className="justify-center" />
      <Button to={routes.login(`${location.pathname}${location.search}`)} variant="link" size="sm">
        Sign in with email
      </Button>
    </div>
  );
}

export interface RequireRoleProps {
  /** Allowed roles, or 'gov' for analyst | ministry | admin. Admin always passes. */
  roles: readonly Role[] | 'gov';
  children: ReactNode;
  /** Module name for the restricted panel heading. */
  title?: string;
  description?: string;
  /** Use the compact panel (inside a card / tab) instead of the full-page one. */
  compact?: boolean;
  /** Custom fallback instead of the restricted panel. */
  fallback?: ReactNode;
}

/** Renders `children` only for permitted roles; otherwise the restricted panel. */
export function RequireRole({ roles, children, title, description, compact, fallback }: RequireRoleProps) {
  const { role, loading } = useAuth();
  if (loading) return <LoadingBlock label="Checking your session…" />;
  if (roleAllowed(role, roles)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return <RestrictedPanel roles={roles} title={title} description={description} compact={compact} />;
}
