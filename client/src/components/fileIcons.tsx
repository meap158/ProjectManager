import type { ReactNode, SVGProps } from 'react';

// File-type icons for the Files tab tree, in the manner of VS Code's Explorer: a glyph per kind of
// file, found by exact name first (package.json, .gitignore, Dockerfile), then by extension, then a
// plain page. Drawn here as small line icons on the shared 16px grid, so there is no icon package
// and nothing to license. Colour comes from `tone`, mapped to design tokens in project-files.css.

export type FileGlyph =
  | 'folder'
  | 'folder-open'
  | 'folder-special'
  | 'file'
  | 'code'
  | 'json'
  | 'markdown'
  | 'config'
  | 'image'
  | 'lock'
  | 'text'
  | 'shell'
  | 'data'
  | 'style'
  | 'html'
  | 'git'
  | 'archive'
  | 'audio'
  | 'video'
  | 'test';

export type FileTone = 'plain' | 'code' | 'data' | 'doc' | 'media' | 'config' | 'shell' | 'danger';

export interface FileIconSpec {
  glyph: FileGlyph;
  tone: FileTone;
}

const BY_NAME: Record<string, FileIconSpec> = {
  'package.json': { glyph: 'json', tone: 'danger' },
  'package-lock.json': { glyph: 'lock', tone: 'config' },
  'pnpm-lock.yaml': { glyph: 'lock', tone: 'config' },
  'yarn.lock': { glyph: 'lock', tone: 'config' },
  'cargo.lock': { glyph: 'lock', tone: 'config' },
  'uv.lock': { glyph: 'lock', tone: 'config' },
  'go.sum': { glyph: 'lock', tone: 'config' },
  dockerfile: { glyph: 'config', tone: 'code' },
  makefile: { glyph: 'shell', tone: 'shell' },
  license: { glyph: 'text', tone: 'doc' },
  'license.md': { glyph: 'text', tone: 'doc' },
  readme: { glyph: 'markdown', tone: 'doc' },
  'readme.md': { glyph: 'markdown', tone: 'doc' },
  '.gitignore': { glyph: 'git', tone: 'config' },
  '.gitattributes': { glyph: 'git', tone: 'config' },
  '.gitmodules': { glyph: 'git', tone: 'config' },
  '.editorconfig': { glyph: 'config', tone: 'config' },
  '.nvmrc': { glyph: 'config', tone: 'config' },
  '.npmrc': { glyph: 'config', tone: 'config' },
  '.prettierrc': { glyph: 'config', tone: 'config' },
  '.prettierignore': { glyph: 'config', tone: 'config' },
  '.eslintrc': { glyph: 'config', tone: 'config' },
  '.env': { glyph: 'config', tone: 'config' },
};

