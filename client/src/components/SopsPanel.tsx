import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { SopAuditor, SopInfo, SopReport, SopResult } from '../../../shared/types';
import { api } from '../api';
import { SopAuditSend } from './SopAuditSend';
import { SopsEditor } from './SopsEditor';

// Settings > SOPs (PM-316): our shared standard, what each SOP asks and why, and a grid of which
// projects follow it. Checks are read-only; a gap becomes a card for an agent, or a waiver (a
// recorded, deliberate exception) when the project has a reason not to follow it.

const STATE_LABEL: Record<SopResult['state'], string> = {
  pass: 'Meets it',
  fail: 'Gap',
  na: 'Does not apply',
  waived: 'Waived',
};

function StateIcon({ state }: { state: SopResult['state'] }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (state === 'pass')
    return (
      <svg {...common}>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  if (state === 'fail')
    return (
      <svg {...common}>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
  if (state === 'waived')
    return (
      <svg {...common} strokeWidth={2}>
        <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
      </svg>
    );
  return (
    <svg {...common} strokeWidth={2}>
      <path d="M8 12h8" />
    </svg>
  );
}

export function SopsPanel({ onError }: { onError: (message: string | null) => void }) {
  const [report, setReport] = useState<SopReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [selected, setSelected] = useState<{ projectId: number; sopId: string } | null>(null);
  const [reason, setReason] = useState('');
  const [waiving, setWaiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [auditAll, setAuditAll] = useState(false);
  const [sending, setSending] = useState(false);

  const fetchReport = useCallback(
    () => api.sops().then(setReport, (e: Error) => onError(e.message)),
    [onError],
  );
  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);
  const load = () => {
    setChecking(true);
    void fetchReport().finally(() => setChecking(false));
  };

  const counts = useMemo(() => {
    const out = new Map<string, { meets: number; applies: number }>();
    for (const sop of report?.sops ?? []) {
      let meets = 0;
      let applies = 0;
      for (const p of report!.projects) {
        const s = p.results[sop.id]?.state;
        if (s === 'na') continue;
        applies++;
        if (s === 'pass' || s === 'waived') meets++;
      }
      out.set(sop.id, { meets, applies });
    }
    return out;
  }, [report]);

  if (!report)
    return (
      <section className="panel" aria-label="SOPs" aria-busy="true">
        <div className="skeleton" style={{ height: 220 }} />
      </section>
    );

  const gapsOf = (p: SopReport['projects'][number]) =>
    Object.values(p.results).filter((r) => r.state === 'fail').length;
  const clean = report.projects.filter((p) => gapsOf(p) === 0).length;
  const rows = onlyGaps ? report.projects.filter((p) => gapsOf(p) > 0) : report.projects;
  const project = selected ? report.projects.find((p) => p.id === selected.projectId) : undefined;
  const sop = selected ? report.sops.find((s) => s.id === selected.sopId) : undefined;
  const result = project && sop ? project.results[sop.id] : undefined;

  const select = (projectId: number, sopId: string) => {
    const same = selected?.projectId === projectId && selected.sopId === sopId;
    setSelected(same ? null : { projectId, sopId });
    setWaiving(false);
    setSending(false);
    setReason('');
    setNote(null);
  };
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    onError(null);
    try {
      setNote(await run());
      setWaiving(false);
      load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing)
    return (
      <SopsEditor
        onDone={(saved) => {
          setEditing(false);
          setSelected(null);
          if (saved) load();
        }}
      />
    );

  return (
    <>
      <section className="panel" aria-label="SOPs">
        <div className="panel-header">
          <h2>SOPs</h2>
          <span className="meta">
            {clean} of {report.projects.length} projects meet every SOP
            {report.custom ? ' · your edited set' : ''}
          </span>
          <div className="sop-head-actions">
            <button type="button" className="btn btn-sm" onClick={() => setAuditAll((v) => !v)}>
              Audit with…
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              Edit SOPs
            </button>
            <button type="button" className="btn btn-sm" disabled={checking} onClick={load}>
              {checking ? 'Checking…' : 'Check again'}
            </button>
          </div>
        </div>
        {report.fileError && (
          <div className="error-banner" role="alert">
            Your SOP file has a problem, so the defaults are in use. {report.fileError}
          </div>
        )}
        {report.orphanedWaivers.length > 0 && (
          <p className="faint sop-intro">
            {report.orphanedWaivers.length} waiver
            {report.orphanedWaivers.length === 1 ? ' belongs' : 's belong'} to an SOP that is no
            longer in the file (
            {[...new Set(report.orphanedWaivers.map((w) => w.sopId))].join(', ')}
            ). They are kept, and apply again if the SOP comes back under the same id.
          </p>
        )}
        {auditAll && (
          <SopAuditSend
            projectId={null}
            message={() => FULL_AUDIT}
            onCancel={() => setAuditAll(false)}
          />
        )}
        <p className="faint sop-intro">
          The standard every project&apos;s agent instructions carry, most important first. Checks
          only read the project folders; a gap becomes a card for an agent to fix.
        </p>
        <ol className="sop-list">
          {report.sops.map((s, i) => {
            const c = counts.get(s.id) ?? { meets: 0, applies: 0 };
            return (
              <li key={s.id}>
                <details className="sop">
                  <summary>
                    <span className="sop-num">{i + 1}</span>
                    <span className="sop-title">
                      <strong>{s.title}</strong>
                      <span className="faint">{s.summary}</span>
                    </span>
                    <span
                      className={`sop-count${c.meets === c.applies ? ' is-complete' : ''}`}
                      title={`${c.meets} of ${c.applies} projects it applies to`}
                    >
                      {c.meets}/{c.applies}
                    </span>
                  </summary>
                  <dl className="sop-body">
                    <dt>Why</dt>
                    <dd>{s.why}</dd>
                    <dt>How it is checked</dt>
                    <dd>{s.how}</dd>
                    <dt>How to fix a gap</dt>
                    <dd>{s.fix}</dd>
                  </dl>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="panel" aria-label="Adherence">
        <div className="panel-header">
          <h2>Adherence</h2>
          <label className="sop-filter">
            <input
              type="checkbox"
              checked={onlyGaps}
              onChange={(e) => setOnlyGaps(e.target.checked)}
            />
            Only projects with gaps
          </label>
        </div>
        <div className="sop-grid-wrap">
          <table className="sop-grid">
            <thead>
              <tr>
                <th scope="col">Project</th>
                {report.sops.map((s) => (
                  <th key={s.id} scope="col" title={s.title}>
                    {s.short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  </th>
                  {report.sops.map((s) => {
                    const r = p.results[s.id]!;
                    const on = selected?.projectId === p.id && selected.sopId === s.id;
                    return (
                      <td key={s.id}>
                        <button
                          type="button"
                          className={`sop-cell is-${r.state}`}
                          aria-pressed={on}
                          aria-label={`${p.name}, ${s.title}: ${STATE_LABEL[r.state]}. ${r.detail}`}
                          title={r.detail}
                          onClick={() => select(p.id, s.id)}
                        >
                          <StateIcon state={r.state} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={report.sops.length + 1} className="faint sop-empty">
                    Every project meets every SOP that applies to it.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="faint sop-legend">
          <span className="sop-cell is-pass" aria-hidden="true">
            <StateIcon state="pass" />
          </span>
          meets it
          <span className="sop-cell is-fail" aria-hidden="true">
            <StateIcon state="fail" />
          </span>
          gap
          <span className="sop-cell is-waived" aria-hidden="true">
            <StateIcon state="waived" />
          </span>
          waived: a recorded exception
          <span className="sop-cell is-na" aria-hidden="true">
            <StateIcon state="na" />
          </span>
          does not apply
        </p>

        {project && sop && result && (
          <div className="sop-detail" role="region" aria-label={`${sop.title} in ${project.name}`}>
            <div className="sop-detail-head">
              <strong>
                {sop.title} · {project.name}
              </strong>
              <span className={`sop-state is-${result.state}`}>{STATE_LABEL[result.state]}</span>
            </div>
            <p>{result.detail}</p>
            {result.waiver && (
              <p className="faint">
                Waived {new Date(result.waiver.createdAt).toLocaleDateString()}:{' '}
                {result.waiver.reason}
              </p>
            )}
            {result.state === 'fail' && !waiving && (
              <div className="sop-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const card = await api.sopCard(project.id, sop.id);
                      return `Created ${card.key} on ${project.name}'s board.`;
                    })
                  }
                >
                  Create card
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => setSending((v) => !v)}
                >
                  Send to session…
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => setWaiving(true)}
                >
                  Waive…
                </button>
              </div>
            )}
            {result.state === 'fail' && sending && !waiving && (
              <SopAuditSend
                projectId={project.id}
                message={(a) => gapMessage(a, project, sop, result.detail)}
                onCancel={() => setSending(false)}
              />
            )}
            {waiving && (
              <form
                className="sop-actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!reason.trim()) return;
                  void act(async () => {
                    await api.waiveSop(project.id, sop.id, reason.trim());
                    return 'Waived. It stays visible in the grid with your reason.';
                  });
                }}
              >
                <input
                  className="input sop-reason"
                  value={reason}
                  maxLength={500}
                  autoFocus
                  placeholder="Why this project does not follow it"
                  aria-label="Reason for the waiver"
                  onChange={(e) => setReason(e.target.value)}
                />
                <button className="btn btn-primary btn-sm" disabled={busy || !reason.trim()}>
                  Save waiver
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setWaiving(false)}>
                  Cancel
                </button>
              </form>
            )}
            {result.waiver && (
              <div className="sop-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.unwaiveSop(project.id, sop.id);
                      return 'Waiver removed.';
                    })
                  }
                >
                  Remove waiver
                </button>
              </div>
            )}
            {note && (
              <p role="status" className="sop-note">
                {note}
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/** A full audit, for an orchestrator's chat: its own scope, through its audit tools. */
const FULL_AUDIT =
  'Run an SOP audit of your projects: call the projectmanager tool sop_report. For each gap, fix it directly where that is authorized work, or create a card for it with sop_card. Waivers are my decision: do not treat a gap as acceptable yourself, but list any you think deserves one, with the reason. Finish with a short summary: what you fixed, the cards you made, and what needs me.';

/** One gap in one project, worded for who will act on it. */
function gapMessage(
  auditor: SopAuditor,
  project: { id: number; name: string },
  sop: SopInfo,
  found: string,
): string {
  const check =
    auditor.kind === 'orchestrator'
      ? `call the projectmanager tool sop_report with projectId ${project.id}`
      : 'call the projectmanager tool sop_check';
  return [
    `Bring ${project.name} up to our "${sop.title}" SOP. First ${check} to see the current result.`,
    `Found: ${found}`,
    `What it asks: ${sop.summary}`,
    `How to fix: ${sop.fix}`,
    "Follow the project's AGENTS.md, commit with a card reference, then run the check again to confirm it passes. Waivers are my decision; if you think this one deserves one, say why instead of skipping it.",
  ].join('\n');
}
