import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { sendMessageToSession } from '../sessionSend';

// Preview's element picker, the sending half (PM-311): what the picker reported about an element,
// shown for review, then sent as a message to a CLI session of the owner's choice.

/** An element as the page's picker reports it (untrusted: parsed and capped by `parsePicked`). */
export interface PickedElement {
  url: string;
  title: string;
  tag: string;
  selector: string;
  html: string;
  text: string;
  role: string | null;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  styles: Record<string, string>;
  react: { component: string; props: Record<string, unknown>; owners: string[] } | null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

/** The picker's message, kept to known fields of bounded size; null if it isn't one. */
export function parsePicked(data: unknown): PickedElement | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const tag = str(d.tag, 40);
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const rect = (d.rect ?? {}) as Record<string, unknown>;
  const viewport = (d.viewport ?? {}) as Record<string, unknown>;
  const styles: Record<string, string> = {};
  if (d.styles && typeof d.styles === 'object')
    for (const [k, v] of Object.entries(d.styles).slice(0, 30))
      if (/^[a-z-]{1,40}$/.test(k) && typeof v === 'string' && v) styles[k] = v.slice(0, 120);
  let react: PickedElement['react'] = null;
  if (d.react && typeof d.react === 'object') {
    const r = d.react as Record<string, unknown>;
    const component = str(r.component, 80);
    if (component) {
      let props: Record<string, unknown> = {};
      try {
        const json = JSON.stringify(r.props ?? {});
        props = json.length <= 2000 ? (JSON.parse(json) as Record<string, unknown>) : {};
      } catch {
        props = {};
      }
      const owners = Array.isArray(r.owners)
        ? r.owners.filter((o): o is string => typeof o === 'string').map((o) => o.slice(0, 80))
        : [];
      react = { component, props, owners: owners.slice(0, 4) };
    }
  }
  return {
    url: str(d.url, 500),
    title: str(d.title, 200),
    tag,
    selector: str(d.selector, 400),
    html: str(d.html, 2100),
    text: str(d.text, 320),
    role: typeof d.role === 'string' ? d.role.slice(0, 40) : null,
    name: str(d.name, 170),
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    viewport: { width: num(viewport.width), height: num(viewport.height) },
    styles,
    react,
  };
}

const KEY_STYLES = [
  'display',
  'width',
  'height',
  'padding',
  'margin',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'border-radius',
];

/**
 * The app's own address for a page seen through the preview proxy (p3000.localhost:5180/x or
 * /api/preview/3000/x become localhost:3000/x): the CLI knows the app, not the proxy.
 */
export function appUrl(url: string): string {
  const own = /^https?:\/\/p(\d{4,5})\.localhost(?::\d+)?(\/.*)?$/i.exec(url);
  if (own) return `http://localhost:${own[1]}${own[2] ?? '/'}`;
  const path = /^https?:\/\/[^/]+\/api\/preview\/(\d{4,5})(\/.*)?$/i.exec(url);
  if (path) return `http://localhost:${path[1]}${path[2] ?? '/'}`;
  return url;
}

/** The context block the CLI gets: enough to find the element in the code and see what it is. */
export function pickedContext(el: PickedElement): string {
  const lines = [`Page: ${el.title ? `${el.title} — ` : ''}${appUrl(el.url)}`];
  lines.push(`Element: <${el.tag}> ${el.selector}`);
  if (el.react) {
    const owners = el.react.owners.length ? ` (inside ${el.react.owners.join(' › ')})` : '';
    lines.push(`React component: ${el.react.component}${owners}`);
    if (Object.keys(el.react.props).length) lines.push(`Props: ${JSON.stringify(el.react.props)}`);
  }
  if (el.role || el.name)
    lines.push(`Accessibility: ${el.role ?? 'no role'}${el.name ? `, "${el.name}"` : ''}`);
  if (el.text) lines.push(`Text: "${el.text}"`);
  lines.push(
    `Box: ${el.rect.width}×${el.rect.height} at ${el.rect.x},${el.rect.y} in a ${el.viewport.width}×${el.viewport.height} viewport`,
  );
  const styles = KEY_STYLES.filter((k) => el.styles[k]).map((k) => `${k}: ${el.styles[k]}`);
  if (styles.length) lines.push(`Styles: ${styles.join('; ')}`);
  lines.push('HTML:', el.html);
  return lines.join('\n');
}

/** Live sessions, the app's project first, then the most recently messaged. */
export function rankSessions(sessions: AgentSession[], projectId: number | null): AgentSession[] {
  return sessions
    .filter((s) => s.status === 'running' && !s.orchestratorId)
    .sort(
      (a, b) =>
        Number(b.projectId === projectId) - Number(a.projectId === projectId) ||
        (b.lastInputAt ?? '').localeCompare(a.lastInputAt ?? ''),
    );
}

export function PreviewPickDialog({
  element,
  projectId,
  projectNames,
  onClose,
}: {
  element: PickedElement;
  /** The project the previewed app belongs to, if known: its sessions come first. */
  projectId: number | null;
  projectNames: ReadonlyMap<number, string>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [request, setRequest] = useState('');
  const [context, setContext] = useState(() => pickedContext(element));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    api.listAllSessions().then(
      (all) => {
        if (!live) return;
        const ranked = rankSessions(all, projectId);
        setSessions(ranked);
        setTarget((t) => t ?? ranked[0]?.id ?? null);
      },
      () => live && setSessions([]),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const chosen = useMemo(() => sessions?.find((s) => s.id === target) ?? null, [sessions, target]);

  async function send() {
    if (!chosen) return;
    setBusy(true);
    setStatus(null);
    try {
      const text = [request.trim(), '', 'About this element in the Preview:', context.trim()]
        .filter((line, i) => i > 0 || line)
        .join('\n');
      const queued = await sendMessageToSession(chosen, text);
      setStatus(
        queued
          ? `Queued for ${chosen.name}: it is down and gets it on relaunch.`
          : `Sent to ${chosen.name}.`,
      );
      setTimeout(onClose, 1200);
    } catch (e) {
      setStatus(`Could not send: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog preview-pick-dialog"
      aria-labelledby={heading}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="dialog-body">
          <h2 id={heading}>
            Send <code>{`<${element.tag}>`}</code>
            {element.react ? ` (${element.react.component})` : ''} to a session
          </h2>
          <p className="faint preview-pick-where">{element.selector}</p>
          <label>
            What should change?
            <textarea
              className="textarea preview-pick-request"
              value={request}
              rows={3}
              maxLength={4000}
              placeholder="e.g. Make this heading smaller on phones"
              onChange={(e) => setRequest(e.target.value)}
              autoFocus
            />
          </label>
          <details>
            <summary>Context sent with it (editable)</summary>
            <textarea
              className="textarea preview-pick-context"
              value={context}
              rows={8}
              maxLength={8000}
              onChange={(e) => setContext(e.target.value)}
            />
          </details>
          <label>
            Send to
            <select
              className="input"
              value={target ?? ''}
              disabled={!sessions?.length}
              onChange={(e) => setTarget(Number(e.target.value) || null)}
            >
              {sessions === null && <option value="">Loading sessions…</option>}
              {sessions?.length === 0 && <option value="">No running sessions</option>}
              {sessions?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {projectNames.get(s.projectId) ?? 'All projects'}
                  {s.projectId === projectId ? ' · this app' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="faint">
            Typed into that session after whatever is already in its input, then submitted.
          </p>
          {status && <p role="status">{status}</p>}
        </div>
        <div className="dialog-footer">
          <span />
          <div className="actions">
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !chosen}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
