/**
 * 404 page (inside the layout) with a search box and the main entry points.
 */
import { useLocation } from 'react-router';
import { Compass, Home, ListTree, Workflow } from 'lucide-react';
import { Button } from '@/components/Button';
import { HsnSearchBox } from '@/components/HsnSearchBox';
import { useDocumentTitle } from '@/lib/hooks';
import { routes } from '@/lib/routes';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  useDocumentTitle('Page not found');
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
      <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-brand-soft text-brand-ink" aria-hidden>
        <Compass className="size-7" />
      </span>
      <div className="mt-5 text-sm font-semibold tracking-wider text-kpi uppercase">404</div>
      <h1 className="mt-1 text-2xl font-bold text-ink">This page is not on the atlas</h1>
      <p className="mt-2 text-sm text-ink-2">
        Nothing lives at <span className="font-mono text-ink">{pathname}</span>. Search for an HSN code or product, or jump to a module.
      </p>
      <HsnSearchBox className="mt-6 w-full" size="lg" autoFocus />
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button to={routes.overview()} icon={Home} variant="primary">
          Overview
        </Button>
        <Button to={routes.explore()} icon={ListTree}>
          HSN Explorer
        </Button>
        <Button to={routes.valueChains()} icon={Workflow}>
          Value chains
        </Button>
      </div>
    </div>
  );
}