const BY_EXTENSION: Record<string, FileIconSpec> = {
  ts: { glyph: 'code', tone: 'code' },
  tsx: { glyph: 'code', tone: 'code' },
  js: { glyph: 'code', tone: 'data' },
  jsx: { glyph: 'code', tone: 'data' },
  mjs: { glyph: 'code', tone: 'data' },
  cjs: { glyph: 'code', tone: 'data' },
  py: { glyph: 'code', tone: 'code' },
  rs: { glyph: 'code', tone: 'danger' },
  go: { glyph: 'code', tone: 'code' },
  java: { glyph: 'code', tone: 'danger' },
  kt: { glyph: 'code', tone: 'code' },
  cs: { glyph: 'code', tone: 'code' },
  c: { glyph: 'code', tone: 'code' },
  h: { glyph: 'code', tone: 'code' },
  cpp: { glyph: 'code', tone: 'code' },
  rb: { glyph: 'code', tone: 'danger' },
  php: { glyph: 'code', tone: 'code' },
  swift: { glyph: 'code', tone: 'danger' },
  sql: { glyph: 'data', tone: 'data' },
  json: { glyph: 'json', tone: 'data' },
  jsonc: { glyph: 'json', tone: 'data' },
  jsonl: { glyph: 'json', tone: 'data' },
  yml: { glyph: 'data', tone: 'danger' },
  yaml: { glyph: 'data', tone: 'danger' },
  toml: { glyph: 'data', tone: 'data' },
  csv: { glyph: 'data', tone: 'media' },
  xml: { glyph: 'html', tone: 'data' },
  md: { glyph: 'markdown', tone: 'doc' },
  mdx: { glyph: 'markdown', tone: 'doc' },
  txt: { glyph: 'text', tone: 'doc' },
  log: { glyph: 'text', tone: 'plain' },
  html: { glyph: 'html', tone: 'danger' },
  htm: { glyph: 'html', tone: 'danger' },
  css: { glyph: 'style', tone: 'code' },
  scss: { glyph: 'style', tone: 'danger' },
  less: { glyph: 'style', tone: 'code' },
  sh: { glyph: 'shell', tone: 'shell' },
  bash: { glyph: 'shell', tone: 'shell' },
  zsh: { glyph: 'shell', tone: 'shell' },
  bat: { glyph: 'shell', tone: 'shell' },
  cmd: { glyph: 'shell', tone: 'shell' },
  ps1: { glyph: 'shell', tone: 'shell' },
  png: { glyph: 'image', tone: 'media' },
  jpg: { glyph: 'image', tone: 'media' },
  jpeg: { glyph: 'image', tone: 'media' },
  gif: { glyph: 'image', tone: 'media' },
  webp: { glyph: 'image', tone: 'media' },
  avif: { glyph: 'image', tone: 'media' },
  svg: { glyph: 'image', tone: 'data' },
  ico: { glyph: 'image', tone: 'media' },
  mp3: { glyph: 'audio', tone: 'media' },
  wav: { glyph: 'audio', tone: 'media' },
  ogg: { glyph: 'audio', tone: 'media' },
  mp4: { glyph: 'video', tone: 'media' },
  mov: { glyph: 'video', tone: 'media' },
  webm: { glyph: 'video', tone: 'media' },
  zip: { glyph: 'archive', tone: 'data' },
  gz: { glyph: 'archive', tone: 'data' },
  tar: { glyph: 'archive', tone: 'data' },
  '7z': { glyph: 'archive', tone: 'data' },
  lock: { glyph: 'lock', tone: 'config' },
  env: { glyph: 'config', tone: 'config' },
  ini: { glyph: 'config', tone: 'config' },
  cfg: { glyph: 'config', tone: 'config' },
  conf: { glyph: 'config', tone: 'config' },
};

/** Folders VS Code's icon themes treat specially; the same names are recognisable on sight. */
const SPECIAL_FOLDERS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.claude',
  '.vscode',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
]);

/** The icon for one tree entry. Names are matched case-insensitively. */
export function iconFor(entry: { name: string; kind: 'dir' | 'file' }, open = false): FileIconSpec {
  const name = entry.name.toLowerCase();
  if (entry.kind === 'dir') {
    if (SPECIAL_FOLDERS.has(name)) return { glyph: 'folder-special', tone: 'config' };
    return { glyph: open ? 'folder-open' : 'folder', tone: 'plain' };
  }
  const exact = BY_NAME[name];
  if (exact) return exact;
  if (name.startsWith('.env.')) return { glyph: 'config', tone: 'config' };
  if (/\.(test|spec)\.[a-z0-9]+$/.test(name)) return { glyph: 'test', tone: 'shell' };
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  return BY_EXTENSION[extension] ?? { glyph: 'file', tone: 'plain' };
}

