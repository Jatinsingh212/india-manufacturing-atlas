/**
 * MarkdownCore - react-markdown + GFM renderer (lazy-loaded by components/Markdown.tsx).
 * Internal links ("/product/40111010") use the router; external links open in a new tab.
 * Raw HTML in the markdown is NOT rendered (react-markdown default), so content stays safe.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import clsx from 'clsx';
import type { MarkdownProps } from '../Markdown';

const components: Components = {
  a({ href, children }) {
    if (href && href.startsWith('/')) return <Link to={href}>{children}</Link>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="atlas-scroll-x">
        <table>{children}</table>
      </div>
    );
  },
};

export default function MarkdownCore({ children, className, size = 'md' }: MarkdownProps) {
  return (
    <div className={clsx('atlas-prose', size === 'sm' ? 'text-[13px]' : 'text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children ?? ''}
      </ReactMarkdown>
    </div>
  );
}
