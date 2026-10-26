import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { sendMessageToSession } from '../sessionSend';
import { AnnotatedShot } from './AnnotatedShot';
import { scaleShapes, type Shape } from './Markup';
import { Dropdown } from './Dropdown';
import { sessionOption } from './sessionOption';

// Preview's element picker, the sending half (PM-311): what the picker reported about an element,
// shown for review, then sent as a message to a CLI session of the owner's choice.

/** The page as its picker reports it: where it is, its size and how far it was scrolled. */
export interface PickedPage {
  url: string;
  title: string;
  viewport: { width: number; height: number; dark: boolean };
  scroll: { x: number; y: number; inner: { selector: string; top: number; left: number } | null };
}

/** An element as the page's picker reports it (untrusted: parsed and capped by `parsePicked`). */
export interface PickedElement extends PickedPage {
  tag: string;
  selector: string;
  html: string;
  text: string;
  role: string | null;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
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
  const scroll = (d.scroll ?? {}) as Record<string, unknown>;
  const inner = (scroll.inner ?? null) as Record<string, unknown> | null;
  const styles: Record<string, string> = {};
  if (d.styles && typeof d.styles === 'object')
    for (const [k, v] of Object.entries(d.styles).slice(0, 30))
      if (/^[a-z-]{1,40}$/.test(k) && typeof v === 'string' && v) styles[k] = v.slice(0, 120);
  let react: PickedElement['react'] = null;
  if (d.react && typeof d.react === 'object') {
    const r = d.react as Record<string, unknown>;
    const component = str(r.component, 80);
    if (component) {
      let props: Record<string, unknown>;
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
    viewport: {
      width: num(viewport.width),
      height: num(viewport.height),
      dark: viewport.dark === true,
    },
    scroll: {
      x: num(scroll.x),
      y: num(scroll.y),
      inner:
        inner && typeof inner.selector === 'string'
          ? { selector: inner.selector.slice(0, 400), top: num(inner.top), left: num(inner.left) }
          : null,
    },
    styles,
    react,
  };
}

/** The page fields of a picker message (also sent alone, for marks without an element). */
export function parsePage(data: unknown): PickedPage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const viewport = (d.viewport ?? {}) as Record<string, unknown>;
  const scroll = (d.scroll ?? {}) as Record<string, unknown>;
  const inner = (scroll.inner ?? null) as Record<string, unknown> | null;
  if (typeof d.url !== 'string') return null;
  return {
    url: str(d.url, 500),
    title: str(d.title, 200),
    viewport: {
      width: num(viewport.width),
      height: num(viewport.height),
      dark: viewport.dark === true,
    },
    scroll: {
      x: num(scroll.x),
      y: num(scroll.y),
      inner:
        inner && typeof inner.selector === 'string'
          ? { selector: inner.selector.slice(0, 400), top: num(inner.top), left: num(inner.left) }
          : null,
    },
  };
}

