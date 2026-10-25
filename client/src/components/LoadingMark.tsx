import './loading-mark.css';

/**
 * The ProjectManager logo, animated as a sign that a wait is working rather than stalled: the three
 * board columns rise in turn, then settle and rise again. After TrendRelay's loading mark: pure
 * markup and CSS (see loading-mark.css), so it runs no script and starts no timer a backgrounded
 * tab could freeze, takes its colours from the theme tokens, and slows instead of stopping under
 * reduced motion (a frozen indicator reads as a hung request).
 *
 * Decorative: pair it with visible text in a `role="status"` region that says what is loading.
 */
export function LoadingMark({ size = 56 }: { size?: number }) {
  return (
    <span className="loading-mark" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" focusable="false">
        <rect className="loading-mark-tile" width="32" height="32" rx="7" />
        <rect className="loading-mark-bar" x="7" y="8" width="5" height="16" rx="1.5" />
        <rect className="loading-mark-bar" x="13.5" y="8" width="5" height="10" rx="1.5" />
        <rect className="loading-mark-bar" x="20" y="8" width="5" height="6" rx="1.5" />
      </svg>
    </span>
  );
}
