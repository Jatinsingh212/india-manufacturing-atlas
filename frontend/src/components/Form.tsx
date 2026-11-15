/**
 * Form controls styled for the Atlas.
 *
 * - <Select value onChange options placeholder />         native select (accessible, mobile friendly)
 * - <SearchInput value onChange placeholder debounce />   search box with icon + clear button
 * - <TextInput />, <TextArea />                           plain inputs (all native props pass through)
 * - <FormField label hint error htmlFor>{control}</FormField>
 * - <Toggle checked onChange label />                     switch
 * - <SegmentedControl value onChange options />           2-5 mutually exclusive options ("Top 5 | All")
 */
import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { ChevronDown, Search, X } from 'lucide-react';

const CONTROL =
  'w-full rounded-xl border border-line bg-surface text-ink shadow-[inset_0_1px_2px_rgba(10,28,53,0.03)] placeholder:text-muted transition-[border-color,box-shadow] focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:opacity-60 max-sm:text-base';

const CONTROL_SIZE = { sm: 'h-8 text-[13px] px-3 max-sm:h-10', md: 'h-9 text-sm px-3.5 max-sm:h-10' } as const;

// ============================================================================ Select

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'size'> {
  value: V | '' | null | undefined;
  onChange: (value: V | '') => void;
  options: ReadonlyArray<SelectOption<V>>;
  /** First, empty option (value ''), e.g. "All ministries". */
  placeholder?: string;
  /** Visible label rendered before the control. */
  label?: string;
  size?: 'sm' | 'md';
}

export function Select<V extends string = string>({ value, onChange, options, placeholder, label, size = 'md', className, id, ...rest }: SelectProps<V>) {
  const autoId = useId();
  const selId = id ?? autoId;
  const control = (
    <div className={clsx('relative min-w-0', !label && className)}>
      <select
        id={selId}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value as V | '')}
        className={clsx(CONTROL, CONTROL_SIZE[size], 'cursor-pointer appearance-none pr-8')}
        {...rest}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
  if (!label) return control;
  return (
    <label htmlFor={selId} className={clsx('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {control}
    </label>
  );
}

// ============================================================================ SearchInput

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string;
  /** Called with the (debounced, when `debounce` > 0) value. */
  onChange: (value: string) => void;
  /** Debounce in ms (default 0 = immediate). */
  debounce?: number;
  size?: 'sm' | 'md';
}

export function SearchInput({ value, onChange, debounce = 0, size = 'md', placeholder = 'Search…', className, ...rest }: SearchInputProps) {
  const [local, setLocal] = useState(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    if (debounce <= 0 || local === value) return;
    const t = window.setTimeout(() => onChangeRef.current(local), debounce);
    return () => window.clearTimeout(t);
  }, [local, debounce, value]);
  return (
    <div className={clsx('relative min-w-0', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search"
        value={local}
        placeholder={placeholder}
        onChange={(e) => {
          setLocal(e.target.value);
          if (debounce <= 0) onChange(e.target.value);
        }}
        className={clsx(CONTROL, CONTROL_SIZE[size], 'pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden')}
        {...rest}
      />
      {local ? (
        <button
          type="button"
          onClick={() => {
            setLocal('');
            onChange('');
          }}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-muted hover:bg-surface-3 hover:text-ink"
          aria-label="Clear search"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// ============================================================================ TextInput / TextArea / FormField

export const TextInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'sm' | 'md'; invalid?: boolean }>(
  function TextInput({ className, size = 'md', invalid, ...rest }, ref) {
    return <input ref={ref} className={clsx(CONTROL, CONTROL_SIZE[size], invalid && 'border-bad focus:border-bad focus:ring-bad/20', className)} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function TextArea(
  { className, invalid, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={clsx(CONTROL, 'px-3.5 py-2.5 text-sm leading-relaxed', invalid && 'border-bad focus:border-bad focus:ring-bad/20', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export interface FormFieldProps {
  label: ReactNode;
  /** id of the control (for the <label htmlFor>). */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function FormField({ label, htmlFor, hint, error, required, className, children }: FormFieldProps) {
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-bad">*</span> : null}
      </label>
      {children}
      {error ? <div className="text-xs text-bad-ink">{error}</div> : hint ? <div className="text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

// ============================================================================ Toggle

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function Toggle({ checked, onChange, label, disabled, size = 'md', className }: ToggleProps) {
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'size-3' : 'size-4';
  const shift = size === 'sm' ? 'translate-x-3' : 'translate-x-4';
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none', disabled && 'cursor-not-allowed opacity-60', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors', track, checked ? 'bg-brand' : 'bg-line-strong')}
      >
        <span className={clsx('rounded-full bg-white shadow transition-transform', knob, checked && shift)} aria-hidden />
      </button>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

// ============================================================================ SegmentedControl

export interface SegmentedControlProps<V extends string> {
  value: V;
  onChange: (value: V) => void;
  options: ReadonlyArray<{ value: V; label: ReactNode; title?: string }>;
  size?: 'xs' | 'sm';
  /** Accessible group label. */
  ariaLabel?: string;
  className?: string;
}

export function SegmentedControl<V extends string>({ value, onChange, options, size = 'sm', ariaLabel, className }: SegmentedControlProps<V>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx('inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-surface-2 p-0.5 scrollbar-hide', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={clsx(
              'rounded-md font-medium whitespace-nowrap transition-colors',
              size === 'xs' ? 'h-6 px-2 text-[11.5px] max-sm:h-8' : 'h-7 px-2.5 text-xs max-sm:h-8',
              active ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
