/**
 * Route error boundary (react-router `errorElement`): render errors and failed lazy chunks show
 * inside the layout instead of a blank screen. A failed chunk (stale deploy) offers a reload.
 */
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { CircleAlert, Home, RefreshCw } from 'lucide-react';
import { Button } from '@/components/Button';
import { routes } from '@/lib/routes';

export default function RouteError() {
  const error = useRouteError();
  const isChunk = error instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';
  if (import.meta.env.DEV) console.error(error);
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-16 text-center" role="alert">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-bad-soft text-bad" aria-hidden>
        <CircleAlert className="size-6" />
      </span>
      <h1 className="mt-4 text-xl font-bold text-ink">{isChunk ? 'A new version of the Atlas is available' : 'This page ran into a problem'}</h1>
      <p className="mt-2 text-sm break-words text-muted">{isChunk ? 'Reload to fetch the latest files.' : message}</p>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button to={routes.overview()} icon={Home}>
          Overview
        </Button>
      </div>
    </div>
  );
}
