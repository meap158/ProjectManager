import { useEffect, useState } from 'react';
import {
  PERMISSION_LEVEL_LABELS,
  type AgentPermissions,
  type AgentProviderStatus,
  type PermissionLevel,
} from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from './Dropdown';
import { ProviderIcon } from './icons';

const LEVELS: PermissionLevel[] = ['cli', 'read', 'edit', 'full'];

const LEVEL_HINTS: Record<PermissionLevel, string> = {
  cli: 'Pass no permission flags: the CLI’s own config and defaults apply',
  auto: 'Safe actions run without asking; a classifier blocks risky ones (the default)',
  read: 'The agent can look but not change anything',
  edit: 'The agent can change files in the project; risky commands still ask',
  full: 'The agent can change files and run any command without asking',
};

/** What each CLI actually receives for a level (mirrors server/agents/permissions.ts). */
const CLI_FLAGS: Record<string, Partial<Record<PermissionLevel, string>>> = {
  claude: {
    read: '--permission-mode plan',
    auto: '--permission-mode auto',
    edit: '--permission-mode acceptEdits',
    full: '--permission-mode bypassPermissions',
  },
  codex: {
    read: '--sandbox read-only',
    edit: '--sandbox workspace-write',
    full: '--sandbox danger-full-access',
  },
  grok: {
    read: '--permission-mode plan',
    edit: '--permission-mode acceptEdits',
    full: '--permission-mode bypassPermissions',
  },
  antigravity: {
    read: '--mode plan',
    edit: '--mode accept-edits',
    full: '--dangerously-skip-permissions',
  },
  opencode: {
    read: 'config: edits denied, commands ask',
    edit: 'config: edits allowed, commands ask',
    full: 'config: edits and commands allowed',
  },
};

/**
 * Settings → Agent permissions: one global level, and per CLI either "Inherit global" or its own
 * level. Applied to terminal sessions at their next start/relaunch and used as the default for
 * one-shot runs (each run can still pick another level).
 */
export function AgentPermissionsPanel({
  providers,
  onError,
}: {
  providers: AgentProviderStatus[] | null;
  onError: (message: string) => void;
}) {
  const [perms, setPerms] = useState<AgentPermissions | null>(null);

  useEffect(() => {
    let active = true;
    api.getPermissions().then(
      (p) => active && setPerms(p),
      (e: Error) => active && onError(e.message),
    );
    return () => {
      active = false;
    };
  }, [onError]);

  const save = (next: AgentPermissions) => {
    const before = perms;
    setPerms(next); // Optimistic; a failure restores the previous choice.
    // claudeAuto is read only: only the levels are saved.
    api.savePermissions({ global: next.global, providers: next.providers }).catch((e: Error) => {
      setPerms(before);
      onError(e.message);
    });
  };

  const clis = (providers ?? []).filter((p) => CLI_FLAGS[p.id]);

  return (
    <section className="panel" aria-label="Agent permissions">
      <div className="panel-header">
        <h2>Agent permissions</h2>
        <span className="meta">applies to terminal sessions on their next start</span>
      </div>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        One level for every agent, or a different one per CLI. Each level is translated into that
        CLI’s own permission settings; one-shot runs start from it and can still pick another.
      </p>
      {perms === null || providers === null ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <ul className="list">
          <li className="permission-row">
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>All agents</b>{' '}
              <span className="faint" style={{ fontSize: 12.5 }}>
                — {LEVEL_HINTS[perms.global]}
              </span>
            </span>
            <Dropdown
              label="Permission level for all agents"
              value={perms.global}
              options={LEVELS.map((level) => ({
                value: level,
                label: PERMISSION_LEVEL_LABELS[level],
                sub: LEVEL_HINTS[level],
              }))}
              onChange={(global: PermissionLevel) => save({ ...perms, global })}
            />
          </li>
          {clis.map((p) => {
            const own = perms.providers[p.id] ?? 'inherit';
            const effective = own === 'inherit' ? perms.global : own;
            const flags = CLI_FLAGS[p.id]?.[effective];
            return (
              <li key={p.id} className="permission-row">
                <span className="permission-cli">
                  <ProviderIcon id={p.id} size={14} />
                  <b>{p.name}</b>
                </span>
                <span className="faint mono truncate permission-flags" title={flags}>
                  {effective === 'cli'
                    ? 'its own settings'
                    : effective === 'auto' && perms.claudeAuto === false
                      ? 'no auto mode in this version: --permission-mode acceptEdits'
                      : flags}
                </span>
                <Dropdown
                  label={`Permission level for ${p.name}`}
                  value={own}
                  options={[
                    {
                      value: 'inherit' as const,
                      label: `Inherit (${PERMISSION_LEVEL_LABELS[perms.global]})`,
                      sub: 'Follows the level for all agents',
                    },
                    // Auto mode is Claude Code's own (PM-326), offered only for it.
                    ...(CLI_FLAGS[p.id]?.auto ? (['auto'] as const) : []).map((level) => ({
                      value: level,
                      label: PERMISSION_LEVEL_LABELS[level],
                      sub:
                        perms.claudeAuto === false
                          ? 'This Claude Code has no auto mode yet: it starts in accept edits until updated'
                          : `${CLI_FLAGS[p.id]?.[level]}: ${LEVEL_HINTS.auto}`,
                    })),
                    ...LEVELS.map((level) => ({
                      value: level,
                      label: PERMISSION_LEVEL_LABELS[level],
                      sub: level === 'cli' ? LEVEL_HINTS.cli : CLI_FLAGS[p.id]?.[level],
                    })),
                  ]}
                  onChange={(value: PermissionLevel | 'inherit') =>
                    save({ ...perms, providers: { ...perms.providers, [p.id]: value } })
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
