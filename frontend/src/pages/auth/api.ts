/**
 * Sign-in helpers for the Login page that the shared AuthContext does not cover.
 *
 * `POST /api/auth/demo-login {role, ministry_id?}` (SPEC 6.1; the backend documents the optional
 * `ministry_id`): without it the 'ministry' role signs in the first seeded ministry officer, the
 * Ministry of Textiles desk, which is what `useAuth().demoLogin('ministry')` does. The seed also has a
 * DPIIT desk officer, the natural counterpart for residual lines and centrally triaged queries.
 *
 * `useAuth().demoLogin(role)` takes no ministry, and the context exposes no way to accept an
 * AuthResponse from elsewhere, so {@link demoLoginForMinistry} stores the token itself; the caller then
 * reloads the app, and AuthProvider validates the stored token with GET /api/auth/me on start-up.
 */
import { apiPost, setAuthToken } from '@/api/client';
import type { AuthResponse } from '@/api/types';

/** Ministry desks offered as extra demo sign-ins (ids from data/curated/ops_seed.json). */
export const MINISTRY_DEMO_DESKS: ReadonlyArray<{ ministryId: string; label: string; blurb: string }> = [
  {
    ministryId: 'dpiit',
    label: 'Ministry officer – DPIIT',
    blurb: 'DPIIT-owned lines, residual claims and the queries routed to DPIIT',
  },
];

/** The ministry the plain 'ministry' demo role signs in to (first seeded ministry officer). */
export const DEFAULT_DEMO_MINISTRY = 'mot';

/**
 * Sign in as the seeded demo officer of `ministryId` and persist the session token.
 * Rejects with ApiError (404 when demo mode is off or no such demo user exists).
 */
export async function demoLoginForMinistry(ministryId: string): Promise<AuthResponse> {
  const res = await apiPost<AuthResponse>('/api/auth/demo-login', { role: 'ministry', ministry_id: ministryId });
  setAuthToken(res.access_token);
  return res;
}
