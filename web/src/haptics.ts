/**
 * haptics.ts — the design's haptic map (0c), best-effort.
 *
 * `navigator.vibrate` is Android/Chrome only; iOS Safari has no web haptics API at all, so on
 * iPhone every call is a silent no-op. That is acceptable (accent + label already carry state)
 * and better than faking it. The rule "nothing fires twice for one event, and nothing fires
 * during streaming" is enforced by the call sites, not here.
 */
type Kind = 'light' | 'medium' | 'selection' | 'warning' | 'error' | 'success';

const PATTERN: Record<Kind, number | number[]> = {
  light: 10,
  medium: 20,
  selection: 8,
  warning: [18, 60, 18],   // notification-style double tap
  error: [24, 50, 24, 50, 24],
  success: 12,
};

export function haptic(kind: Kind): void {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate?.(PATTERN[kind]);
  } catch { /* unsupported: silent */ }
}
