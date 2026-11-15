/**
 * LoginPage - route /login. Email / password sign-in, industry registration (`?mode=register`), and
 * one-click demo roles (Admin, Ministry officer - Textiles, Analyst, Industry; demo mode only), plus
 * the DPIIT ministry desk (demo-login with `ministry_id`, see ./api.ts).
 * After any successful sign-in it returns to `?next=` (same-origin paths only), else to the overview.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Building, ChartColumn, Globe, KeyRound, Landmark, LogIn, LogOut, ShieldCheck, UserCog, UserPlus, type LucideIcon } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DemoRole } from '@/api/types';
import { ROLE_LABELS, useAuth } from '@/auth';
import { BrandWordmark } from '@/components/layout/BrandMark';
import { Button, FormField, SegmentedControl, TextInput, useToast } from '@/components';
import { useDocumentTitle } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { DEFAULT_DEMO_MINISTRY, demoLoginForMinistry, MINISTRY_DEMO_DESKS } from './api';

type Mode = 'signin' | 'register';

const DEMO: Array<{ role: DemoRole; label: string; blurb: string; icon: LucideIcon }> = [
  { role: 'admin', label: 'Admin', blurb: 'Users, claim approvals, connectors, uploads, audit log', icon: UserCog },
  { role: 'ministry', label: 'Ministry officer – Textiles', blurb: 'Own-ministry codes, residual claims, routed queries, uploads', icon: Landmark },
  { role: 'analyst', label: 'Analyst', blurb: 'Opportunity Lab, risk, residual review, data quality', icon: ChartColumn },
  { role: 'industry', label: 'Industry', blurb: 'Watchlist and every report', icon: Building },
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Only same-origin app paths are accepted as a return target (no open redirects, no loop to /login). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/login')) return routes.overview();
  return raw;
}

export default function LoginPage() {
  useDocumentTitle('Sign in');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const mode: Mode = params.get('mode') === 'register' ? 'register' : 'signin';
  const { isAuthenticated, user, role, loading, logout } = useAuth();

  const setMode = (m: Mode) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (m === 'register') p.set('mode', 'register');
        else p.delete('mode');
        return p;
      },
      { replace: true },
    );

  const done = () => navigate(next, { replace: true });

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <IntroPanel />
      <div className="space-y-6">
        {isAuthenticated && !loading ? (
          <div className="rounded-xl border border-ok/30 bg-ok-soft px-5 py-4">
            <div className="text-sm font-semibold text-ok-ink">
              Signed in as {user.name ?? user.email} ({ROLE_LABELS[role]})
            </div>
            <p className="mt-1 text-[13px] text-ink-2">Continue where you were, or sign in as someone else below.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" iconRight={ArrowRight} onClick={done}>
                Continue
              </Button>
              <Button size="sm" icon={LogOut} onClick={logout}>
                Sign out
              </Button>
            </div>
          </div>
        ) : null}

        <section className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6" aria-labelledby="auth-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 id="auth-heading" className="text-xl font-bold text-ink">
              {mode === 'register' ? 'Create an industry account' : 'Sign in'}
            </h1>
            <SegmentedControl<Mode>
              value={mode}
              onChange={setMode}
              ariaLabel="Sign in or register"
              options={[
                { value: 'signin', label: 'Sign in' },
                { value: 'register', label: 'Register' },
              ]}
            />
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {mode === 'register'
              ? 'For companies and industry associations: keep a watchlist and download every report.'
              : 'Government users receive accounts from the DPIIT programme office; industry users can register.'}
          </p>
          <div className="mt-5">{mode === 'register' ? <RegisterForm onDone={done} /> : <SignInForm onDone={done} onRegister={() => setMode('register')} />}</div>
        </section>

        <DemoPanel onDone={done} next={next} />
      </div>
    </div>
  );
}

function IntroPanel() {
  const tiers: Array<{ icon: LucideIcon; title: string; text: string }> = [
    { icon: Globe, title: 'Public module', text: 'Explorer, product pages, ministries, value chains, network, schemes and the assistant. No sign-in needed.' },
    { icon: Building, title: 'Industry', text: 'Keep a watchlist and download every report.' },
    { icon: ShieldCheck, title: 'Government', text: 'Analysts, ministry officers and administrators add analytics, supply-chain risk, residual ownership and data operations.' },
  ];
  return (
    // Below lg the forms come first; the introduction follows them.
    <aside className="order-last flex flex-col rounded-xl bg-navy p-6 text-on-navy shadow-card sm:p-8 lg:order-first">
      <BrandWordmark />
      <h2 className="mt-6 text-2xl leading-tight font-bold text-white">One HSN intelligence platform for government and industry</h2>
      <p className="mt-2 text-sm leading-relaxed text-on-navy-muted">
        Every 8-digit HSN line mapped to its Ministry, with trade, tariffs, value chains and analytics, so decisions rest on evidence.
      </p>
      <ul className="mt-6 space-y-4">
        {tiers.map((t) => (
          <li key={t.title} className="flex gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10" aria-hidden>
              <t.icon className="size-4" />
            </span>
            <div>
              <div className="text-sm font-semibold text-white">{t.title}</div>
              <p className="text-[13px] leading-relaxed text-on-navy-muted">{t.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-auto pt-6 text-xs text-on-navy-muted">Every sign-in and change is recorded in the audit log.</p>
    </aside>
  );
}

function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-ink">
      {children}
    </div>
  );
}

function SignInForm({ onDone, onRegister }: { onDone: () => void; onRegister: () => void }) {
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!EMAIL_RE.test(email.trim()) || !password) {
      setError('Enter your email address and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const u = await login(email.trim(), password);
      toast.success(`Welcome, ${u.name ?? u.email}`, ROLE_LABELS[u.role]);
      onDone();
    } catch (e) {
      setError(isApiError(e) && e.isUnauthorized ? 'The email or password is not correct, or the account is inactive.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error ? <FormError>{error}</FormError> : null}
      <FormField label="Email" htmlFor="login-email" required>
        <TextInput id="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </FormField>
      <FormField label="Password" htmlFor="login-password" required>
        <TextInput id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </FormField>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onRegister} className="text-[13px] atlas-link">
          New industry user? Register
        </button>
        <Button type="submit" variant="primary" icon={LogIn} loading={busy}>
          Sign in
        </Button>
      </div>
    </form>
  );
}

interface RegErrors {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const { register } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<RegErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const e: RegErrors = {};
    if (!name.trim()) e.name = 'Enter your name.';
    if (!EMAIL_RE.test(email.trim())) e.email = 'Enter a valid email address.';
    if (password.length < 8) e.password = 'Use at least 8 characters.';
    if (confirm !== password) e.confirm = 'The passwords do not match.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const u = await register({ name: name.trim(), organisation: organisation.trim(), email: email.trim().toLowerCase(), password });
      toast.success('Account created', `Signed in as ${u.name ?? u.email} (Industry).`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      {error ? <FormError>{error}</FormError> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Full name" htmlFor="reg-name" required error={errors.name}>
          <TextInput id="reg-name" autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} invalid={Boolean(errors.name)} autoFocus />
        </FormField>
        <FormField label="Organisation" htmlFor="reg-org">
          <TextInput id="reg-org" autoComplete="organization" value={organisation} maxLength={200} onChange={(e) => setOrganisation(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Work email" htmlFor="reg-email" required error={errors.email}>
        <TextInput id="reg-email" type="email" autoComplete="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} invalid={Boolean(errors.email)} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Password" htmlFor="reg-password" required error={errors.password} hint="At least 8 characters.">
          <TextInput id="reg-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={Boolean(errors.password)} />
        </FormField>
        <FormField label="Confirm password" htmlFor="reg-confirm" required error={errors.confirm}>
          <TextInput id="reg-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={Boolean(errors.confirm)} />
        </FormField>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" icon={UserPlus} loading={busy}>
          Create account
        </Button>
      </div>
    </form>
  );
}

function DemoPanel({ onDone, next }: { onDone: () => void; next: string }) {
  const { demoLogin, role: current, user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<DemoRole | null>(null);
  const [busyDesk, setBusyDesk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anyBusy = busy !== null || busyDesk !== null;
  /** Whether the signed-in user is the demo account behind a button (ministry buttons differ by desk). */
  const isCurrent = (role: DemoRole, ministryId?: string) =>
    current === role && (role !== 'ministry' || (user.ministry_id ?? '') === (ministryId ?? DEFAULT_DEMO_MINISTRY));

  useEffect(() => setError(null), [current]);

  const goDesk = async (ministryId: string) => {
    setBusyDesk(ministryId);
    setError(null);
    try {
      await demoLoginForMinistry(ministryId);
      // AuthContext cannot adopt a session it did not create: reload into `next`, where the provider
      // validates the stored token with /api/auth/me.
      window.location.assign(next);
    } catch (e) {
      setError(isApiError(e) && e.isNotFound ? 'This demo account is not available on this server.' : errorMessage(e));
      setBusyDesk(null);
    }
  };

  const go = async (role: DemoRole) => {
    setBusy(role);
    setError(null);
    try {
      const u = await demoLogin(role);
      toast.success(`Signed in as ${u.name ?? ROLE_LABELS[role]}`, 'Demo account');
      onDone();
    } catch (e) {
      setError(isApiError(e) && e.isNotFound ? 'Demo accounts are switched off on this server.' : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6" aria-labelledby="demo-heading">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-brand-ink" aria-hidden />
        <h2 id="demo-heading" className="text-[15px] font-semibold text-ink">
          Try a demo role
        </h2>
      </div>
      <p className="mt-1 text-[13px] text-muted">One click signs you in to a seeded evaluation account. Demo actions are audit-logged like any other.</p>
      {error ? (
        <div className="mt-3">
          <FormError>{error}</FormError>
        </div>
      ) : null}
      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {DEMO.map((d) => (
          <button
            key={d.role}
            type="button"
            disabled={anyBusy}
            onClick={() => void go(d.role)}
            className="group flex items-start gap-3 rounded-lg border border-line bg-surface-2 p-3 text-left transition-colors hover:border-brand/50 hover:bg-brand-soft disabled:opacity-60"
          >
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-navy text-white" aria-hidden>
              <d.icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                {d.label}
                {busy === d.role ? <span className="text-xs font-normal text-muted">Signing in…</span> : null}
                {isCurrent(d.role) && !anyBusy ? <span className="text-xs font-normal text-ok-ink">current</span> : null}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-ink-2">{d.blurb}</span>
            </span>
            <ArrowRight className="mt-2.5 size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4">
        <span className="text-[13px] font-medium text-ink-2">Another ministry desk</span>
        {MINISTRY_DEMO_DESKS.map((d) => (
          <Button
            key={d.ministryId}
            size="sm"
            variant="secondary"
            icon={Landmark}
            loading={busyDesk === d.ministryId}
            disabled={anyBusy || isCurrent('ministry', d.ministryId)}
            onClick={() => void goDesk(d.ministryId)}
            title={d.blurb}
          >
            {d.label}
          </Button>
        ))}
        <span className="text-xs text-muted">Residual lines and queries without an owning ministry go to DPIIT.</span>
      </div>
    </section>
  );
}
