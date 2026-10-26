import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SopInfo, SopResult } from '../shared/types.js';

// Our SOPs (PM-316): the shared standard every project's AGENTS.md carries, each with a read-only
// check run against a project folder. Order: what keeps work safe and resumable first (agent
// instructions, no secrets in git, handover), then planning (roadmap, owner pages), then quality of
// what ships (writing style, launcher, design). Checks never write inside a project.

const run = promisify(execFile);

export interface Sop extends SopInfo {
  check: (root: string) => Promise<Omit<SopResult, 'waiver'>>;
}

const exists = async (file: string) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};
const read = async (file: string) => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
};
/** Tracked paths matching the pathspecs, or null when the folder is not a git repository. */
async function tracked(root: string, specs: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', ['ls-files', '--', ...specs], {
      cwd: root,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1 << 22,
    });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}
/** The project's agent instructions: AGENTS.md, else CLAUDE.md. */
const instructions = async (root: string) =>
  (await read(path.join(root, 'AGENTS.md'))) ?? (await read(path.join(root, 'CLAUDE.md')));

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pubspec.yaml',
];
/** Something that runs: a manifest at the root, or a .NET project file. */
async function runnable(root: string): Promise<boolean> {
  for (const m of MANIFESTS) if (await exists(path.join(root, m))) return true;
  try {
    return (await readdir(root)).some((f) => /\.(csproj|sln)$/i.test(f));
  } catch {
    return false;
  }
}
/** A user interface: a UI framework in package.json, or an index.html near the top. */
async function hasUi(root: string): Promise<boolean> {
  const pkg = await read(path.join(root, 'package.json'));
  if (pkg && /"(react|vue|svelte|next|@angular\/core|solid-js|preact|electron)"\s*:/.test(pkg))
    return true;
  for (const dir of ['', 'public', 'client', 'src', 'web', 'app'])
    if (await exists(path.join(root, dir, 'index.html'))) return true;
  return false;
}

const pass = (detail: string) => ({ state: 'pass' as const, detail });
const fail = (detail: string) => ({ state: 'fail' as const, detail });
const na = (detail: string) => ({ state: 'na' as const, detail });

