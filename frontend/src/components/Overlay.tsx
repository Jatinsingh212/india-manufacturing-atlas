/**
 * Overlays rendered in a portal, with Escape-to-close, scroll lock and focus handling.
 *
 * - <Drawer open onClose title side="right" width={440} footer>...</Drawer>   side panel (assistant, details)
 * - <Modal open onClose title size="md" footer>...</Modal>                    centred dialog (forms, confirms)
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { isTopOverlay, popOverlay, pushOverlay, trapTab } from '@/lib/focus';

let openCount = 0;

/** Shared open/close behaviour: Escape, body scroll lock, focus restore. */
function useOverlay(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
  returnFocusRef?: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) pushOverlay(panel);
    openCount += 1;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      // Only the most recently opened overlay owns Escape / Tab.
      if (!panel || !isTopOverlay(panel)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      trapTab(e, panel);
    };
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => {
      if (!panel) return;
      const focusable = panel.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button:not([data-close])');
      (focusable ?? panel).focus();
    }, 30);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      if (panel) popOverlay(panel);
      openCount -= 1;
      if (openCount <= 0) {
        openCount = 0;
        document.body.style.overflow = '';
      }
      const returnTo = returnFocusRef?.current ?? previous;
      returnTo?.focus?.();
    };
  }, [open, panelRef, returnFocusRef]);
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header actions next to the close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  /** Right / left side panel, or a bottom sheet on phones. */
  side?: 'right' | 'left' | 'bottom';
  /** Width in px on screens wider than the panel (default 440). Ignored for the bottom sheet. */
  width?: number;
  /** Remove body padding (e.g. for a chat layout managing its own scroll). */
  flush?: boolean;
  /** Element to focus when the drawer closes (e.g. the button that opened it). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  className?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  side = 'right',
  width = 440,
  flush,
  returnFocusRef,
  children,
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(open, onClose, panelRef, returnFocusRef);
  if (!open) return null;
  const bottom = side === 'bottom';
  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 animate-fade-in bg-overlay" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={clsx(
          'absolute flex max-w-full flex-col border-line bg-surface shadow-pop outline-none',
          bottom
            ? 'inset-x-0 bottom-0 max-h-[90dvh] animate-slide-in-up rounded-t-2xl border-t'
            : clsx('inset-y-0', side === 'right' ? 'right-0 animate-slide-in-right border-l' : 'left-0 animate-slide-in-left border-r'),
          className,
        )}
        style={bottom ? undefined : { width }}
      >
        {bottom ? <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong sm:hidden" aria-hidden /> : null}
        {title || actions ? (
          <div className="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5 sm:py-4">
            <div className="min-w-0 flex-1">
              {title ? (
                <h2 id={titleId} className="text-base font-semibold text-ink">
                  {title}
                </h2>
              ) : null}
              {subtitle ? <div className="mt-0.5 text-[13px] text-muted">{subtitle}</div> : null}
            </div>
            {actions}
            <button type="button" data-close onClick={onClose} className="-m-1 inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-ink" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ) : null}
        <div
          className={clsx(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain',
            !flush && 'px-4 py-4 sm:px-5',
            bottom && !footer && !flush && 'pb-[max(1rem,env(safe-area-inset-bottom,0px))]',
          )}
        >
          {children}
        </div>
        {footer ? <div className="border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:px-5">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Element to focus when the dialog closes (e.g. the button that opened it). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  className?: string;
}

const MODAL_SIZE = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

export function Modal({ open, onClose, title, description, footer, size = 'md', returnFocusRef, children, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(open, onClose, panelRef, returnFocusRef);
  if (!open) return null;
  return createPortal(
    // The panel centres itself with auto margins inside a scrollable, top-aligned container. Centring with
    // `items-center` instead would push the top of a panel taller than the viewport above the screen,
    // where no scroll can reach the title or the Close button; auto margins collapse to zero when the
    // panel overflows, so it starts at the top and the container scrolls through all of it.
    <div className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto p-3 sm:p-6">
      <div className="fixed inset-0 animate-fade-in bg-overlay" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={clsx('relative my-auto w-full animate-pop-in rounded-xl border border-line bg-surface shadow-pop outline-none', MODAL_SIZE[size], className)}
      >
        <div className="flex items-start gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
          <div className="min-w-0 flex-1">
            {title ? (
              <h2 id={titleId} className="text-base font-semibold text-ink">
                {title}
              </h2>
            ) : null}
            {description ? <div className="mt-1 text-[13px] text-muted">{description}</div> : null}
          </div>
          <button type="button" data-close onClick={onClose} className="-m-1 inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-ink" aria-label="Close">
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:px-5">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
