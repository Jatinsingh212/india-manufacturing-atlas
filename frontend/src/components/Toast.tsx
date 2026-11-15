/**
 * Simple global toasts.
 *
 *   const toast = useToast();
 *   toast.success('Claim submitted');  toast.error(errorMessage(err));  toast.info('Refresh started');
 *   toast.push({ tone: 'success', title: 'Saved', message: 'Mapping updated', duration: 6000 });
 *
 * <ToastProvider> is mounted once in App.tsx.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, Info, X, type LucideIcon } from 'lucide-react';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone?: ToastTone;
  title: ReactNode;
  message?: ReactNode;
  /** ms; default 4500 (errors 7000). 0 = sticky. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

export interface ToastApi {
  push: (t: ToastInput) => number;
  success: (title: ReactNode, message?: ReactNode) => number;
  error: (title: ReactNode, message?: ReactNode) => number;
  info: (title: ReactNode, message?: ReactNode) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, { icon: LucideIcon; cls: string }> = {
  success: { icon: CircleCheck, cls: 'text-ok' },
  error: { icon: CircleAlert, cls: 'text-bad' },
  info: { icon: Info, cls: 'text-info' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-4), { ...t, id }]);
      const duration = t.duration ?? (t.tone === 'error' ? 7000 : 4500);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (title, message) => push({ tone: 'success', title, message }),
      error: (title, message) => push({ tone: 'error', title, message }),
      info: (title, message) => push({ tone: 'info', title, message }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          className="pointer-events-none fixed inset-x-4 bottom-[calc(var(--atlas-bottomnav-h)+1rem+env(safe-area-inset-bottom,0px))] z-[120] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-[min(380px,calc(100vw-2rem))] lg:bottom-4"
          aria-live="polite"
          role="region"
          aria-label="Notifications"
        >
          {items.map((t) => {
            const tone = TONE[t.tone ?? 'info'];
            const Icon = tone.icon;
            return (
              <div key={t.id} className="pointer-events-auto flex animate-pop-in items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-pop" role={t.tone === 'error' ? 'alert' : 'status'}>
                <Icon className={clsx('mt-0.5 size-5 shrink-0', tone.cls)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink">{t.title}</div>
                  {t.message ? <div className="mt-0.5 text-[13px] text-ink-2">{t.message}</div> : null}
                </div>
                <button type="button" onClick={() => dismiss(t.id)} className="-m-1 rounded-md p-1 text-muted hover:bg-surface-3 hover:text-ink" aria-label="Dismiss notification">
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** Toast API. Must be used under <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