/** What the CLI gets when only marks were made: the page, and that the picture shows the marks. */
export function pageContext(page: PickedPage, marks: number): string {
  return [
    `Page: ${page.title ? `${page.title} · ` : ''}${appUrl(page.url)}`,
    `Viewport: ${page.viewport.width}×${page.viewport.height}, scrolled to ${page.scroll.x},${page.scroll.y}`,
    marks ? `The screenshot shows my ${marks === 1 ? 'mark' : `${marks} marks`} on the page.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The size the capture renders at (it clamps the viewport), so marks scale into its pixels. */
export function captureSize(page: PickedPage): { width: number; height: number } {
  return {
    width: Math.min(2560, Math.max(320, page.viewport.width || 320)),
    height: Math.min(2560, Math.max(240, page.viewport.height || 240)),
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
  const lines = [`Page: ${el.title ? `${el.title} · ` : ''}${appUrl(el.url)}`];
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
  page,
  element,
  marks,
  projectId,
  projectNames,
  onClose,
}: {
  /** The page as it was when the owner pressed Add to chat (its scroll is what the capture uses). */
  page: PickedPage;
  /** The picked element, if any: marks alone are fine too. */
  element: PickedElement | null;
  /** Marks drawn on the live page, in its CSS pixels. */
  marks: Shape[];
  /** The project the previewed app belongs to, if known: its sessions come first. */
  projectId: number | null;
  projectNames: ReadonlyMap<number, string>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const requestId = useId();
  const targetId = useId();
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [request, setRequest] = useState('');
  const [context, setContext] = useState(() =>
    element
      ? pickedContext(element) +
        (marks.length
          ? `\nThe screenshot also shows my ${marks.length === 1 ? 'mark' : `${marks.length} marks`}.`
          : '')
      : pageContext(page, marks.length),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The screenshot, retaken by the server at the page's size and scroll (PM-311).
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [includeShot, setIncludeShot] = useState(true);
  // Where the capture found the element (CSS pixels of the captured page); null: not found.
  const [found, setFound] = useState<PickedElement['rect'] | null>(null);
  const exportShot = useRef<(() => string) | null>(null);
  const size = captureSize(page);
  const where = useMemo(
    () => /^https?:\/\/localhost:(\d+)(\/.*)?$/.exec(appUrl(page.url)),
    [page.url],
  );
  useEffect(() => {
    if (!where) return;
    let url: string | null = null;
    let live = true;
    fetch('/api/preview-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: Number(where[1]),
        path: where[2] ?? '/',
        width: page.viewport.width,
        height: page.viewport.height,
        scrollX: page.scroll.x,
        scrollY: page.scroll.y,
        inner: page.scroll.inner,
        dark: page.viewport.dark,
        selector: element?.selector ?? null,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Screenshot failed (${res.status})`);
        }
        const measured = res.headers.get('x-pm-element');
        if (measured && live) {
          try {
            const r = JSON.parse(measured) as PickedElement['rect'];
            setFound({ x: r.x, y: r.y, width: r.width, height: r.height });
          } catch {
            /* no box: the element is named in the text all the same */
          }
        }
        return res.blob();
      })
      .then(
        (blob) => {
          if (!live) return;
          url = URL.createObjectURL(blob);
          setShot(url);
        },
        (e: Error) => live && setShotError(e.message),
      );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [page, element, where]);

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
      const about = element
        ? 'About this element in the Preview:'
        : 'About this page in the Preview:';
      const text = [request.trim(), '', about, context.trim()]
        .filter((line, i) => i > 0 || line)
        .join('\n');
      const images: string[] = [];
      const data = includeShot && shot ? exportShot.current?.() : '';
      if (data) {
        const { path } = await api.uploadSessionImage(chosen.id, {
          name: `preview-${element?.tag ?? 'page'}.png`,
          type: 'image/png',
          data,
        });
        images.push(path);
      }
      const queued = await sendMessageToSession(chosen, text, images);
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
          <header className="pick-head">
            <h2 id={heading}>Send to a session</h2>
            {element ? (
              <p className="pick-element" title={element.selector}>
                <code>{`<${element.tag}>`}</code>
                {element.react && <span className="pick-component">{element.react.component}</span>}
                <span className="pick-selector">{element.selector}</span>
              </p>
            ) : (
              <p className="pick-element">
                <span className="pick-selector">
                  {appUrl(page.url)} · {marks.length} {marks.length === 1 ? 'mark' : 'marks'}
                </span>
              </p>
            )}
          </header>

          <div className="field">
            <label htmlFor={requestId}>What should change?</label>
            <textarea
              id={requestId}
              className="textarea pick-request"
              value={request}
              rows={2}
              maxLength={4000}
              placeholder="e.g. Make this heading smaller on phones"
              onChange={(e) => setRequest(e.target.value)}
              autoFocus
            />
          </div>

          <section className="pick-shot" aria-label="Screenshot">
            <div className="pick-shot-head">
              <label className={`pick-check${includeShot && shot ? ' is-checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={includeShot}
                  disabled={!shot}
                  onChange={(e) => setIncludeShot(e.target.checked)}
                />
                <span className="pick-check-box" aria-hidden="true">
                  <svg width="10" height="10" viewBox="0 0 12 12">
                    <path
                      d="M2.5 6.2l2.4 2.3 4.6-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span>Screenshot</span>
              </label>
              <span className="faint">
                {!where
                  ? 'Not available for this address'
                  : (shotError ?? (shot ? 'Retaken by ProjectManager' : 'Taking it…'))}
              </span>
            </div>
            {includeShot && where && (
              <div
                className="pick-shot-frame"
                style={{ '--ratio': size.width / size.height } as CSSProperties}
              >
                {shot ? (
                  <AnnotatedShot
                    src={shot}
                    exportRef={exportShot}
                    initial={[
                      ...(found
                        ? [
                            {
                              kind: 'box' as const,
                              color: '#4c8dff',
                              from: { x: found.x - 3, y: found.y - 3 },
                              to: { x: found.x + found.width + 3, y: found.y + found.height + 3 },
                            },
                          ]
                        : []),
                      ...scaleShapes(marks, size.width / (page.viewport.width || size.width)),
                    ]}
                  />
                ) : shotError ? (
                  <p className="pick-shot-error">{shotError}</p>
                ) : (
                  <div className="skeleton pick-shot-skeleton" />
                )}
              </div>
            )}
          </section>

          <div className="field">
            <label htmlFor={targetId}>Session</label>
            <Dropdown
              id={targetId}
              label="Session"
              value={target ?? 0}
              disabled={!sessions?.length}
              options={
                sessions?.length
                  ? sessions.map((s) =>
                      sessionOption(
                        s,
                        projectNames.get(s.projectId) ?? 'All projects',
                        s.projectId === projectId ? 'this app' : undefined,
                      ),
                    )
                  : [
                      {
                        value: 0,
                        label: sessions === null ? 'Loading sessions…' : 'No running sessions',
                      },
                    ]
              }
              onChange={(id) => setTarget(id || null)}
            />
            <span className="faint pick-note">
              Typed after whatever is already in its input, then submitted.
            </span>
          </div>

          <details className="pick-context">
            <summary>Context sent with it</summary>
            <textarea
              className="textarea"
              aria-label="Context sent with it"
              value={context}
              rows={8}
              maxLength={8000}
              onChange={(e) => setContext(e.target.value)}
            />
          </details>
          {status && (
            <p role="status" className="pick-status">
              {status}
            </p>
          )}
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
