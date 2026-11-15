/**
 * Markdown - renders markdown (info cards `body_md`, assistant replies, methodology text) with GitHub
 * flavoured tables / lists, Atlas prose styles and router-aware links. Code-split: the markdown
 * parser loads on first use.
 *
 *   <Markdown>{card.body_md}</Markdown>
 */
import { lazy, Suspense } from 'react';
import { Skeleton } from './Loading';

export interface MarkdownProps {
  children: string | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}

const MarkdownCore = lazy(() => import('./impl/MarkdownCore'));

export function Markdown(props: MarkdownProps) {
  return (
    <Suspense
      fallback={
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-9/12" />
        </div>
      }
    >
      <MarkdownCore {...props} />
    </Suspense>
  );
}
