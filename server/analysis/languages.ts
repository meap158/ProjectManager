// Language definitions for the built-in line counter. Detection is by file extension or exact file
// name. Comment syntax drives code/comment/blank classification; `branches` drives the complexity
// estimate (count of branching tokens in code, the same approach scc uses).

export interface LanguageDef {
  name: string;
  extensions?: string[];
  filenames?: string[];
  lineComments: string[];
  blockComments: [string, string][];
  /** Regex source matching one branching construct; counted per code line. */
  branches?: string;
}

const C_COMMENTS = { lineComments: ['//'], blockComments: [['/*', '*/']] as [string, string][] };
const HASH_COMMENTS = { lineComments: ['#'], blockComments: [] as [string, string][] };

const C_BRANCHES = String.raw`\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?=[^.:?])`;
const PY_BRANCHES = String.raw`\b(?:if|elif|for|while|except|and|or|case)\b`;
const RB_BRANCHES = String.raw`\b(?:if|elsif|unless|for|while|until|when|rescue|and|or)\b|&&|\|\|`;
const SH_BRANCHES = String.raw`\b(?:if|elif|for|while|until|case)\b|&&|\|\|`;
const GO_BRANCHES = String.raw`\b(?:if|for|case|select)\b|&&|\|\|`;
const RUST_BRANCHES = String.raw`\b(?:if|for|while|loop|match)\b|=>|&&|\|\||\?`;

export const LANGUAGES: LanguageDef[] = [
  { name: 'TypeScript', extensions: ['ts', 'mts', 'cts'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'TSX', extensions: ['tsx'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'JSX', extensions: ['jsx'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'Python', extensions: ['py', 'pyw', 'pyi'], ...HASH_COMMENTS, branches: PY_BRANCHES },
  { name: 'Java', extensions: ['java'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'Kotlin', extensions: ['kt', 'kts'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'C#', extensions: ['cs'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'C', extensions: ['c', 'h'], ...C_COMMENTS, branches: C_BRANCHES },
  {
    name: 'C++',
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'],
    ...C_COMMENTS,
    branches: C_BRANCHES,
  },
  { name: 'Go', extensions: ['go'], ...C_COMMENTS, branches: GO_BRANCHES },
  { name: 'Rust', extensions: ['rs'], ...C_COMMENTS, branches: RUST_BRANCHES },
  { name: 'Swift', extensions: ['swift'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'Dart', extensions: ['dart'], ...C_COMMENTS, branches: C_BRANCHES },
  { name: 'Scala', extensions: ['scala', 'sc'], ...C_COMMENTS, branches: C_BRANCHES },
  {
    name: 'PHP',
    extensions: ['php'],
    lineComments: ['//', '#'],
    blockComments: [['/*', '*/']],
    branches: C_BRANCHES,
  },
  {
    name: 'Ruby',
    extensions: ['rb', 'rake', 'gemspec'],
    filenames: ['Gemfile', 'Rakefile'],
    lineComments: ['#'],
    blockComments: [['=begin', '=end']],
    branches: RB_BRANCHES,
  },
  {
    name: 'Lua',
    extensions: ['lua'],
    lineComments: ['--'],
    blockComments: [['--[[', ']]']],
    branches: String.raw`\b(?:if|elseif|for|while|repeat|and|or)\b`,
  },
  {
    name: 'Shell',
    extensions: ['sh', 'bash', 'zsh', 'fish'],
    ...HASH_COMMENTS,
    branches: SH_BRANCHES,
  },
  {
    name: 'PowerShell',
    extensions: ['ps1', 'psm1', 'psd1'],
    lineComments: ['#'],
    blockComments: [['<#', '#>']],
    branches: String.raw`\b(?:if|elseif|for|foreach|while|switch|catch)\b|-and\b|-or\b`,
  },
  {
    name: 'Batch',
    extensions: ['bat', 'cmd'],
    lineComments: ['REM ', 'rem ', '::'],
    blockComments: [],
    branches: String.raw`\b(?:if|for)\b`,
  },
  {
    name: 'SQL',
    extensions: ['sql'],
    lineComments: ['--'],
    blockComments: [['/*', '*/']],
    branches: String.raw`\b(?:CASE|WHEN|IF|WHILE)\b`,
  },
  { name: 'HTML', extensions: ['html', 'htm'], lineComments: [], blockComments: [['<!--', '-->']] },
  {
    name: 'Vue',
    extensions: ['vue'],
    lineComments: ['//'],
    blockComments: [
      ['<!--', '-->'],
      ['/*', '*/'],
    ],
    branches: C_BRANCHES,
  },
  {
    name: 'Svelte',
    extensions: ['svelte'],
    lineComments: ['//'],
    blockComments: [
      ['<!--', '-->'],
      ['/*', '*/'],
    ],
    branches: C_BRANCHES,
  },
  { name: 'CSS', extensions: ['css'], lineComments: [], blockComments: [['/*', '*/']] },
  { name: 'SCSS', extensions: ['scss', 'sass', 'less'], ...C_COMMENTS },
  { name: 'JSON', extensions: ['json', 'jsonc', 'json5'], lineComments: [], blockComments: [] },
  { name: 'YAML', extensions: ['yml', 'yaml'], ...HASH_COMMENTS },
  { name: 'TOML', extensions: ['toml'], ...HASH_COMMENTS },
  {
    name: 'XML',
    extensions: ['xml', 'xaml', 'csproj', 'svg'],
    lineComments: [],
    blockComments: [['<!--', '-->']],
  },
  { name: 'Markdown', extensions: ['md', 'mdx', 'markdown'], lineComments: [], blockComments: [] },
  { name: 'Dockerfile', filenames: ['Dockerfile', 'Containerfile'], ...HASH_COMMENTS },
  {
    name: 'Makefile',
    filenames: ['Makefile', 'makefile', 'GNUmakefile'],
    extensions: ['mk'],
    ...HASH_COMMENTS,
  },
  { name: 'GDScript', extensions: ['gd'], ...HASH_COMMENTS, branches: PY_BRANCHES },
  {
    name: 'GLSL',
    extensions: ['glsl', 'vert', 'frag', 'shader', 'hlsl', 'wgsl'],
    ...C_COMMENTS,
    branches: C_BRANCHES,
  },
  {
    name: 'R',
    extensions: ['r'],
    ...HASH_COMMENTS,
    branches: String.raw`\b(?:if|for|while|repeat)\b|&&|\|\|`,
  },
  {
    name: 'Elixir',
    extensions: ['ex', 'exs'],
    ...HASH_COMMENTS,
    branches: String.raw`\b(?:if|unless|case|cond|with|and|or)\b|->`,
  },
];

const byExtension = new Map<string, LanguageDef>();
const byFilename = new Map<string, LanguageDef>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions ?? []) byExtension.set(ext, lang);
  for (const name of lang.filenames ?? []) byFilename.set(name, lang);
}

/** Files that are recognisable but generated; counting them would distort the stats. */
const GENERATED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
]);

export function detectLanguage(fileName: string): LanguageDef | undefined {
  if (GENERATED_FILES.has(fileName) || /\.min\.(js|css)$/i.test(fileName)) return undefined;
  const exact = byFilename.get(fileName);
  if (exact) return exact;
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return byExtension.get(fileName.slice(dot + 1).toLowerCase());
}
