/**
 * Auth barrel: `import { useAuth, RequireRole } from '@/auth';`
 */
export { ANONYMOUS_USER, AuthProvider, ROLE_LABELS, roleAllowed, useAuth, type AuthContextValue } from './AuthContext';
export { DEMO_ROLES, DemoLoginButtons, RequireRole, RestrictedPanel, SignInPrompt, type RequireRoleProps, type RestrictedPanelProps } from './RequireRole';
