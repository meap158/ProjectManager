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
// Codex (the OpenAI mark), Grok and Antigravity from LobeHub's AI brand icon set (lobehub/lobe-icons, MIT), as
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

/** Codex is OpenAI's: the OpenAI mark, as on the ChatGPT app (LobeHub `openai`, MIT). Black/white
    brand, so it follows the text colour. */
export function CodexIcon(props: IconProps) {
  return (
    <BrandBase {...props} color="var(--text)">
      <path
        fillRule="evenodd"
        d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
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

/** Light theme: a sun. */
export function SunIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </Base>
  );
}

/** Dark theme: a crescent moon. */
export function MoonIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z" />
    </Base>
  );
}

/** Follow the system theme: a monitor. */
export function MonitorIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11v3" />
    </Base>
  );
}
