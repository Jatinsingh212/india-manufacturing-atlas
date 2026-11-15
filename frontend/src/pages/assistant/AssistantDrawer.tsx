/**
 * AssistantDrawer - "Ask Atlas" chat over POST /api/assistant/chat (SPEC section 6.14).
 *
 * CONTRACT (from the frontend foundation; unchanged): default export, rendered by
 * components/layout/Layout.tsx as
 *   <AssistantDrawer open={isOpen} onClose={close} initialQuestion={question} requestId={requestId} />
 * - `open` / `onClose`: visibility.
 * - `initialQuestion`: question sent automatically when the drawer is opened through
 *   useAssistant().open('...') from any page; `requestId` changes on every open() call, so asking the
 *   same question twice sends it twice.
 *
 * Behaviour:
 * - Replies render as markdown (react-markdown + remark-gfm via <Markdown>); citations render as router
 *   links to their routes. Following any internal link closes the drawer so the page is visible; the
 *   conversation stays (Layout keeps the drawer mounted after first use).
 * - Mode badge from GET /api/assistant/status: Claude (model name) or offline (deterministic intents).
 * - The conversation lives in component state; the last 12 turns are sent as history.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { Bot, Check, Copy, Cpu, Factory, Hash, Landmark, MessageSquareText, Package, RotateCcw, SendHorizontal, Sparkles, TriangleAlert, Workflow, type LucideIcon } from 'lucide-react';
import { api, errorMessage, isApiError } from '@/api/client';
import { useAssistantStatus } from '@/api/hooks';
import type { AssistantMode, ChatMessage, ChatResponse, Citation } from '@/api/types';
import { Drawer } from '@/components/Overlay';
import { Badge, Button, IconButton, Markdown, Spinner, Tooltip } from '@/components';

export interface AssistantDrawerProps {
  open: boolean;
  onClose: () => void;
  initialQuestion?: string | null;
  requestId?: number;
}

interface Entry {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  tools?: string[];
  mode?: ChatResponse['mode'];
  /** Failed request: content holds the error message. */
  error?: boolean;
}

const STARTERS = [
  'Which ministry handles tyre cord fabric?',
  'Top import dependencies of the Ministry of Textiles',
  "What is India's RCA in cotton T-shirts?",
  'Export opportunities in electronics',
];

const HISTORY_TURNS = 12;
const MAX_CHARS = 2000;

const CITATION_ICON: Record<string, LucideIcon> = { product: Package, ministry: Landmark, sector: Factory, chain: Workflow, hs6: Hash };

let nextId = 1;

/** Display text for a failed chat request. */
function chatErrorText(e: unknown): string {
  if (isApiError(e) && (e.status === 404 || e.status === 405)) return 'The assistant service is not available on this server yet. The rest of the Atlas works as usual.';
  if (isApiError(e) && e.isUnavailable) return 'The Atlas API is not responding. Check the connection and try again.';
  return errorMessage(e);
}

