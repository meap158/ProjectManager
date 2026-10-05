import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 14, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Portfolio / overview grid. */
export function GridIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.5" />
    </Base>
  );
}

/** Kanban columns. */
export function BoardIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2" y="5" width="3.2" height="9" rx="1" />
      <rect x="6.4" y="2" width="3.2" height="12" rx="1" />
      <rect x="10.8" y="7.5" width="3.2" height="6.5" rx="1" />
    </Base>
  );
}

/** Terminal prompt: AI agent sessions and runs. */
export function TerminalIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 5.5 7.5 8l-3 2.5" />
      <path d="M9 11.5h3.5" />
    </Base>
  );
}

// ---- Provider brand marks -----------------------------------------------------------------------
// Official marks are inlined (the app works offline, so no CDN links) from Simple Icons drawings
// (CC0) for nominative identification only — trademarks belong to their owners. Only marks we
// could verify as the right brand are used: OpenAI/xAI publish no redistributable mark, and the
// "OpenCode" Simple Icons entry is not the opencode.ai brand, so Codex, Grok and OpenCode keep
// the generic terminal glyph rather than a wrong "official" one.

function BrandBase({ size = 14, children }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Anthropic's "A" mark (Simple Icons `anthropic`, CC0). */
export function ClaudeIcon(props: IconProps) {
  return (
    <BrandBase {...props}>
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </BrandBase>
  );
}

/** Google Gemini sparkle (Simple Icons `googlegemini`, CC0). */
export function GeminiIcon(props: IconProps) {
  return (
    <BrandBase {...props}>
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </BrandBase>
  );
}

/** Google Antigravity mark (AGY levitation chevron star). */
export function AntigravityIcon(props: IconProps) {
  return (
    <BrandBase {...props}>
      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
    </BrandBase>
  );
}

/** Official mark where verified, generic terminal glyph otherwise (never a wrong mark). */
export function ProviderIcon({ id, ...props }: IconProps & { id: string }) {
  if (id === 'claude') return <ClaudeIcon {...props} />;
  if (id === 'antigravity' || id === 'agy') return <AntigravityIcon {...props} />;
  if (id === 'gemini') return <GeminiIcon {...props} />;
  return <TerminalIcon {...props} />;
}

/** Sliders: settings (same metaphor as KDP's settings icon). */
export function SettingsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2 5.5h12" />
      <circle cx="6" cy="5.5" r="1.8" fill="var(--surface)" />
      <path d="M2 10.5h12" />
      <circle cx="10.5" cy="10.5" r="1.8" fill="var(--surface)" />
    </Base>
  );
}
