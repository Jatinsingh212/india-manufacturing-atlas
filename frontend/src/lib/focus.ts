/**
 * Focus helpers for modal surfaces.
 *
 * Dialogs keep Tab inside their panel and register on a stack so a drawer opened from another
 * overlay (or a modal over a drawer) owns the keyboard until it closes.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Visible, tabbable elements inside a panel, in DOM order. */
export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]'),
  );
}

const stack: HTMLElement[] = [];

export function pushOverlay(panel: HTMLElement): void {
  stack.push(panel);
}

export function popOverlay(panel: HTMLElement): void {
  const index = stack.lastIndexOf(panel);
  if (index >= 0) stack.splice(index, 1);
}

/** True when this panel is the most recently opened overlay. */
export function isTopOverlay(panel: HTMLElement | null): boolean {
  return panel !== null && stack[stack.length - 1] === panel;
}

/** Keep Tab / Shift+Tab inside the panel. Returns true when the key was handled. */
export function trapTab(event: KeyboardEvent, panel: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  const list = focusableElements(panel);
  if (!list.length) {
    event.preventDefault();
    panel.focus();
    return true;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = Boolean(active && active !== panel && panel.contains(active));
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