export const SOPS: Sop[] = [
  {
    id: 'agent-instructions',
    title: 'Agent instructions',
    short: 'Agents',
    summary: 'AGENTS.md holds the rules every coding agent follows; CLAUDE.md only points to it.',
    why: 'One canonical file means Codex, Claude Code, Gemini and Cursor all work by the same rules, and a rule changed once applies everywhere.',
    how: 'AGENTS.md exists at the project root, and CLAUDE.md exists and refers to AGENTS.md.',
    fix: 'Create AGENTS.md with the architecture map, conventions, launching and definition of done. Make CLAUDE.md a short pointer that imports @AGENTS.md.',
    check: async (root) => {
      const agents = await exists(path.join(root, 'AGENTS.md'));
      const claude = await read(path.join(root, 'CLAUDE.md'));
      if (!agents && claude === null) return fail('No AGENTS.md or CLAUDE.md');
      if (!agents) return fail('Rules live in CLAUDE.md; there is no AGENTS.md');
      if (claude === null)
        return fail('No CLAUDE.md pointer, so Claude Code will not find AGENTS.md');
      if (!claude.includes('AGENTS.md')) return fail('CLAUDE.md does not point to AGENTS.md');
      return pass('AGENTS.md, with CLAUDE.md pointing to it');
    },
  },
  {
    id: 'no-secrets',
    title: 'No secrets in git',
    short: 'Secrets',
    summary: '.env files, local databases and private keys are never committed.',
    why: 'A committed key stays in history after it is deleted, and several projects are public.',
    how: 'git ls-files finds no .env file (examples excepted), no SQLite database and no private key.',
    fix: 'Untrack the files with git rm --cached, add them to .gitignore, and rotate any key that was committed.',
    check: async (root) => {
      const files = await tracked(root, [
        ':(glob)**/.env',
        ':(glob)**/.env.*',
        ':(glob)**/*.db',
        ':(glob)**/*.sqlite',
        ':(glob)**/*.sqlite3',
        ':(glob)**/*.pem',
        ':(glob)**/id_rsa',
        ':(glob)**/id_ed25519',
      ]);
      if (files === null) return na('Not a git repository');
      const bad = files.filter((f) => !/\.env\.(example|sample|template)$/i.test(f));
      return bad.length
        ? fail(
            `Tracked: ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? ` and ${bad.length - 4} more` : ''}`,
          )
        : pass('Nothing secret or local is tracked');
    },
  },
  {
    id: 'handover',
    title: 'Agent handover',
    short: 'Handover',
    summary: 'AGENT_HANDOVER.md is a current-state snapshot, kept local and out of git.',
    why: 'The next agent resumes from it instead of guessing; it names local paths and accounts, so it stays private.',
    how: 'AGENT_HANDOVER.md exists and git does not track it.',
    fix: 'Write the snapshot (state, open tasks, gotchas), add it to .gitignore, and untrack it without deleting it if it was committed.',
    check: async (root) => {
      if (!(await exists(path.join(root, 'AGENT_HANDOVER.md'))))
        return fail('No AGENT_HANDOVER.md');
      const files = await tracked(root, ['AGENT_HANDOVER.md']);
      if (files?.length) return fail('AGENT_HANDOVER.md is tracked by git');
      return pass('Present and local only');
    },
  },
  {
    id: 'roadmap',
    title: 'Roadmap',
    short: 'Roadmap',
    summary:
      'ROADMAP.md holds the vision, scope, phases with exit criteria, dependencies and risks.',
    why: 'Agents and the owner share one picture of where the project is going and what is out of scope.',
    how: 'ROADMAP.md exists at the project root.',
    fix: 'Write ROADMAP.md from what the owner has committed to, marked "Draft" until they confirm it.',
    check: async (root) =>
      (await exists(path.join(root, 'ROADMAP.md')))
        ? pass('ROADMAP.md present')
        : fail('No ROADMAP.md'),
  },
  {
    id: 'owner-pages',
    title: 'Owner pages',
    short: 'Owner desk',
    summary: 'The Owner desk lists work only a person can do, built from owner-desk.json.',
    why: 'Accounts, credentials, approvals and real-device checks need the owner; one page keeps them from getting lost in chat.',
    how: 'References/owner-pages/owner-desk.json exists.',
    fix: 'Add the Owner Pages generator and an owner-desk.json, then build the pages. Mark tasks Completed only with evidence.',
    check: async (root) =>
      (await exists(path.join(root, 'References', 'owner-pages', 'owner-desk.json')))
        ? pass('owner-desk.json present')
        : fail('No References/owner-pages/owner-desk.json'),
  },
  {
    id: 'writing-style',
    title: 'Writing style',
    short: 'Writing',
    summary:
      'Prose reads like a person wrote it: no em dashes, stock phrases or chatbot residue (PM-314).',
    why: 'Machine-text tells make docs and UI copy harder to trust and read. The pattern list is blader/humanizer.',
    how: "The project's agent instructions carry the writing-style rule.",
    fix: 'Add the writing-style rule to AGENTS.md, with the prose audit (npm run prose:audit -- --diff) before each commit.',
    check: async (root) => {
      const text = await instructions(root);
      if (text === null) return fail('No agent instructions to carry the rule');
      return /humanizer|writing style/i.test(text)
        ? pass('The rule is in the agent instructions')
        : fail('The agent instructions have no writing-style rule');
    },
  },
  {
    id: 'launcher',
    title: 'One-command launcher',
    short: 'Launcher',
    summary: 'One obvious launch command, with a window title naming the project and the service.',
    why: 'Anyone can start the project without reading code, and a row of terminal windows stays tellable apart.',
    how: 'A script at the project root (launch.bat, start.cmd and the like) sets a window title.',
    fix: 'Add launch scripts that check prerequisites, pick a free port and set a title such as "<Project> - Server".',
    check: async (root) => {
      if (!(await runnable(root))) return na('Nothing to run (no app manifest)');
      // Launchers are named many ways (launch.bat, start.cmd, "Launch X.cmd"): any root script.
      let names: string[] = [];
      try {
        names = (await readdir(root)).filter((f) => /\.(bat|cmd|ps1|sh|command)$/i.test(f));
      } catch {
        /* unreadable folder: reported as no launcher */
      }
      if (!names.length) return fail('No launch script at the project root');
      const titled: string[] = [];
      for (const name of names) {
        const text = await read(path.join(root, name));
        if (text && /^\s*@?title\s+\S|WindowTitle|\]0;|^\s*start\s+"[^"]+"/im.test(text))
          titled.push(name);
      }
      return titled.length
        ? pass(`${titled[0]} sets a window title`)
        : fail(
            `${names.slice(0, 3).join(', ')} set${names.length === 1 ? 's' : ''} no window title`,
          );
    },
  },
  {
    id: 'design',
    title: 'Design system',
    short: 'Design',
    summary: 'DESIGN.md records the tokens, components and rules the UI follows.',
    why: 'Agents change the UI often; a written system keeps it consistent instead of drifting screen by screen.',
    how: 'Projects with a user interface have DESIGN.md at the root.',
    fix: 'Write DESIGN.md from the existing tokens and components: colours, type, spacing, states and accessibility rules.',
    check: async (root) => {
      if (await exists(path.join(root, 'DESIGN.md'))) return pass('DESIGN.md present');
      return (await hasUi(root))
        ? fail('Has a user interface but no DESIGN.md')
        : na('No user interface found');
    },
  },
];

export const sopInfo = (): SopInfo[] => SOPS.map(({ check: _check, ...info }) => info);

/** Runs every check on one folder; a missing folder is reported once, on every SOP. */
export async function checkProject(
  root: string,
): Promise<Record<string, Omit<SopResult, 'waiver'>>> {
  const out: Record<string, Omit<SopResult, 'waiver'>> = {};
  if (!(await exists(root))) {
    for (const sop of SOPS) out[sop.id] = na('Folder not found');
    return out;
  }
  await Promise.all(
    SOPS.map(async (sop) => {
      try {
        out[sop.id] = await sop.check(root);
      } catch (e) {
        out[sop.id] = fail(`Check failed: ${(e as Error).message}`);
      }
    }),
  );
  return out;
}

/** The text of a card that asks an agent to bring one project up to an SOP. */
export function sopCardText(sop: SopInfo, detail: string): { title: string; description: string } {
  return {
    title: `SOP: ${sop.title}`,
    description: [
      `Bring this project up to our "${sop.title}" SOP (Settings > SOPs in ProjectManager).`,
      '',
      `What it asks: ${sop.summary}`,
      `Why: ${sop.why}`,
      `Found: ${detail}`,
      `How it is checked: ${sop.how}`,
      `How to fix: ${sop.fix}`,
      '',
      'Follow the project AGENTS.md and its existing conventions. Commit with a reference to this card.',
    ].join('\n'),
  };
}
