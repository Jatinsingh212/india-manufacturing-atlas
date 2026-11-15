/**
 * Authentication state (SPEC section 5).
 *
 * - The JWT lives in localStorage ('atlas.token', managed by api/client `setAuthToken`).
 * - On load, a stored token is validated with GET /api/auth/me; an anonymous answer (role 'public')
 *   or a 401 clears it. Any later 401 on an authenticated request (expired token) signs out too.
 * - Signing in / out invalidates the React Query cache so role-dependent data refetches.
 *
 * `useAuth()` -> { user, role, token, isGov, isAdmin, loading, login, demoLogin, logout, register, hasRole }.
 * Role gates for pages: see `RequireRole` in ./RequireRole.tsx.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getAuthToken, queryClient, setAuthToken, UNAUTHORIZED_EVENT } from '@/api/client';
import { GOV_ROLES, type AuthResponse, type DemoRole, type RegisterRequest, type Role, type User } from '@/api/types';

/** The anonymous user returned when nobody is signed in. */
export const ANONYMOUS_USER: User = {
  id: null,
  email: null,
  name: null,
  role: 'public',
  ministry_id: null,
  organisation: null,
};

/** Display labels for roles. */
export const ROLE_LABELS: Record<Role, string> = {
  public: 'Public',
  industry: 'Industry',
  analyst: 'Analyst',
  ministry: 'Ministry officer',
  admin: 'Admin',
};

export interface AuthContextValue {
  /** Signed-in user, or {@link ANONYMOUS_USER}. */
  user: User;
  role: Role;
  token: string | null;
  /** analyst | ministry | admin */
  isGov: boolean;
  isAdmin: boolean;
  isAuthenticated: boolean;
  /** true while the stored token is being validated on first load. */
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  demoLogin: (role: DemoRole) => Promise<User>;
  register: (body: RegisterRequest) => Promise<User>;
  logout: () => void;
  /** Whether the current role is one of `roles` ('gov' = GOV_ROLES). */
  hasRole: (roles: readonly Role[] | 'gov') => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Whether `role` satisfies `roles` ('gov' = any of GOV_ROLES; admin satisfies everything). */
export function roleAllowed(role: Role, roles: readonly Role[] | 'gov'): boolean {
  if (role === 'admin') return true;
  const list: readonly Role[] = roles === 'gov' ? GOV_ROLES : roles;
  return list.includes(role);
}

/** Provides auth state. Mount once inside QueryClientProvider. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(getAuthToken);
  const [user, setUser] = useState<User>(ANONYMOUS_USER);
  const [loading, setLoading] = useState<boolean>(() => Boolean(getAuthToken()));

  const clearSession = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(ANONYMOUS_USER);
  }, []);

  // Validate a stored token once on load.
  useEffect(() => {
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    api
      .me()
      .then((me) => {
        if (cancelled) return;
        if (!me || me.role === 'public' || me.id === null) clearSession();
        else setUser(me);
      })
      .catch(() => {
        if (!cancelled) clearSession();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  // Expired / revoked token: any authenticated 401 signs out.
  useEffect(() => {
    const onUnauthorized = () => {
      if (!getAuthToken()) return;
      clearSession();
      // clear() drops the cache without refetching mounted government queries (they would 401 without a token).
      queryClient.clear();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [clearSession]);

  const accept = useCallback((res: AuthResponse): User => {
    setAuthToken(res.access_token);
    setToken(res.access_token);
    setUser(res.user);
    // Role changed: reset cached data that may have been filtered for the previous role
    // (active queries refetch with the new token).
    void queryClient.resetQueries();
    return res.user;
  }, []);

  const login = useCallback(async (email: string, password: string) => accept(await api.login({ email, password })), [accept]);
  const demoLogin = useCallback(async (role: DemoRole) => accept(await api.demoLogin(role)), [accept]);
  const register = useCallback(async (body: RegisterRequest) => accept(await api.register(body)), [accept]);

  const logout = useCallback(() => {
    clearSession();
    // clear() drops the cache without refetching mounted government queries (they would 401 without a token).
    queryClient.clear();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(() => {
    const role = user.role ?? 'public';
    return {
      user,
      role,
      token,
      isGov: (GOV_ROLES as readonly Role[]).includes(role),
      isAdmin: role === 'admin',
      isAuthenticated: role !== 'public' && Boolean(token),
      loading,
      login,
      demoLogin,
      register,
      logout,
      hasRole: (roles) => roleAllowed(role, roles),
    };
  }, [user, token, loading, login, demoLogin, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Auth state and actions. Must be used under <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// Role gates live in ./RequireRole.tsx; re-exported here so `import { RequireRole } from '@/auth/AuthContext'`
// works too (the preferred import is `@/auth`).
export { DemoLoginButtons, RequireRole, RestrictedPanel, SignInPrompt } from './RequireRole';
