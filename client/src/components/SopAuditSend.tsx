import { useEffect, useId, useState } from 'react';
import type { SopAuditor } from '../../../shared/types';
import { api } from '../api';
import { sendMessageToSession } from '../sessionSend';
import { Dropdown } from './Dropdown';
import { sessionOption } from './sessionOption';

// Hands an SOP audit to an agent (PM-316): a project's own session, or the chat of an orchestrator
// whose scope includes the project. The message points the agent at its audit tool (sop_check or
// sop_report), so it acts on a fresh check rather than on what this page showed.

export function SopAuditSend({
  projectId,
  message,
  onCancel,
}: {
  /** The project to audit; null for a full audit, which only orchestrators are offered. */
  projectId: number | null;
  message: (auditor: SopAuditor) => string;
  onCancel: () => void;
}) {
  const [auditors, setAuditors] = useState<SopAuditor[] | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  useEffect(() => {
    api.sopAuditors(projectId).then(
      ({ sessions }) => {
        setAuditors(sessions);
        setTarget(sessions[0]?.id ?? null);
      },
      (e: Error) => setStatus(e.message),
    );
  }, [projectId]);

  const chosen = auditors?.find((a) => a.id === target) ?? null;
  const send = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const queued = await sendMessageToSession(chosen, message(chosen));
      setStatus(
        queued
          ? `Queued for ${chosen.name}; it is sent when the session is back.`
          : `Sent to ${chosen.name}.`,
      );
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sop-send">
      <label htmlFor={id} className="sop-send-label">
        {projectId === null ? 'Orchestrator' : 'Session'}
      </label>
      <div className="sop-send-row">
        <Dropdown
          id={id}
          label={projectId === null ? 'Orchestrator' : 'Session'}
          value={target ?? 0}
          disabled={!auditors?.length}
          options={
            auditors?.length
              ? auditors.map((a) =>
                  sessionOption(
                    a,
                    a.kind === 'orchestrator' ? `Orchestrator · ${a.scope}` : 'Project session',
                  ),
                )
              : [
                  {
                    value: 0,
                    label:
                      auditors === null
                        ? 'Loading…'
                        : projectId === null
                          ? 'No orchestrator chat is running'
                          : 'No running session or orchestrator covers this project',
                  },
                ]
          }
          onChange={(v) => setTarget(v || null)}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !chosen}
          onClick={() => void send()}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Close
        </button>
      </div>
      <p className="faint sop-send-note">
        {status ??
          'Typed after whatever is already in its input, then submitted. It runs the audit tool itself, so it works from a fresh check.'}
      </p>
    </div>
  );
}
