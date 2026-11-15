/**
 * Tooltip - small hover / focus bubble rendered in a portal (never clipped by table or card overflow).
 * Content is supplementary: never put information only here (SPEC / dataviz rule - tooltips enhance,
 * they never gate).
 *
 *   <Tooltip content="Balassa RCA = India's share in product exports / share in world exports">
 *     <span>RCA</span>
 *   </Tooltip>
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  /** Delay before showing, ms. */
  delay?: number;
  /** Max width of the bubble in px. */
  maxWidth?: number;
  className?: string;
  /** Render the trigger as block instead of inline-flex. */
  block?: boolean;
}

interface Pos {
  left: number;
  top: number;
  side: 'top' | 'bottom';
}

export function Tooltip({ content, children, side = 'top', delay = 120, maxWidth = 280, className, block }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [shift, setShift] = useState(0);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const roomAbove = r.top > 64;
      const s: 'top' | 'bottom' = side === 'top' ? (roomAbove ? 'top' : 'bottom') : window.innerHeight - r.bottom > 64 ? 'bottom' : 'top';
      setShift(0);
      setPos({ left: r.left + r.width / 2, top: s === 'top' ? r.top - 8 : r.bottom + 8, side: s });
    }, delay);
  }, [delay, side]);

  // Keep the bubble inside the viewport horizontally.
  useLayoutEffect(() => {
    const b = bubbleRef.current;
    if (!pos || !b) return;
    const rect = b.getBoundingClientRect();
    if (rect.left < 8) setShift(8 - rect.left);
    else if (rect.right > window.innerWidth - 8) setShift(window.innerWidth - 8 - rect.right);
  }, [pos]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPos(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!pos) return;
    const onScroll = () => setPos(null);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [pos]);

  if (content === null || content === undefined || content === '') return <>{children}</>;

  return (
    <>
      <span
        ref={triggerRef}
        className={clsx(block ? 'block' : 'inline-flex max-w-full', className)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={pos ? id : undefined}
      >
        {children}
      </span>
      {pos
        ? createPortal(
            <div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              className="pointer-events-none fixed z-[100] w-max animate-fade-in rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs leading-snug text-ink shadow-pop"
              style={{
                left: pos.left + shift,
                top: pos.top,
                maxWidth,
                transform: `translate(-50%, ${pos.side === 'top' ? '-100%' : '0'})`,
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