export default function AssistantDrawer({ open, onClose, initialQuestion, requestId }: AssistantDrawerProps) {
  const status = useAssistantStatus();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const handledRequest = useRef<number | undefined>(undefined);

  const chat = useMutation({ mutationFn: (history: ChatMessage[]) => api.assistantChat(history) });

  const run = (history: Entry[]) => {
    const payload: ChatMessage[] = history
      .filter((e) => !e.error)
      .slice(-HISTORY_TURNS)
      .map((e) => ({ role: e.role, content: e.content }));
    chat.mutate(payload, {
      onSuccess: (res) =>
        setEntries((xs) => [
          ...xs,
          { id: nextId++, role: 'assistant', content: res.reply || 'No answer was returned.', citations: res.citations ?? [], tools: res.tools_used ?? [], mode: res.mode },
        ]),
      onError: (e) => setEntries((xs) => [...xs, { id: nextId++, role: 'assistant', content: chatErrorText(e), error: true }]),
    });
  };

  const send = (text: string) => {
    const q = text.trim().slice(0, MAX_CHARS);
    if (!q) return;
    if (chat.isPending) {
      setDraft(q);
      return;
    }
    const history = [...entries.filter((e) => !e.error), { id: nextId++, role: 'user' as const, content: q }];
    setEntries(history);
    setDraft('');
    run(history);
  };
  // The open-with-question effect below must call the latest `send` (it closes over `entries`).
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });

  const retry = () => {
    const history = entries.filter((e) => !e.error);
    setEntries(history);
    if (history.length && history[history.length - 1].role === 'user') run(history);
  };

  const reset = () => {
    chat.reset();
    setEntries([]);
    setDraft('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  // A question passed through useAssistant().open(question): send it once per request.
  useEffect(() => {
    if (!open || requestId === undefined || handledRequest.current === requestId) return;
    handledRequest.current = requestId;
    if (initialQuestion?.trim()) sendRef.current(initialQuestion);
  }, [open, requestId, initialQuestion]);

  // Keep the newest message in view.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end', behavior: entries.length > 1 ? 'smooth' : 'auto' });
  }, [entries.length, chat.isPending, open]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };

  // Following an internal link (citation or markdown link) closes the drawer to reveal the page.
  const onLinkClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (href && href.startsWith('/')) onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={460}
      flush
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-kpi" aria-hidden />
          Ask Atlas
        </span>
      }
      subtitle={<ModeBadge mode={status.data?.mode} model={status.data?.model ?? null} provider={status.data?.provider} loading={status.isPending} unavailable={status.isError} />}
      actions={entries.length ? <IconButton icon={RotateCcw} label="Start a new conversation" size="sm" onClick={reset} /> : null}
      footer={
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <div className="flex items-end gap-2">
            <label htmlFor="assistant-input" className="sr-only">
              Ask a question
            </label>
            <textarea
              id="assistant-input"
              ref={inputRef}
              data-autofocus
              rows={Math.min(5, Math.max(1, draft.split('\n').length))}
              value={draft}
              maxLength={MAX_CHARS}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about an HSN code, ministry, trade or value chain…"
              className="max-h-36 min-h-10 flex-1 resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none max-sm:text-base"
            />
            <IconButton type="submit" icon={SendHorizontal} label="Send" variant="primary" size="md" disabled={!draft.trim() || chat.isPending} />
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted">
            Answers come from the Atlas data. Scores are model estimates. Ministry ownership comes from the DPIIT Guidebook (16.12.2025); residual lines have no accepted owner.
          </p>
        </form>
      }
    >
      <div className="px-5 py-4" onClickCapture={onLinkClick}>
        {entries.length === 0 && !chat.isPending ? <Welcome onAsk={send} /> : null}
        <ol className="space-y-4" aria-live="polite" aria-label="Conversation">
          {entries.map((e) => (e.role === 'user' ? <UserBubble key={e.id} text={e.content} /> : <AssistantBubble key={e.id} entry={e} onRetry={retry} retrying={chat.isPending} />))}
          {chat.isPending ? (
            <li className="flex items-center gap-2.5 text-[13px] text-muted" role="status">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-navy text-white" aria-hidden>
                <Bot className="size-4" />
              </span>
              <Spinner />
              Looking this up in the Atlas…
            </li>
          ) : null}
        </ol>
        {entries.length > 0 && !chat.isPending ? <FollowUps onAsk={send} /> : null}
        <div ref={endRef} />
      </div>
    </Drawer>
  );
}

/** Display name of an assistant mode: 'Claude', the free provider's name, or 'Offline mode'. */
const PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', groq: 'Groq', xai: 'Grok', gemini: 'Gemini', openrouter: 'OpenRouter' };
function modeLabel(mode: string | undefined, provider?: string | null): string {
  if (!mode || mode === 'offline') return 'Offline mode';
  return PROVIDER_LABELS[mode] ?? provider ?? 'AI model';
}

