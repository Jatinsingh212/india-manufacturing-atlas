/**
 * App root: providers + router.
 *
 *   ThemeProvider        light / dark (localStorage 'atlas.theme', defaults to prefers-color-scheme)
 *   QueryClientProvider  shared React Query cache (api/client `queryClient`)
 *   AuthProvider         JWT session, useAuth()
 *   ToastProvider        useToast()
 *   RouterProvider       routes in app/routes.tsx (lazy pages inside Layout, scroll restoration)
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { queryClient } from '@/api/client';
import { router } from '@/app/routes';
import { AuthProvider } from '@/auth/AuthContext';
import { ToastProvider } from '@/components/Toast';
import { ThemeProvider } from '@/theme/ThemeContext';

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
