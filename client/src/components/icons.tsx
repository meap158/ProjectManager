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
// Marks inlined (the app works offline, so no CDN) for nominative identification only —
// trademarks belong to their owners. Claude Code and OpenCode come from Simple Icons (CC0);
// Codex, Grok and Antigravity from LobeHub's AI brand icon set (lobehub/lobe-icons, MIT), as
// Simple Icons has none for them. Each is drawn in its brand colour (tokens --brand-*), or in the
// text colour where the brand colour is black/white, so it stays visible in both themes.

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

/** Codex's mark (LobeHub `codex`, MIT), in Codex blue. */
export function CodexIcon(props: IconProps) {
  return (
    <BrandBase {...props} color="var(--brand-codex)">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </BrandBase>
  );
}

/** Grok's mark (LobeHub `grok`, MIT). Black/white brand, so it follows the text colour. */
export function GrokIcon(props: IconProps) {
  return (
    <BrandBase {...props} color="var(--text)">
      <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
    </BrandBase>
  );
}

/** Antigravity's mark (LobeHub `antigravity`, MIT), in Antigravity blue. */
export function AntigravityIcon(props: IconProps) {
  return (
    <BrandBase {...props} color="var(--brand-antigravity)">
      <path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" />
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
  if (id === 'codex') return <CodexIcon {...props} />;
  if (id === 'grok') return <GrokIcon {...props} />;
  if (id === 'antigravity') return <AntigravityIcon {...props} />;
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

/** Start a stopped session (filled play triangle). */
export function PlayIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />
    </Base>
  );
}

/** Stop a running session (filled square). */
export function StopIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </Base>
  );
}
