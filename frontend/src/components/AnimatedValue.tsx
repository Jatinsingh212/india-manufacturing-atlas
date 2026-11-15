/**
 * AnimatedValue - counts the number inside an already formatted string up from zero the first time it
 * scrolls into view ("$455 bn", "13,110", "-$236 bn", "3.1%"), keeping prefix, suffix, thousands
 * separators and decimals exactly as formatted. Non-numeric values render unchanged. Respects
 * prefers-reduced-motion (renders the final value immediately).
 */
import { useEffect, useRef, useState } from 'react';

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;

interface Parsed {
  before: string;
  after: string;
  target: number;
  decimals: number;
  grouped: boolean;
}

function parse(text: string): Parsed | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const raw = m[0];
  // Only quantities count up. Ordinals ("3rd"), numbers glued to letters, and identifiers such as
  // "HS 2933.19" (any words before the number) are shown as they are.
  if (/^[a-z]/i.test(text.slice(m.index + raw.length))) return null;
  if (!/^[\s+\-−$₹€£]*$/.test(text.slice(0, m.index))) return null;
  const target = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(target)) return null;
  const dot = raw.indexOf('.');
  return {
    before: text.slice(0, m.index),
    after: text.slice(m.index + raw.length),
    target,
    decimals: dot >= 0 ? raw.length - dot - 1 : 0,
    grouped: raw.includes(','),
  };
}

function render(p: Parsed, value: number): string {
  // en-US grouping, the same as lib/format, so the last frame matches the formatted value
  const n = p.grouped
    ? value.toLocaleString('en-US', { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals })
    : value.toFixed(p.decimals);
  return `${p.before}${n}${p.after}`;
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function AnimatedValue({ value, duration = 900 }: { value: string; duration?: number }) {
  const parsed = parse(value);
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<string>(() => (parsed && !reducedMotion() ? render(parsed, 0) : value));
  const done = useRef(false);

  useEffect(() => {
    if (!parsed || reducedMotion()) {
      setShown(value);
      return;
    }
    if (done.current) {
      setShown(value); // later data refreshes update instantly
      return;
    }
    const el = ref.current;
    let raf = 0;
    const run = () => {
      done.current = true;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setShown(t >= 1 ? value : render(parsed, parsed.target * eased));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    if (!el || typeof IntersectionObserver === 'undefined') {
      run();
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        run();
      }
    }, { threshold: 0.3 });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span ref={ref} className="tabular-nums" aria-label={value}>
      <span aria-hidden>{shown}</span>
    </span>
  );
}
