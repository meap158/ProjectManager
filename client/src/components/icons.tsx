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
// Official marks inlined from Simple Icons (CC0; the app works offline, so no CDN) for nominative
// identification only — trademarks belong to their owners. Only verified marks are used, in the
// brand colour (tokens --brand-*): Claude Code (claudecode) and OpenCode
// (opencode, sourced from OpenCode's own identity mark). OpenAI asked Simple Icons to drop its
// mark, and xAI/Grok and Antigravity have none published, so Codex, Grok and Antigravity keep the
// generic terminal glyph rather than a wrong "official" one.

function BrandBase({ size = 14, color, children }: IconProps & { color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ color }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Claude Code's mark (Simple Icons `claudecode`, CC0), in Claude orange. */
export function ClaudeIcon(props: IconProps) {
  return (
    <BrandBase {...props} color="var(--brand-claude)">
      <path d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z" />
    </BrandBase>
  );
}

/** OpenCode's mark (Simple Icons `opencode`, CC0). Its brand colour is black, so it follows
    the text colour and stays visible in dark mode. */
export function OpenCodeIcon(props: IconProps) {
  return (
    <BrandBase {...props} color="var(--text)">
      <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </BrandBase>
  );
}

/** Display names, so rows can name the CLI next to a generic glyph. */
export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  shell: 'Shell',
  custom: 'Custom command',
};

/** Official mark where verified, generic terminal glyph otherwise (never a wrong mark). */
export function ProviderIcon({ id, ...props }: IconProps & { id: string }) {
  if (id === 'claude') return <ClaudeIcon {...props} />;
  if (id === 'opencode') return <OpenCodeIcon {...props} />;
  return <TerminalIcon {...props} />;
}

/** Rows: the board's List view. */
export function ListIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5" />
      <path d="M2 4h.5M2 8h.5M2 12h.5" />
    </Base>
  );
}

/** Page with a folded corner: one card in the List view (Notion's page glyph). */
export function PageIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.8v3h3" />
    </Base>
  );
}

/** Stacked folders: the tracked-project list (mobile tab bar). */
export function FoldersIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2 5V3.5A1 1 0 0 1 3 2.5h2.5L7 4h5a1 1 0 0 1 1 1v1" />
      <path d="M2 7a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </Base>
  );
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