function Svg({ size, children, ...props }: SVGProps<SVGSVGElement> & { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

const PAGE = (
  <>
    <path d="M4 1.8h5l3 3v9.4H4z" />
    <path d="M9 1.8v3h3" />
  </>
);

const GLYPHS: Record<FileGlyph, ReactNode> = {
  folder: (
    <path d="M2 4.2a1 1 0 0 1 1-1h3l1.3 1.5H13a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  ),
  'folder-open': (
    <>
      <path d="M2 12.5V4.2a1 1 0 0 1 1-1h3l1.3 1.5H12.5a1 1 0 0 1 1 1V6" />
      <path d="M2.2 12.6l1.6-5a1 1 0 0 1 1-.7H14a.6.6 0 0 1 .6.8l-1.5 4.9a1 1 0 0 1-1 .7H3a.8.8 0 0 1-.8-.7z" />
    </>
  ),
  'folder-special': (
    <>
      <path d="M2 4.2a1 1 0 0 1 1-1h3l1.3 1.5H13a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      <path d="M6 9h4" />
    </>
  ),
  file: PAGE,
  code: (
    <>
      {PAGE}
      <path d="M7 8.2 5.8 9.4 7 10.6M9 8.2l1.2 1.2L9 10.6" />
    </>
  ),
  json: (
    <>
      {PAGE}
      <path d="M7 7.6c-.7 0-.8.4-.8.9v.6c0 .4-.3.6-.7.6.4 0 .7.2.7.6v.6c0 .5.1.9.8.9M9 7.6c.7 0 .8.4.8.9v.6c0 .4.3.6.7.6-.4 0-.7.2-.7.6v.6c0 .5-.1.9-.8.9" />
    </>
  ),
  markdown: (
    <>
      {PAGE}
      <path d="M5.8 11V8.6l1 1.2 1-1.2V11M10 8.6V11M9.2 10.2l.8.9.8-.9" />
    </>
  ),
  config: (
    <>
      {PAGE}
      <circle cx="8" cy="9.5" r="1.3" />
      <path d="M8 7.6v.6M8 10.8v.6M6.1 9.5h.6M9.3 9.5h.6" />
    </>
  ),
  image: (
    <>
      {PAGE}
      <path d="m5.6 12 2-2.2 1.2 1.2 1-1.2 1.6 2.2" />
    </>
  ),
  lock: (
    <>
      {PAGE}
      <rect x="6" y="9.2" width="4" height="2.8" rx=".6" />
      <path d="M6.8 9.2V8.4a1.2 1.2 0 0 1 2.4 0v.8" />
    </>
  ),
  text: (
    <>
      {PAGE}
      <path d="M5.8 8.2h4.4M5.8 10h4.4M5.8 11.8h2.6" />
    </>
  ),
  shell: (
    <>
      {PAGE}
      <path d="m5.8 8.4 1.6 1.2-1.6 1.2M8.6 11h1.8" />
    </>
  ),
  data: (
    <>
      {PAGE}
      <path d="M5.8 8.2h4.4M5.8 10h4.4M5.8 11.8h4.4M8 8.2v3.6" />
    </>
  ),
  style: (
    <>
      {PAGE}
      <path d="M6.6 8.2 6 11.8M9.6 8.2 9 11.8M5.6 9.2h4.6M5.4 10.8H10" />
    </>
  ),
  html: (
    <>
      {PAGE}
      <path d="M6.8 8.4 5.6 9.7l1.2 1.3M9.2 8.4l1.2 1.3-1.2 1.3" />
    </>
  ),
  git: (
    <>
      {PAGE}
      <circle cx="6.6" cy="8.6" r=".7" />
      <circle cx="9.4" cy="11.4" r=".7" />
      <path d="M6.6 9.3v.6c0 .8.8 1.5 1.6 1.5h.5" />
    </>
  ),
  archive: (
    <>
      {PAGE}
      <path d="M8 6.2v1M8 8.2v1M8 10.2v1M7 7.2h2M7 9.2h2" />
    </>
  ),
  audio: (
    <>
      {PAGE}
      <path d="M7.6 11.4V8.4l2.4-.6V10.6" />
      <circle cx="6.9" cy="11.4" r=".7" />
      <circle cx="9.3" cy="10.8" r=".7" />
    </>
  ),
  video: (
    <>
      {PAGE}
      <path d="m7 8.4 2.6 1.6L7 11.6z" />
    </>
  ),
  test: (
    <>
      {PAGE}
      <path d="m5.8 10 1.4 1.4 3-3" />
    </>
  ),
};

/** One entry's icon, tinted by its tone through CSS (`.fi-<tone>`). */
export function FileTypeIcon({ spec, size = 14 }: { spec: FileIconSpec; size?: number }) {
  return (
    <span className={`fi fi-${spec.tone}`} data-glyph={spec.glyph}>
      <Svg size={size}>{GLYPHS[spec.glyph]}</Svg>
    </span>
  );
}

/** VS Code's chevron: points right when closed and turns down when open (CSS rotates it). */
export function ChevronIcon({ size = 12 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={1.8}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Svg>
  );
}