function ModeBadge({ mode, model, provider, loading, unavailable }: { mode?: AssistantMode; model: string | null; provider?: string | null; loading: boolean; unavailable: boolean }) {
  if (loading) return <span className="text-[12.5px] text-muted">Checking assistant mode…</span>;
  if (unavailable || !mode) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone="outline">Mode unknown</Badge>
        <span className="text-[12.5px] text-muted">The assistant status could not be read.</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {mode !== 'offline' ? (
        <Tooltip content={`Answers are written by ${modeLabel(mode, provider)} using the Atlas's own data tools, with citations. If the model is unavailable the assistant answers offline.`}>
          <Badge tone="brand" icon={Sparkles}>
            {modeLabel(mode, provider)}{model ? ` · ${model}` : ''}
          </Badge>
        </Tooltip>
      ) : (
        <Tooltip content="Deterministic answers from the Atlas data (no external AI service). The server enables an AI model when an API key (Groq, Grok, Gemini, OpenRouter or Claude) is configured.">
          <Badge tone="neutral" icon={Cpu}>
            Offline mode
          </Badge>
        </Tooltip>
      )}
      <span className="text-[12.5px] text-muted">HSN codes, ministries, trade, value chains</span>
    </span>
  );
}

function Welcome({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="mb-5">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-4">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-navy text-white" aria-hidden>
          <MessageSquareText className="size-4" />
        </span>
        <div className="text-[13px] leading-relaxed text-ink-2">
          <div className="font-semibold text-ink">Ask the Atlas in plain language</div>
          Find the ministry for a product, check India's trade and RCA for an HSN code, or explore import dependencies and export opportunities. Each answer
          links to the pages it is based on.
        </div>
      </div>
      <div className="mt-4 text-[11px] font-semibold tracking-wider text-muted uppercase">Try asking</div>
      <ul className="mt-2 space-y-2">
        {STARTERS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onAsk(q)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-left text-[13px] font-medium text-ink transition-colors hover:border-brand/50 hover:bg-brand-soft"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FollowUps({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="mt-5 flex flex-wrap gap-1.5" aria-label="Suggested questions">
      {STARTERS.map((q) => (
        <button key={q} type="button" onClick={() => onAsk(q)} className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-2 hover:border-brand/50 hover:text-brand-ink">
          {q}
        </button>
      ))}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <li className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-line text-on-brand">{text}</div>
    </li>
  );
}

function AssistantBubble({ entry, onRetry, retrying }: { entry: Entry; onRetry: () => void; retrying: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  if (entry.error) {
    return (
      <li className="flex gap-2.5">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad" aria-hidden>
          <TriangleAlert className="size-4" />
        </span>
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-bad/30 bg-bad-soft px-3.5 py-2.5" role="alert">
          <div className="text-[13px] font-semibold text-bad-ink">The assistant could not answer</div>
          <div className="mt-0.5 text-[13px] break-words text-ink-2">{entry.content}</div>
          <Button size="xs" icon={RotateCcw} className="mt-2" onClick={onRetry} disabled={retrying}>
            Try again
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex gap-2.5">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-navy text-white" aria-hidden>
        <Bot className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {/* Offline answers are often wide tables: give them a readable minimum width and let the
            table scroll sideways inside the bubble instead of wrapping every word. */}
        <div className="rounded-2xl rounded-tl-md border border-line bg-surface px-3.5 py-2.5 [&_table]:min-w-[36rem] [&_table]:text-[12px] [&_td]:align-top [&_td:nth-child(2)]:min-w-[11rem] [&_th]:whitespace-nowrap">
          <Markdown size="sm">{entry.content}</Markdown>
        </div>
        {entry.citations?.length ? (
          <div className="mt-2">
            <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Sources in the Atlas</div>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {entry.citations.map((c, i) => {
                const Icon = CITATION_ICON[c.type] ?? Hash;
                return (
                  <li key={`${c.type}-${c.id}-${i}`}>
                    <Link
                      to={c.route}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs font-medium text-brand-ink hover:border-brand/50 hover:bg-brand-soft"
                      title={c.label}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="max-w-64 truncate">{c.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1">
            {entry.mode !== 'offline' ? <Sparkles className="size-3" aria-hidden /> : <Cpu className="size-3" aria-hidden />}
            {modeLabel(entry.mode)}
          </span>
          {entry.tools?.length ? <span className="truncate" title={entry.tools.join(', ')}>Looked up: {entry.tools.join(', ').replace(/_/g, ' ')}</span> : null}
          <button type="button" onClick={() => void copy()} className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-3 hover:text-ink" aria-label="Copy the answer">
            {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </li>
  );
}
