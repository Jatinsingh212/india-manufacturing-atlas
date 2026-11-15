/**
 * PageStub - placeholder body used by the initial page stubs created by the frontend foundation.
 * Page builders replace their stub file entirely; nothing else depends on this component.
 */
import { Construction } from 'lucide-react';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { navItem } from './nav';

export interface PageStubProps {
  /** Nav path to borrow title / icon / description from. */
  path?: string;
  title?: string;
  description?: string;
  /** Route params or other context to echo (helps when wiring links). */
  context?: Record<string, string | undefined>;
}

export function PageStub({ path, title, description, context }: PageStubProps) {
  const item = path ? navItem(path) : undefined;
  const heading = title ?? item?.label ?? 'Module';
  const ctx = Object.entries(context ?? {}).filter(([, v]) => v);
  return (
    <>
      <PageHeader title={heading} subtitle={description ?? item?.description} icon={item?.icon} />
      <Card>
        <EmptyState
          icon={Construction}
          title={`${heading} is being assembled`}
          message={
            ctx.length ? (
              <span>
                {ctx.map(([k, v]) => (
                  <span key={k} className="mr-3 inline-block font-mono text-xs">
                    {k}={v}
                  </span>
                ))}
              </span>
            ) : (
              'This module will appear here shortly.'
            )
          }
        />
      </Card>
    </>
  );
}
