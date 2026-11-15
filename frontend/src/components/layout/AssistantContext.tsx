/**
 * Assistant drawer state, so any page can open "Ask Atlas" with a prepared question.
 *
 *   const assistant = useAssistant();
 *   <Button onClick={() => assistant.open(`Which ministry owns HSN ${hsn8}?`)}>Ask Atlas</Button>
 *
 * The drawer itself is pages/assistant/AssistantDrawer.tsx (owner D4), rendered by Layout with
 * `{ open, onClose, initialQuestion }`.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface AssistantContextValue {
  isOpen: boolean;
  /** Question to pre-fill / auto-send when the drawer opens (cleared on close). */
  question: string | null;
  /** Monotonic counter: changes every time open() is called (lets the drawer react to repeat questions). */
  requestId: number;
  open: (question?: string) => void;
  close: () => void;
  toggle: () => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);

  const open = useCallback((q?: string) => {
    setQuestion(q?.trim() ? q.trim() : null);
    setRequestId((n) => n + 1);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setQuestion(null);
  }, []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  const value = useMemo(() => ({ isOpen, question, requestId, open, close, toggle }), [isOpen, question, requestId, open, close, toggle]);
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

/** Open / close the "Ask Atlas" assistant drawer. Must be used under <AssistantProvider>. */
export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error('useAssistant must be used inside <AssistantProvider>');
  return ctx;
}
