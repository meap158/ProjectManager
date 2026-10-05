// Official install recipes for the agent CLIs, verified against each vendor's own
// docs (Claude Code setup, Codex README, Grok Build overview, OpenCode README,
// Gemini CLI README). One recommended method per OS — no alternatives menu.
//
// Security model: the recipe (label, detail, URL/command) is shown in the Settings UI
// *before* anything runs, and nothing executes without the explicit Install POST.
// Downloads happen server-side with size/time caps; installers are piped to the
// interpreter's stdin (never through a shell string), and full output is logged.

import type { AgentProvider, InstallRecipe } from '../../shared/types.js';

type Platform = 'win32' | 'darwin' | 'linux';

const PS = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

function script(
  label: string,
  scriptUrl: string,
  interpreter: string[],
  docUrl: string,
  detail: string,
): InstallRecipe {
  return { label, detail, docUrl, kind: 'script', scriptUrl, interpreter };
}

function npmGlobal(pkg: string, docUrl: string): InstallRecipe {
  return {
    label: `npm package ${pkg}`,
    detail: `Runs "npm install -g ${pkg}" as your user.`,
    docUrl,
    kind: 'command',
    command: ['npm', 'install', '-g', pkg],
  };
}

const CLAUDE_DOCS = 'https://docs.anthropic.com/en/docs/claude-code/setup';
const CODEX_DOCS = 'https://github.com/openai/codex#readme';
const GROK_DOCS = 'https://docs.x.ai/build/overview';
const OPENCODE_DOCS = 'https://opencode.ai/docs';
const GEMINI_DOCS = 'https://github.com/google-gemini/gemini-cli#readme';

export const INSTALL_RECIPES: Record<string, Partial<Record<Platform, InstallRecipe>>> = {
  claude: {
    win32: script(
      'Official installer (claude.ai)',
      'https://claude.ai/install.ps1',
      PS,
      CLAUDE_DOCS,
      'Downloads the Windows installer from claude.ai and runs it via PowerShell.',
    ),
    darwin: script(
      'Official installer (claude.ai)',
      'https://claude.ai/install.sh',
      ['bash'],
      CLAUDE_DOCS,
      'Downloads the installer from claude.ai and runs it via bash.',
    ),
    linux: script(
      'Official installer (claude.ai)',
      'https://claude.ai/install.sh',
      ['bash'],
      CLAUDE_DOCS,
      'Downloads the installer from claude.ai and runs it via bash.',
    ),
  },
  codex: {
    win32: script(
      'Official installer (chatgpt.com)',
      'https://chatgpt.com/codex/install.ps1',
      PS,
      CODEX_DOCS,
      'Downloads the Windows installer and runs it via PowerShell.',
    ),
    darwin: script(
      'Official installer (chatgpt.com)',
      'https://chatgpt.com/codex/install.sh',
      ['sh'],
      CODEX_DOCS,
      'Downloads the installer and runs it via sh.',
    ),
    linux: script(
      'Official installer (chatgpt.com)',
      'https://chatgpt.com/codex/install.sh',
      ['sh'],
      CODEX_DOCS,
      'Downloads the installer and runs it via sh.',
    ),
  },
  grok: {
    win32: script(
      'Official installer (x.ai)',
      'https://x.ai/cli/install.ps1',
      PS,
      GROK_DOCS,
      'Downloads the Windows installer from x.ai and runs it via PowerShell.',
    ),
    darwin: script(
      'Official installer (x.ai)',
      'https://x.ai/cli/install.sh',
      ['bash'],
      GROK_DOCS,
      'Downloads the installer from x.ai and runs it via bash.',
    ),
    linux: script(
      'Official installer (x.ai)',
      'https://x.ai/cli/install.sh',
      ['bash'],
      GROK_DOCS,
      'Downloads the installer from x.ai and runs it via bash.',
    ),
  },
  opencode: {
    win32: npmGlobal('opencode-ai@latest', OPENCODE_DOCS),
    darwin: script(
      'Official installer (opencode.ai)',
      'https://opencode.ai/install',
      ['bash'],
      OPENCODE_DOCS,
      'Downloads the installer from opencode.ai and runs it via bash.',
    ),
    linux: script(
      'Official installer (opencode.ai)',
      'https://opencode.ai/install',
      ['bash'],
      OPENCODE_DOCS,
      'Downloads the installer from opencode.ai and runs it via bash.',
    ),
  },
  gemini: {
    win32: npmGlobal('@google/gemini-cli', GEMINI_DOCS),
    darwin: npmGlobal('@google/gemini-cli', GEMINI_DOCS),
    linux: npmGlobal('@google/gemini-cli', GEMINI_DOCS),
  },
};

/** The recipe for a provider on a platform (pure: platform is a parameter for tests). */
export function recipeFor(
  provider: Pick<AgentProvider, 'id'>,
  platform: string = process.platform,
): InstallRecipe | null {
  const byOs = INSTALL_RECIPES[provider.id as keyof typeof INSTALL_RECIPES] ?? {};
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return null;
  return byOs[platform] ?? null;
}

export const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

/** Downloads an installer script with size/time caps. Throws on anything suspicious. */
export async function fetchScript(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to download: not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'data:') {
    // data: URLs involve no network and are handy for tests; anything else must be HTTPS.
    throw new Error('Refusing to download over plain HTTP');
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': 'ProjectManager-agent-installer' },
  });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_SCRIPT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Installer exceeds the 8MB download cap');
    }
    chunks.push(Buffer.from(value));
  }
  const script = Buffer.concat(chunks);
  if (script.length === 0) throw new Error('Downloaded installer is empty');
  if (script.includes(0)) throw new Error('Downloaded installer is not a text script');
  return script;
}
