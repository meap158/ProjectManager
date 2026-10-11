import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { TerminalInputQueue } from '../lib/terminalInputQueue';
import { sendImageToSession } from '../sessionImages';
import { SessionImageButton } from './SessionImageButton';
import { SessionToggle } from './SessionToggle';
import { SessionRestartStatus } from './SessionProgress';
const TerminalView = lazy(() =>
  import('./TerminalView').then((m) => ({ default: m.TerminalView })),
);

export function OrchestratorTerminal({
  session,
  onChanged,
}: {
  session: AgentSession;
  onChanged: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function change(action: () => Promise<AgentSession>) {
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pasteRef = useRef<((text: string) => void) | null>(null);
  const queue = useMemo(
    () =>
      new TerminalInputQueue(
        async (text) => {
          await api.sendSessionInput(session.id, text);
        },
        (e) => setError(e.message),
      ),
    [session.id],
  );
  return (
    <section aria-label={`${session.name} terminal`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="faint">{busy ? 'Updating session...' : session.status}</span>
        <SessionRestartStatus session={session} />
        <fieldset
          disabled={busy}
          style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 6 }}
        >
          <SessionToggle
            session={session}
            onStart={() => void change(() => api.startSession(session.id))}
            onStop={() => void change(() => api.stopSession(session.id))}
            onRestart={() => change(() => api.restartSession(session.id))}
          />
        </fieldset>
        <SessionImageButton
          sessionId={session.id}
          pasteRef={pasteRef}
          onError={setError}
          className="icon-btn"
        />
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <Suspense fallback={<div className="terminal skeleton" style={{ height: 360 }} />}>
        <TerminalView
          key={`${session.id}-${session.startedAt}`}
          height={360}
          historyBytes={session.logBytes}
          stopped={session.status !== 'running'}
          fetchOutput={(after) => api.sessionOutput(session.id, after)}
          streamUrl={(after) => api.sessionStreamUrl(session.id, after)}
          onInput={(text) => queue.push(text)}
          pasteRef={pasteRef}
          onImage={(file) =>
            sendImageToSession(session.id, file, pasteRef.current).catch((e: Error) =>
              setError(e.message),
            )
          }
          onResize={(cols, rows) => {
            void api.resizeSession(session.id, cols, rows).catch(() => undefined);
          }}
        />
      </Suspense>
    </section>
  );
}
